import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootServer, REPO_ROOT } from '../fakes/server.js';
import type { RunningServer } from '../../server.js';

const GOLDEN = resolve(import.meta.dirname, 'mock-eval-golden.json');

/** What an eval run on the GitHub demo produced: per task-run pass/fail and the scores (stub LLM, deterministic). */
async function evalSummary(s: RunningServer, slug: string): Promise<Record<string, unknown>> {
  const svc = s.services;
  const srv = (await svc.servers.bySlug(svc.tenantId, slug))!;
  const env = (await svc.servers.environments(srv.id)).find((e) => e.slug === 'mock')!;
  const run = await svc.evals.createRun({ serverId: srv.id, environmentId: env.id, preset: 'quick', modes: ['tool', 'code'], trigger: 'cli', createdBy: null, wait: true } as never);
  expect(run.status).toBe('succeeded');
  const score = svc.evals.score(run)!;
  const results = await svc.evals.taskResults(run.id);
  const tasks = (await svc.evals.suiteTasks(run.suite_id)).map((t) => ({ key: t.key, category: t.category, prompt: t.prompt, reference: t.reference_calls }));
  return {
    headline: score.headline,
    tasks,
    results: results.map((r) => ({ task: r.taskKey, mode: r.mode, attempt: r.attempt, passed: r.passed, failureCause: r.failureCause, toolCalls: r.toolCalls, assertions: r.assertionResults })).sort((a, b) => `${a.task}|${a.mode}|${a.attempt}`.localeCompare(`${b.task}|${b.mode}|${b.attempt}`)),
  };
}

/**
 * P0b acceptance: eval runs on the GitHub demo give the same results with the stub LLM as before the
 * mock state moved into the database (golden recorded on v0.1.1 with the in-memory store), for both stores.
 */
describe.each(['db', 'memory'] as const)('eval run on the GitHub demo with the %s mock store (stub LLM)', (store) => {
  let s: RunningServer;
  beforeAll(async () => {
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    s = await bootServer({ NEUROUTER_EVAL_LLM: 'stub', NEUROUTER_MOCK_STORE: store, NEUROUTER_CONFIG: resolve(REPO_ROOT, 'examples/demo/neurouter.yaml') });
  }, 60_000);
  afterAll(async () => {
    delete process.env.NEUROUTER_EVAL_LLM;
    await s?.close();
  });

  it('matches the recorded golden run', async () => {
    const got = { github: await evalSummary(s, 'github'), petstore: await evalSummary(s, 'petstore') };
    if (process.env.RECORD_GOLDEN || !existsSync(GOLDEN)) writeFileSync(GOLDEN, JSON.stringify(got, null, 2) + '\n');
    expect(got).toEqual(JSON.parse(readFileSync(GOLDEN, 'utf8')));
  }, 180_000);
});
