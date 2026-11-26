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
});
