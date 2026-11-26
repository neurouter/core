import type { Services } from './deps.js';
import type { JobScheduler } from './kernel/jobs/scheduler.js';
import { DbMockStateStore } from './dataplane/mock/db-store.js';
import { environmentRuntime } from './kernel/runtime-config.js';

const DAY = 86_400_000;

/** Leader-only background jobs (§12.4; Hub scheduler with leases). */
export function registerJobs(scheduler: JobScheduler, s: Services, extra: Array<(sch: JobScheduler, s: Services) => void> = []): void {
  scheduler.register({ name: 'tasks.close-idle', schedule: '0 * * * * *', run: async () => void (await s.tracker.closeIdle()) });
  scheduler.register({ name: 'search.index-build', schedule: '45 */2 * * * *', leaseMs: 10 * 60_000, run: async () => void (await s.indexer.run()) });
  scheduler.register({
    name: 'retention.sweep',
    schedule: '0 20 3 * * *',
    leaseMs: 60 * 60_000,
    run: async () => {
      const db = s.dbs.main.db;
      const now = s.clock.now();
      // tenant-free rows
      await db.deleteFrom('local_links').where('expires_at', '<=', now).execute();
      // per tenant: each tenant's own retention setting (spec §4.6)
      // tenant-scope: global-table
      const tenants = await db.selectFrom('tenants').select('id').execute();
      for (const t of tenants) {
        const days = (await s.settings.get('retentionDays', t.id)) ?? s.config.env.NEUROUTER_RETENTION_DAYS;
        const cutoff = now - days * DAY;
        await db.deleteFrom('result_pages').where('tenant_id', '=', t.id).where('expires_at', '<=', now).execute();
        await db.deleteFrom('error_events').where('tenant_id', '=', t.id).where('expires_at', '<=', now).execute();
        await db.deleteFrom('script_runs').where('tenant_id', '=', t.id).where('started_at', '<', cutoff).execute();
        await db.deleteFrom('decisions').where('tenant_id', '=', t.id).where('ts', '<', cutoff).execute();
        await db.deleteFrom('unmet_needs').where('tenant_id', '=', t.id).where('created_at', '<', cutoff).execute();
        await db.deleteFrom('tasks').where('tenant_id', '=', t.id).where('started_at', '<', cutoff).where('status', '=', 'closed').execute();
        await db.updateTable('eval_task_runs').set({ transcript: null }).where('tenant_id', '=', t.id).where('created_at', '<', cutoff).execute();
      }
    },
  });
  // SIEM export (§9.7): at-least-once delivery of new audit rows to the enabled sinks
  scheduler.register({ name: 'audit.sinks', schedule: '*/5 * * * * *', leaseMs: 60_000, run: async () => void (await s.sinkDispatcher.runOnce()) });
  scheduler.register({ name: 'audit.checkpoint', schedule: '15 * * * * *', run: async () => void (await s.auditStore.periodicCheckpoint()) });
  scheduler.register({
    name: 'audit.retention',
    schedule: '0 15 3 * * *',
    leaseMs: 60 * 60_000,
    run: async () => {
      const days = await s.settings.get('auditRetentionDays');
      await s.auditStore.applyRetention(s.clock.now() - days * DAY);
    },
  });
  scheduler.register({
    name: 'audit.partitions',
    schedule: '0 5 0 * * *',
    runOnStart: true,
    run: async () => {
      const res = await s.auditStore.maintainPartitions();
      for (const f of res.failed) s.logger.warn({ partition: f.name, error: f.error }, 'audit partition could not be created');
    },
  });
  scheduler.register({
    name: 'oauth.cleanup',
    schedule: '40 */15 * * * *',
    run: async () => {
      await s.oauthTokens.cleanup();
      await s.upstreamOAuth.cleanupStates();
    },
  });
  scheduler.register({
    name: 'console.session-cleanup',
    schedule: '0 */15 * * * *',
    run: async () => {
      const db = s.dbs.main.db;
      const now = s.clock.now();
      await db.deleteFrom('web_sessions').where((eb) => eb.or([eb('expires_at', '<=', now), eb('last_seen_at', '<=', now - s.config.env.SESSION_IDLE_MINUTES * 60_000)])).execute();
      await db.deleteFrom('oidc_login_states').where('expires_at', '<=', now).execute();
      // tenant-scope: system-job (expired previews of every tenant)
      await db.deleteFrom('spec_previews').where('expires_at', '<=', now).execute();
    },
  });
  scheduler.register({
    name: 'environments.health',
    schedule: '0 */5 * * * *',
    leaseMs: 5 * 60_000,
    run: async () => {
      const db = s.dbs.main.db;
      // tenant-scope: system-job (every tenant's active environments; each probe uses the row's tenant)
      const envs = await db.selectFrom('environments').selectAll().where('status', '=', 'active').execute();
      for (const e of envs) {
        const rt = environmentRuntime(e);
        const checkedAt = new Date(s.clock.now()).toISOString();
        let health: Record<string, unknown>;
        if (rt.isMock) health = { status: 'up', checkedAt, latencyMs: 0, error: null };
        else {
          const started = s.clock.now();
          const credential = await s.credentials.presence(rt.auth, rt.id, e.tenant_id).catch(() => 'missing' as const);
          try {
            const res = await s.upstreamFetchFor(rt.allowHttp)(rt.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000), redirect: 'manual' });
            health = { status: res.status < 500 ? 'up' : 'down', checkedAt, latencyMs: s.clock.now() - started, error: res.status < 500 ? null : `HTTP ${res.status}`, credential };
          } catch (err) {
            health = { status: 'down', checkedAt, latencyMs: s.clock.now() - started, error: (err as Error).message.slice(0, 200), credential };
          }
        }
        await db.updateTable('environments').set({ health: JSON.stringify(health) }).where('id', '=', e.id).where('tenant_id', '=', e.tenant_id).execute();
      }
    },
  });
  // mock state GC (multi-tenancy spec §7.4): expired eval/gen namespaces, env namespaces idle > 30 days
  const mockStore = s.mockStore;
  if (mockStore instanceof DbMockStateStore)
    scheduler.register({
      name: 'mock.gc',
      schedule: '30 * * * * *',
      run: async () => {
        // batches of ≤ 5,000 rows; at most 10 per minute so a backlog drains without one long run
        for (let i = 0; i < 10; i++) if (!(await mockStore.gc(5000)).more) break;
      },
    });
  for (const e of [...extra, ...(s.extensions.jobs ?? [])]) e(scheduler, s);
}
