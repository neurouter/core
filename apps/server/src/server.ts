import type { FastifyInstance } from 'fastify';
import pg from 'pg';
import { buildApp } from './app.js';
import { fileEnvDefaults, type FileEnvDefaults } from './controlplane/config-sync/file-env.js';
import { createServices, initServices, type ServiceInputs, type Services } from './deps.js';
import { registerJobs } from './jobs.js';
import { ConfigError, loadConfig, loadDotenv, type Config } from './kernel/config/load.js';
import { MemoryCoordination } from './kernel/coordination/memory.js';
import { PostgresCoordination } from './kernel/coordination/postgres.js';
import type { CoordinationStore } from './kernel/coordination/types.js';
import { createDatabases, migrateAll } from './kernel/db/index.js';
import { redactDatabaseUrl } from './kernel/db/url.js';
import { JobScheduler } from './kernel/jobs/scheduler.js';
import { systemClock } from './kernel/lib/clock.js';
import { createLogger } from './kernel/lib/logger.js';
import { SERVER_VERSION } from './version.js';
import { routePlugins } from './routes.js';

export { ConfigError };

/** Proxy URL without credentials (for logs). */
function redactProxy(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.username || u.password) u.username = u.password = '***';
    return u.toString();
  } catch {
    return '(invalid)';
  }
}

/** Pre-parses NEUROUTER_CONFIG for its process-level keys; null when there is no usable file (the reconcile reports problems). */
async function readFileDefaults(source: Record<string, string | undefined>): Promise<FileEnvDefaults | null> {
  const path = source.NEUROUTER_CONFIG;
  if (!path || source.NEUROUTER_CONFIG_MODE === 'console') return null;
  try {
    const { readFileSync } = await import('node:fs');
    const { parseConfigYaml } = await import('./controlplane/config-sync/reconcile.js');
    const p = parseConfigYaml(readFileSync(path, 'utf8'), path);
    return p.config ? fileEnvDefaults(p.config, source) : null;
  } catch {
    return null;
  }
}

export interface StartOptions {
  /** Environment source (default `process.env`, with `.env` loaded outside production). */
  env?: Record<string, string | undefined>;
  /** Listen (default true); false = build only (tests, `inject`). */
  listen?: boolean;
  /** Overrides for service construction (tests). */
  services?: Partial<Pick<ServiceInputs, 'upstreamFetch' | 'outboundFetch' | 'embedder' | 'executor' | 'defaultMetrics' | 'otelLogProvider'>>;
  /** Start the background job scheduler (default true when listening). */
  jobs?: boolean;
  loadDotenv?: boolean;
}

export interface RunningServer {
  app: FastifyInstance;
  services: Services;
  config: Config;
  /** Base URL actually listened on (with the real port). */
  url: string;
  close(): Promise<void>;
}

/**
 * Boot sequence (ADAPT Hub main.ts): config → databases → migrations → coordination → services →
 * neurouter.yaml reconcile → app → listen → jobs. Shared by `main.ts`, `npx neurouter serve` and
 * the in-process `npx neurouter eval`.
 */
export async function startServer(opts: StartOptions = {}): Promise<RunningServer> {
  if (opts.loadDotenv !== false && !opts.env) loadDotenv();
  const source = opts.env ?? process.env;
  // neurouter.yaml keys that configure the process (publicUrl, auth.oidc, evals.apiKey, externalAs):
  // read before the config is derived; environment variables win (see file-env.ts)
  const file = await readFileDefaults(source);
  const config = loadConfig({ ...source, ...(file?.env ?? {}) });
  config.externalAs = file?.externalAs ?? null;
  const logger = createLogger({ level: config.env.LOG_LEVEL, pretty: config.env.LOG_PRETTY, instanceId: config.instanceId });
  // egress proxy for plain fetch() users (LLM provider SDKs, JWKS); guarded fetches get it per request (safe-fetch)
  if (config.env.HTTPS_PROXY || config.env.HTTP_PROXY) {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import('undici');
    setGlobalDispatcher(new EnvHttpProxyAgent({ ...(config.env.HTTP_PROXY ? { httpProxy: config.env.HTTP_PROXY } : {}), ...(config.env.HTTPS_PROXY ? { httpsProxy: config.env.HTTPS_PROXY } : {}), noProxy: config.env.NO_PROXY.join(',') }));
    logger.info({ httpsProxy: redactProxy(config.env.HTTPS_PROXY), httpProxy: redactProxy(config.env.HTTP_PROXY), noProxy: config.env.NO_PROXY }, 'egress proxy configured');
  }
  for (const w of config.warnings) logger.warn(w);
  for (const w of file?.warnings ?? []) logger.warn(`neurouter.yaml: ${w}`);
  const dbs = createDatabases({ databaseUrl: config.databaseUrl, auditDatabaseUrl: config.auditDatabaseUrl, poolMax: config.env.DB_POOL_MAX, auditPoolMax: config.env.AUDIT_DB_POOL_MAX, onWarn: (msg, err) => logger.warn({ err }, msg) });
  logger.info({ dialect: dbs.main.dialect, database: redactDatabaseUrl(config.databaseUrl) }, 'database configured');
  if (config.env.MIGRATE_ON_START) {
    const applied = await migrateAll(dbs, { embeddingDims: config.env.EMBEDDINGS_DIMS });
    if (applied.main.length + applied.audit.length) logger.info({ main: applied.main, audit: applied.audit }, 'migrations applied');
  }
  let coordination: CoordinationStore = new MemoryCoordination(systemClock);
  if (config.env.COORDINATION_BACKEND === 'postgres' || (config.env.COORDINATION_BACKEND === 'auto' && dbs.main.dialect === 'postgres')) {
    if (dbs.main.dialect !== 'postgres') throw new Error('COORDINATION_BACKEND=postgres requires a Postgres DATABASE_URL');
    const pgc = new PostgresCoordination(dbs.main.db, systemClock, () => new pg.Client({ connectionString: config.databaseUrl, application_name: 'neurouter-listen' }), logger);
    await pgc.start();
    coordination = pgc;
  }
  const services = createServices({ config, logger, dbs, clock: systemClock, coordination, version: SERVER_VERSION, ...(opts.services ?? {}) });
  await initServices(services);
  if (config.env.NEUROUTER_CONFIG && config.env.NEUROUTER_CONFIG_MODE !== 'console') {
    const r = await services.configSync.loadFile(config.env.NEUROUTER_CONFIG);
    if (r.ok) logger.info({ path: config.env.NEUROUTER_CONFIG, servers: r.servers, environments: r.environments }, 'neurouter.yaml applied');
    else for (const d of r.diagnostics) logger.error({ line: d.line, code: d.code }, `neurouter.yaml: ${d.message}`);
  }
  const app = await buildApp({
    config,
    logger,
    dbs,
    auditStore: services.auditStore,
    clock: systemClock,
    version: SERVER_VERSION,
    metrics: services.metrics,
    readinessInfo: {
      executor: async () => (services.executorHealth.healthy ? { ok: true, detail: services.executorHealth.last?.montyVersion ?? '' } : { ok: false, error: config.env.NEUROUTER_EXECUTOR_MODE === 'off' ? 'code mode off' : (services.executorHealth.last?.detail ?? 'executor unavailable') }),
      embedder: async () => ({ ok: services.embedder.status() !== 'error', detail: services.embedder.status() }),
    },
    plugins: routePlugins(services),
  });
  const listen = opts.listen ?? true;
  let url = config.publicUrl;
  if (listen) {
    const addr = await app.listen({ host: config.env.HOST, port: config.env.PORT });
    url = addr.replace('[::1]', 'localhost').replace('0.0.0.0', 'localhost');
    const port = new URL(addr).port;
    services.localUrl.value = `http://127.0.0.1:${port}`;
  } else await app.ready();
  const scheduler = new JobScheduler(coordination, config.instanceId, logger);
  registerJobs(scheduler, services);
  if (opts.jobs ?? listen) scheduler.start();
  if (services.embedder.status() === 'idle') services.embedder.warmUp();
  logger.info({ publicUrl: config.publicUrl, version: SERVER_VERSION }, 'neurouter server ready');
  // first start: print a one-time console sign-in link until an admin has signed in (§13.1)
  if (listen && config.localLink && !(await services.settings.get('firstAdminSignedIn'))) {
    try {
      const { mintConsoleLink } = await import('./console.js');
      const link = await mintConsoleLink(services);
      logger.info({ consoleLink: link }, 'open this one-time link to sign in to the console (valid 15 min; `npx neurouter console-link` mints a new one)');
      if (process.stdout.isTTY) console.log(`\n  Neurouter console sign-in (one-time, 15 min):\n  ${link}\n`);
    } catch (err) {
      logger.warn({ err }, 'could not mint the console sign-in link');
    }
  }
  let closed = false;
  return {
    app,
    services,
    config,
    url,
    close: async () => {
      if (closed) return;
      closed = true;
      await app.close();
      await scheduler.stop();
      await services.shutdown();
      await coordination.close();
      await dbs.close();
    },
  };
}
