import { DEFAULT_TENANT_ID } from '@neurouter/shared';
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
    expect([...jobs.keys()]).toEqual(expect.arrayContaining(['tasks.close-idle', 'retention.sweep', 'audit.checkpoint', 'audit.retention', 'environments.health', 'oauth.cleanup', 'search.index-build', 'mock.gc']));
  });

  it('environments.health records health for every active environment (mock: up)', async () => {
    await jobs.get('environments.health')!();
    const rows = await t.s.services.dbs.main.db.selectFrom('environments').select(['slug', 'health']).execute();
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(JSON.parse(r.health)).toMatchObject({ status: 'up' });
  });

  it('retention.sweep garbage-collects inactive eval keys older than the retention, never user keys', async () => {
    const svc = t.s.services;
    const db = svc.dbs.main.db;
    const srv = (await svc.servers.bySlug(DEFAULT_TENANT_ID, 'petstore'))!;
    const env = (await svc.servers.environments(srv.id)).find((e) => e.slug === 'dev')!;
    const admin = await svc.users.ensureBootstrapAdmin();
    const mk = async (purpose: 'user' | 'eval', revoke: boolean) => {
      const { key } = await svc.apiKeys.create({ tenantId: DEFAULT_TENANT_ID, name: `gc ${purpose}`, serverId: srv.id, environmentId: env.id, scopes: ['tools:read'], ownerUserId: admin.id, purpose, expiresInDays: 1 });
      if (revoke) await svc.apiKeys.revoke(DEFAULT_TENANT_ID, key.id, null);
      return key.id;
    };
    const oldEval = await mk('eval', true);
    const oldEvalActive = await mk('eval', false);
    const oldUser = await mk('user', true);
    const freshEval = await mk('eval', true);
    const old = svc.clock.now() - 400 * 86_400_000;
    await db.updateTable('api_keys').set({ created_at: old }).where('id', 'in', [oldEval, oldEvalActive, oldUser]).execute();
    // the "active" old eval key is past its 1-day expiry
    await db.updateTable('api_keys').set({ expires_at: old + 86_400_000 }).where('id', '=', oldEvalActive).execute();
    await jobs.get('retention.sweep')!();
    const left = (await db.selectFrom('api_keys').select('id').where('id', 'in', [oldEval, oldEvalActive, oldUser, freshEval]).execute()).map((k) => k.id).sort();
    expect(left).toEqual([oldUser, freshEval].sort());
  });

  it('retention.sweep and tasks.close-idle run without errors', async () => {
    await jobs.get('retention.sweep')!();
    await jobs.get('tasks.close-idle')!();
  });

  it('mock.gc drops expired mock namespaces (DB mock store)', async () => {
    const db = t.s.services.dbs.main.db;
    const env = (await db.selectFrom('environments').select(['id', 'tenant_id']).executeTakeFirstOrThrow());
    const ns = { tenantId: env.tenant_id, environmentId: env.id, name: 'gen:expired' };
    await t.s.services.mockStore.reset(ns, 1);
    await db.updateTable('mock_namespaces').set({ expires_at: 1 }).where('tenant_id', '=', env.tenant_id).where('environment_id', '=', env.id).where('namespace', '=', ns.name).execute();
    await jobs.get('mock.gc')!();
    expect(await db.selectFrom('mock_namespaces').select('namespace').where('tenant_id', '=', env.tenant_id).where('namespace', '=', ns.name).executeTakeFirst()).toBeUndefined();
  });
});
