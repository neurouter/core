import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { consoleOn, type TestContext } from '../fakes/app-context.js';
import { bootServer } from '../fakes/server.js';

/** M6 acceptance over the console REST API with the deterministic stub provider (no key). */
describe('evals REST flow (stub provider)', () => {
  let t: TestContext;
  let serverId: string;
  beforeAll(async () => {
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    t = await consoleOn(await bootServer({ NEUROUTER_EVAL_LLM: 'stub' }));
    const s = t.s.services;
    serverId = (await s.servers.bySlug(s.tenantId, 'petstore'))!.id;
  }, 60_000);
  afterAll(async () => {
    delete process.env.NEUROUTER_EVAL_LLM;
    await t?.close();
  });

  it('readiness is preliminary (lint) before any run', async () => {
    const r = await t.json(t.admin, { method: 'GET', url: `/api/servers/${serverId}/readiness` }, 200);
    expect(r).toMatchObject({ confidence: 'preliminary' });
  });

  it('quick run → score, matrix, task results, transcript, suggestions; compare; verify; apply as draft', async () => {
    const run = await t.json(t.admin, { method: 'POST', url: '/api/eval-runs', payload: { serverId, preset: 'quick', modes: ['tool', 'code'] } }, 202);
    expect(run.status).toMatch(/queued|running/);
    await t.s.services.jobs.idle();
    const d = await t.json(t.admin, { method: 'GET', url: `/api/eval-runs/${run.id}` }, 200);
    expect(d.status).toBe('succeeded');
    expect(d.score.headline).toBeGreaterThan(0);
    expect(d.matrix.map((m: { mode: string }) => m.mode).sort()).toEqual(['code', 'tool']);
    expect(d.tasks.length).toBeGreaterThan(0);
    const cell = d.tasks[0].cells[0];
    const tr = await t.json(t.admin, { method: 'GET', url: `/api/eval-runs/${run.id}/task-runs/${cell.taskRunIds[0]}` }, 200);
    expect(tr.transcript[0]).toMatchObject({ type: 'user' });
    const rd = await t.json(t.admin, { method: 'GET', url: `/api/servers/${serverId}/readiness` }, 200);
    expect(rd).toMatchObject({ confidence: 'measured', score: d.score.headline, runId: run.id });
    const sugg = await t.json(t.admin, { method: 'GET', url: `/api/eval-runs/${run.id}/suggestions` }, 200);
    const runs = await t.json(t.admin, { method: 'GET', url: `/api/eval-runs?serverId=${serverId}` }, 200);
    expect(runs.items.length).toBe(1);
    // a second run (frozen suite) and compare
    const suites = await t.json(t.admin, { method: 'GET', url: `/api/servers/${serverId}/eval-suites` }, 200);
    await t.json(t.admin, { method: 'POST', url: `/api/eval-suites/${suites.items[0].id}/freeze` }, 200);
    const run2 = await t.json(t.admin, { method: 'POST', url: '/api/eval-runs', payload: { serverId, suiteId: suites.items[0].id, modes: ['tool'], repeats: 1 } }, 202);
    await t.s.services.jobs.idle();
    const cmp = await t.json(t.admin, { method: 'GET', url: `/api/eval-runs/compare?base=${run.id}&head=${run2.id}` }, 200);
    expect(cmp.tasks.length).toBeGreaterThan(0);
    expect(typeof cmp.scoreDelta).toBe('number');
    if (sugg.items.length) {
      const sid = sugg.items[0].id;
      const v = await t.json(t.admin, { method: 'POST', url: `/api/suggestions/${sid}/verify` }, 202);
      expect(v.status).toBe('verifying');
      await t.s.services.jobs.idle();
      const after = await t.json(t.admin, { method: 'GET', url: `/api/suggestions/${sid}` }, 200);
      expect(after.status).toBe('verified');
      expect(typeof after.verifiedDelta).toBe('number');
      const ap = await t.json(t.admin, { method: 'POST', url: `/api/suggestions/${sid}/apply`, payload: { mode: 'draft' } }, 200);
      expect(ap.suggestion.status).toBe('applied');
      expect(ap.draft.changeCount).toBeGreaterThan(0);
    }
    // public report + badge once a measured run exists and publicReport is on (example yaml sets it)
    const rep = await t.as(null, { method: 'GET', url: '/public/servers/petstore/report' });
    expect(rep.statusCode).toBe(200);
    const badge = await t.as(null, { method: 'GET', url: '/public/servers/petstore/badge.svg' });
    expect(badge.body).toContain('<svg');
  }, 120_000);

  it('viewer cannot start runs; evals never target prod', async () => {
    const viewer = await t.user('viewer@test.dev', 'viewer');
    const r = await t.as(viewer, { method: 'POST', url: '/api/eval-runs', payload: { serverId } });
    expect(r.statusCode).toBe(403);
    const prod = (await t.s.services.servers.environments(serverId)).find((e) => e.slug === 'prod')!;
    const p = await t.as(t.admin, { method: 'POST', url: '/api/eval-runs', payload: { serverId, environmentId: prod.id } });
    expect(p.statusCode).toBe(422);
  });
});
