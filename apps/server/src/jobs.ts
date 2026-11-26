import type { Services } from './deps.js';
import type { JobScheduler } from './kernel/jobs/scheduler.js';

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
      const days = (await s.settings.get('retentionDays')) ?? s.config.env.NEUROUTER_RETENTION_DAYS;
      const cutoff = now - days * DAY;
      await db.deleteFrom('result_pages').where('expires_at', '<=', now).execute();
      await db.deleteFrom('error_events').where('expires_at', '<=', now).execute();
      await db.deleteFrom('local_links').where('expires_at', '<=', now).execute();
      await db.deleteFrom('script_runs').where('started_at', '<', cutoff).execute();
      await db.deleteFrom('decisions').where('ts', '<', cutoff).execute();
      await db.deleteFrom('unmet_needs').where('created_at', '<', cutoff).execute();
      await db.deleteFrom('tasks').where('started_at', '<', cutoff).where('status', '=', 'closed').execute();
      await db.updateTable('eval_task_runs').set({ transcript: null }).where('created_at', '<', cutoff).execute();
    },
  });
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
      await db.deleteFrom('spec_previews').where('expires_at', '<=', now).execute();
    },
  });
  for (const e of extra) e(scheduler, s);
}
