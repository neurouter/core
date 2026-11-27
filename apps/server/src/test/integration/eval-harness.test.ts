import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import type { EvalTask } from '@neurouter/evals';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootServer } from '../fakes/server.js';
import type { RunningServer } from '../../server.js';

const task = (p: Partial<EvalTask> & Pick<EvalTask, 'key'>): EvalTask => ({ category: 'single', prompt: '', rubric: '', assertions: [], referenceCalls: [], tags: [], enabled: true, ...p });

/**
 * 0.2.2 eval harness through the real server (stub LLM): the calibration gate rejects and disables a
 * task whose own reference fails; `called` checks sensitive arguments in the clear while the audit log
 * keeps them redacted; `--max-run-tokens` stops a run and marks it incomplete.
 */
describe('eval harness (calibration, redaction, run cap)', () => {
  let s: RunningServer;
  beforeAll(async () => {
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    s = await bootServer({ NEUROUTER_EVAL_LLM: 'stub' });
  }, 60_000);
  afterAll(async () => {
    delete process.env.NEUROUTER_EVAL_LLM;
    await s?.close();
  });

  it('calibrates, runs only accepted tasks, and checks redacted arguments unredacted', async () => {
    const ev = s.services.evals;
    const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'petstore'))!;
    const env = (await s.services.servers.environments(srv.id)).find((e) => e.slug === 'dev')!;
    const login = task({
      key: 'login',
      prompt: 'Log the user in (use username="user1", password="hunter2")',
      referenceCalls: [{ tool: 'login_user', arguments: { username: 'user1', password: 'hunter2' }, required: ['username', 'password'] }],
      assertions: [{ type: 'called', tool: 'login_user', args: { username: 'user1', password: 'hunter2' } }, { type: 'max_calls', n: 3 }],
    });
    const wrong = task({
      key: 'wrong',
      prompt: 'Find pet 1 (use pet_id=1) and tell me its name',
      referenceCalls: [{ tool: 'get_pet_by_id', arguments: { pet_id: 1 } }],
      assertions: [{ type: 'called', tool: 'get_pet_by_id' }, { type: 'answer_contains', anyOf: ['Definitely-Not-A-Pet-Name'] }],
    });
    const suite = await ev.saveSuite(DEFAULT_TENANT_ID, srv.id, null, [login, wrong], { mockDataVersion: 2 }, null, true);
    const cal = await ev.calibrateSuite(DEFAULT_TENANT_ID, srv.id, suite.id, { disableRejected: true, environmentId: env.id });
    expect(cal).toMatchObject({ passed: 1, rejected: 1, mockDataVersion: 2 });
    expect(cal.tasks.find((t) => t.key === 'wrong')!.reasons.join(' ')).toContain('not in the reference outcome');
    expect(ev.suiteMeta(await ev.suiteOf(DEFAULT_TENANT_ID, srv.id, suite.id)).calibration?.rejected).toBe(1);
    // --calibrate-with: one tool-mode model pass over the accepted tasks; disagreements are flagged, never dropped
    const withModel = await ev.calibrateSuite(DEFAULT_TENANT_ID, srv.id, suite.id, { environmentId: env.id, calibrateWith: 'stub' });
    expect(withModel).toMatchObject({ model: 'stub', rejected: 1 });
    expect(withModel.passed + withModel.flagged).toBe(1);

    const run = await ev.createRun(DEFAULT_TENANT_ID, { serverId: srv.id, suiteId: suite.id, environmentId: env.id, modes: ['tool'], repeats: 1, trigger: 'cli', createdBy: null, wait: true });
    expect(run.status).toBe('succeeded');
    const results = await ev.taskResults(DEFAULT_TENANT_ID, run.id);
    expect(results.map((r) => r.taskKey)).toEqual(['login']);
    const r = results[0]!;
    expect(r.assertionResults[0]).toMatchObject({ passed: true });
    expect(r.calls.find((c) => c.tool === 'login_user')!.arguments).toMatchObject({ password: 'hunter2' });
    expect(r).toMatchObject({ upstreamCalls: 1, callBudget: 3, overBudget: false });
    // the audit log stays redacted
    await s.services.auditStore.flush();
    const audit = await s.services.dbs.audit.db.selectFrom('audit_log').select(['params_redacted']).where('tool_name', '=', 'login_user').execute();
    expect(audit.length).toBeGreaterThan(0);
    for (const a of audit) expect(a.params_redacted).not.toContain('hunter2');
  }, 120_000);

  it('B7: ground truth uses full objects, not the overlay include; a stored $from path into a dropped field resolves', async () => {
    // P6 (GitHub, 0.3.0): repos/list-for-user's include has no `owner`; the 0.2.2 migrator bound issues_get_label.owner to
    // {"$from": "ref[0].data[0].owner.login"}, which resolved to nothing through shaping: 3 valid tasks rejected
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const spec = readFileSync(resolve(import.meta.dirname, '../../../../../examples/petstore/openapi.yaml'));
    const overlay = 'overlay: 1\ntools:\n  "operationId:findPetsByStatus":\n    response:\n      include: ["[].id", "[].name"]\n';
    const created = await s.services.servers.create({ tenantId: DEFAULT_TENANT_ID, slug: 'pets-b7', name: 'pets', spec: { bytes: spec, sourceUrl: null }, specSource: { path: 'petstore' }, createdBy: null, overlay: { yaml: overlay, source: 'file', message: 'b7' }, exposure: { contract: 2 } });
    expect(created.build.build.status).toBe('ok');
    const ev = s.services.evals;
    const srvId = created.server.id;
    const env = (await s.services.servers.environments(srvId)).find((e) => e.slug === 'mock')!;
    const byTag = task({
      key: 'tagged',
      category: 'multi',
      prompt: 'List available pets, then find pets with the first pet\'s first tag',
      referenceCalls: [
        { tool: 'find_pets_by_status', arguments: { status: 'available' }, required: ['status'] },
        { tool: 'find_pets_by_tags', arguments: { tags: [{ $from: 'ref[0].data[0].tags[0].name' }] }, required: ['tags'] },
      ],
      assertions: [{ type: 'called', tool: 'find_pets_by_status', args: { status: 'available' } }, { type: 'called', tool: 'find_pets_by_tags', args: { tags: [{ $from: 'ref[0].data[0].tags[0].name' }] } }],
    });
    const suite = await ev.saveSuite(DEFAULT_TENANT_ID, srvId, null, [byTag], { mockDataVersion: 2 }, null, true);
    const cal = await ev.calibrateSuite(DEFAULT_TENANT_ID, srvId, suite.id, { environmentId: env.id });
    expect(cal.tasks[0], JSON.stringify(cal.tasks[0])).toMatchObject({ status: 'passed' });
    const runner = await ev.referenceRunner(DEFAULT_TENANT_ID, srvId, 2, env.id);
    try {
      const gt = await runner.groundTruth(runner.resolve([byTag])[0]!);
      const first = (gt.refs[0]!.data as Array<Record<string, unknown>>)[0]!;
      expect(Object.keys(first)).toContain('tags');
      expect(gt.refs[1]).toMatchObject({ ok: true });
      // an unresolvable $from path is reported, not sent as a missing argument
      const broken = await runner.groundTruth({ ...byTag, referenceCalls: [byTag.referenceCalls[0]!, { tool: 'find_pets_by_tags', arguments: { tags: [{ $from: 'ref[0].data[0].nope.name' }] } }] });
      expect(broken.refs[1]).toMatchObject({ ok: false });
      expect(broken.refs[1]!.error).toMatch(/\$from ref\[0\]\.data\[0\]\.nope\.name does not resolve/);
    } finally {
      await runner.close();
    }
    // the agent still gets the overlay's default projection
    const tools = (await s.services.builds.tools(created.build.build.id)).find((t) => t.name === 'find_pets_by_status')!;
    expect(tools.shaping?.include).toEqual(['[].id', '[].name']);
  }, 120_000);

  it('--max-run-tokens stops starting attempts and marks the run incomplete', async () => {
    const ev = s.services.evals;
    const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'petstore'))!;
    const env = (await s.services.servers.environments(srv.id)).find((e) => e.slug === 'dev')!;
    const t = task({ key: 'pet', prompt: 'Find pet 1 (use pet_id=1)', referenceCalls: [{ tool: 'get_pet_by_id', arguments: { pet_id: 1 } }], assertions: [{ type: 'called', tool: 'get_pet_by_id' }] });
    const suite = await ev.saveSuite(DEFAULT_TENANT_ID, srv.id, null, [t], { mockDataVersion: 2 }, null, true);
    const run = await ev.createRun(DEFAULT_TENANT_ID, { serverId: srv.id, suiteId: suite.id, environmentId: env.id, modes: ['tool'], repeats: 5, trigger: 'cli', createdBy: null, wait: true, maxRunTokens: 1 });
    expect(run.status).toBe('succeeded');
    // attempts already in flight (concurrency 4) finish; no new one starts
    expect(ev.score(run)!.incomplete).toMatchObject({ attemptsRun: 4, attemptsPlanned: 5 });
  }, 120_000);

  it('0.3.3: suite and task limits are stored, honored per attempt and kept with the results', async () => {
    const ev = s.services.evals;
    const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'petstore'))!;
    const env = (await s.services.servers.environments(srv.id)).find((e) => e.slug === 'dev')!;
    const ref = { referenceCalls: [{ tool: 'get_pet_by_id', arguments: { pet_id: 1 } }], assertions: [{ type: 'called' as const, tool: 'get_pet_by_id' }] };
    const plain = task({ key: 'plain', prompt: 'Find pet 1 (use pet_id=1)', ...ref });
    const big = task({ key: 'big', prompt: 'Find pet 1 (use pet_id=1)', ...ref, limits: { maxToolCalls: 150, maxTurns: 40 } });
    const suite = await ev.saveSuite(DEFAULT_TENANT_ID, srv.id, null, [plain, big], { mockDataVersion: 2, limits: { wallMs: 600_000 } }, null, true);
    expect(Object.fromEntries((await ev.suiteTasks(DEFAULT_TENANT_ID, suite.id)).map((r) => [r.key, r.limits ? JSON.parse(r.limits) : null]))).toEqual({ plain: null, big: { maxToolCalls: 150, maxTurns: 40 } });
    const run = await ev.createRun(DEFAULT_TENANT_ID, { serverId: srv.id, suiteId: suite.id, environmentId: env.id, modes: ['tool'], repeats: 1, trigger: 'cli', createdBy: null, wait: true });
    const by = Object.fromEntries((await ev.taskResults(DEFAULT_TENANT_ID, run.id)).map((r) => [r.taskKey, r.limits]));
    expect(by).toEqual({ plain: { maxTurns: 25, maxToolCalls: 60, maxTotalTokens: 200_000, wallMs: 600_000 }, big: { maxTurns: 40, maxToolCalls: 150, maxTotalTokens: 200_000, wallMs: 600_000 } });
  }, 120_000);
});
