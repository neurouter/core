import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerJobs } from './jobs.js';
import type { JobScheduler } from './kernel/jobs/scheduler.js';
import { createTestContext, type TestContext } from './test/fakes/app-context.js';
import { resolve } from 'node:path';
import { REPO_ROOT } from './test/fakes/server.js';

describe('background jobs', () => {
  let t: TestContext;
  const jobs = new Map<string, () => Promise<void>>();
  beforeAll(async () => {
    t = await createTestContext({ NEUROUTER_CONFIG: resolve(REPO_ROOT, 'neurouter.example.yaml') });
    registerJobs({ register: (j: { name: string; run: () => Promise<void> }) => void jobs.set(j.name, j.run) } as unknown as JobScheduler, t.s.services);
  }, 60_000);
  afterAll(async () => t?.close());

  it('registers the §12.4 jobs', () => {
    expect([...jobs.keys()]).toEqual(expect.arrayContaining(['tasks.close-idle', 'retention.sweep', 'audit.checkpoint', 'audit.retention', 'environments.health', 'oauth.cleanup', 'search.index-build']));
  });

  it('environments.health records health for every active environment (mock: up)', async () => {
    await jobs.get('environments.health')!();
    const rows = await t.s.services.dbs.main.db.selectFrom('environments').select(['slug', 'health']).execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.parse(r.health)).toMatchObject({ status: 'up' });
  });

  it('retention.sweep and tasks.close-idle run without errors', async () => {
    await jobs.get('retention.sweep')!();
    await jobs.get('tasks.close-idle')!();
  });
});
