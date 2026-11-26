import type { Logger } from 'pino';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { LocalExecutor, parseExecutorUrl, SocketExecutor, spawnEmbeddedExecutor, type EmbeddedExecutor, type Executor } from '@neurouter/executor';
import { AuditRecorder } from './kernel/audit/recorder.js';
import { SqlAuditStore, type AuditStore } from './kernel/audit/store.js';
import { createArchiveStore, type ArchiveStore } from './kernel/audit/archive/index.js';
import { auditMacKey } from './kernel/audit/chain.js';
import { RedactionRulesService } from './kernel/audit/redaction-rules.service.js';
import type { AuditWriteContext, CommittedAuditRow } from './kernel/audit/writer.js';
import type { Config } from './kernel/config/load.js';
import type { CoordinationStore } from './kernel/coordination/types.js';
import type { Databases } from './kernel/db/index.js';
import type { Clock } from './kernel/lib/clock.js';
import { newId } from './kernel/lib/ids.js';
import { createSafeFetch, type FetchLike } from './kernel/lib/net/safe-fetch.js';
import type { NetPolicy } from './kernel/lib/net/ssrf-guard.js';
import { Metrics } from './kernel/observability/metrics.js';
import { DbRuntimeConfigSource } from './kernel/runtime-config.js';
import { BuiltinSecretProvider } from './kernel/secrets/builtin.provider.js';
import { EnvelopeService } from './kernel/secrets/envelope.service.js';
import { EnvKeyring } from './kernel/secrets/keyring.js';
import { NamedSecrets } from './kernel/secrets/named-secrets.js';
import { SettingsService } from './kernel/settings/settings.service.js';
import { JobsService } from './kernel/jobs/jobs.service.js';
import { McpAuthenticator } from './dataplane/auth/authenticate.js';
import { ExternalJwtVerifier } from './dataplane/auth/external-jwt.js';
import { ClientCredentialsCache, CredentialResolver } from './dataplane/http/credentials.js';
import { HttpInvoker } from './dataplane/http/invoker.js';
import { InProcessMock } from './dataplane/mock/mock-upstream.js';
import { ArgValidator } from './dataplane/pipeline/arg-validate.js';
import { ErrorEvents } from './dataplane/pipeline/errors.js';
import { Pipeline } from './dataplane/pipeline/pipeline.js';
import { RateLimiter } from './dataplane/rate-limit/limiter.js';
import { LeaseRateLimitStore, MemoryRateLimitStore, PgBucketExecutor } from './dataplane/rate-limit/stores.js';
import { ResultPages } from './dataplane/shaping/result-pages.js';
import { TaskTracker } from './dataplane/tasks/tracker.js';
import { OpsTools } from './dataplane/ops/ops.js';
import { ScriptRunner } from './dataplane/code/run-script.js';
import { Dispatcher } from './dataplane/mcp/dispatch.js';
import { CoordinationEventBus } from './dataplane/mcp/event-bus.js';
import { disabledEmbedder, WorkerEmbedder, type Embedder } from './dataplane/search/embedder.js';
import { SearchIndexer } from './dataplane/search/indexer.js';
import { KeywordIndex } from './dataplane/search/keyword-index.js';
import { ToolSearchService } from './dataplane/search/search.service.js';
import { createVectorIndex } from './dataplane/search/vector-index.js';
import { recordUsage } from './dataplane/tasks/usage.js';
import { BuildsService } from './controlplane/servers/builds.service.js';
import { ServersService } from './controlplane/servers/servers.service.js';
import { createSpecFetcher } from './controlplane/servers/fetch-spec.js';
import { ConfigSync } from './controlplane/config-sync/reconcile.js';
import { ApiKeysService } from './controlplane/keys/api-keys.service.js';
import { UsersService } from './controlplane/users/users.service.js';
import { ExecutorHealth } from './dataplane/code/executor-health.js';

export interface ServiceInputs {
  config: Config;
  logger: Logger;
  dbs: Databases;
  auditStore?: AuditStore;
  clock: Clock;
  coordination: CoordinationStore;
  version: string;
  /** Upstream fetch override (tests: in-memory fake APIs). */
  upstreamFetch?: FetchLike;
  /** Outbound fetch override (spec URLs, OIDC, JWKS). */
  outboundFetch?: FetchLike;
  archive?: ArchiveStore | null;
  defaultMetrics?: boolean;
  embedder?: Embedder;
  /** Executor override (tests: LocalExecutor or a fake). null = code mode off. */
  executor?: Executor | null;
}

export function upstreamPolicy(config: Config, allowHttp = false): NetPolicy {
  const allowPrivate = config.env.UPSTREAM_ALLOW_PRIVATE_NETWORKS;
  return { allowPrivate, denyCidrs: config.env.UPSTREAM_DENY_CIDRS, allowHttp: allowHttp || allowPrivate ? 'always' : config.env.OUTBOUND_ALLOW_HTTP_LOOPBACK ? 'loopback' : 'never' };
}

export function outboundPolicy(config: Config): NetPolicy {
  return { allowPrivate: config.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS, denyCidrs: config.env.UPSTREAM_DENY_CIDRS, allowHttp: config.env.OUTBOUND_ALLOW_HTTP_LOOPBACK ? 'loopback' : 'never' };
}

/** Composition root: constructs services with explicit dependencies (no DI framework). The only module importing both planes. */
export function createServices(input: ServiceInputs) {
  const { config, logger, dbs, clock, coordination: coord } = input;
  const db = dbs.main.db;
  const tenantId = DEFAULT_TENANT_ID;
  const now = () => clock.now();
  const settings = new SettingsService(db, clock, coord);
  const keyring = new EnvKeyring(config.masterKeys, config.activeKeyId);
  const closers: Array<() => Promise<void>> = [];

  /* ---------------------------------------------------------------- audit + observability */
  const metrics = new Metrics({ defaultMetrics: input.defaultMetrics ?? true });
  let redactionRules: RedactionRulesService | null = null;
  let failClosed = true;
  let ftsEnabled = true;
  let installId: string | null = null;
  const writeContext = async (): Promise<AuditWriteContext> => {
    const [keys, full, maxBytes, fc, fts, toolLabel] = await Promise.all([settings.get('auditSearchParamKeys'), settings.get('auditStoreFullOutput'), settings.get('auditFullOutputMaxBytes'), settings.get('auditFailClosed'), settings.get('auditFtsEnabled'), settings.get('metricsToolLabel')]);
    failClosed = fc;
    ftsEnabled = fts;
    metrics.toolLabel = toolLabel;
    installId ??= (await settings.get('installId')) ?? (await settings.setIfAbsent('installId', newId()));
    return { redactor: await redactionRules!.redactor(), searchParamKeys: keys, storeFullOutput: full, fullOutputMaxBytes: maxBytes, installId: installId! };
  };
  const archive = input.archive !== undefined ? input.archive : createArchiveStore(config.env.AUDIT_ARCHIVE_URL);
  const postCommit: Array<(rows: readonly CommittedAuditRow[]) => void> = [];
  const auditStore: AuditStore =
    input.auditStore ??
    new SqlAuditStore(dbs.audit.db, dbs.audit.dialect, {
      clock,
      log: logger,
      context: writeContext,
      failClosed: () => failClosed,
      ftsEnabled: () => ftsEnabled,
      mac: { signer: () => ({ keyId: keyring.activeKekId, key: auditMacKey(keyring.derivationKey()) }), keyFor: (kid) => (keyring.has(kid) ? auditMacKey(keyring.derivationKey(kid)) : null) },
      archive,
      onCommitted: (rows) => {
        metrics.observeAudit(rows);
        void recordUsage(db, rows).catch((err: unknown) => logger.warn({ err }, 'usage_daily update failed'));
        for (const h of postCommit) {
          try {
            h(rows);
          } catch (err) {
            logger.warn({ err }, 'audit post-commit hook failed');
          }
        }
      },
      hooks: { queueDepth: (n) => metrics.auditQueueDepth.set(n), dropped: () => metrics.auditDropped.inc(), flushed: (sec) => metrics.auditFlush.observe(sec) },
    });
  const audit = new AuditRecorder(auditStore, clock, logger);
  redactionRules = new RedactionRulesService(db, clock, audit, coord);
  const envelope = new EnvelopeService(db, keyring, clock);
  const secretProvider = new BuiltinSecretProvider(db, envelope, clock);
  const namedSecrets = new NamedSecrets(db, secretProvider, clock);
  const jobs = new JobsService(db, clock, logger);

  /* ---------------------------------------------------------------- outbound */
  let outboundFetch = input.outboundFetch;
  if (!outboundFetch) {
    const f = createSafeFetch({ policy: outboundPolicy(config), maxBytes: 16 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 3 });
    closers.push(() => f.close());
    outboundFetch = f;
  }
  const upstreamFetches = new Map<boolean, FetchLike>();
  const upstreamFetchFor = (allowHttp: boolean): FetchLike => {
    if (input.upstreamFetch) return input.upstreamFetch;
    let f = upstreamFetches.get(allowHttp);
    if (!f) {
      const sf = createSafeFetch({ policy: upstreamPolicy(config, allowHttp), maxBytes: 64 * 1024 * 1024, connectTimeoutMs: 5000, maxRedirects: 0 });
      closers.push(() => sf.close());
      upstreamFetches.set(allowHttp, sf);
      f = sf;
    }
    return f;
  };

  /* ---------------------------------------------------------------- search */
  let indexer: SearchIndexer | null = null;
  const embedder: Embedder =
    input.embedder ??
    (config.env.EMBEDDINGS_ENABLED
      ? new WorkerEmbedder({ model: config.env.EMBEDDINGS_MODEL, dtype: config.env.EMBEDDINGS_DTYPE, dims: config.env.EMBEDDINGS_DIMS, modelsDir: config.modelsDir, allowRemote: config.env.EMBEDDINGS_ALLOW_REMOTE, log: logger, onReady: () => indexer?.kick() })
      : disabledEmbedder(config.env.EMBEDDINGS_MODEL, config.env.EMBEDDINGS_DIMS));
  const vectorIndex = createVectorIndex(db, dbs.main.dialect);
  indexer = new SearchIndexer({ db, embedder, vectors: vectorIndex, clock, coord, log: logger });
  const search = new ToolSearchService(db, new KeywordIndex(db, dbs.main.dialect), vectorIndex, embedder, logger);

  /* ---------------------------------------------------------------- data plane */
  const runtime = new DbRuntimeConfigSource(db, clock, coord, { codeModeEnabled: () => settings.get('codeModeEnabled') });
  const bus = new CoordinationEventBus(coord);
  runtime.subscribe(() => bus.publish({ kind: 'tools_list_changed' } as never));
  const rateLimitStore = coord.backend === 'postgres' && dbs.main.dialect === 'postgres' ? new LeaseRateLimitStore(new PgBucketExecutor(db), clock) : (coord.rateLimit ?? new MemoryRateLimitStore(clock));
  const limiter = new RateLimiter(rateLimitStore);
  const external = config.externalAs ? new ExternalJwtVerifier(config.externalAs) : null;
  const authenticator = new McpAuthenticator(db, clock, { pepper: config.hashPepper, external }, coord);
  const tracker = new TaskTracker(db, now, (taskId) => void coord.publish('events.task', { taskId }).catch(() => {}));
  const errors = new ErrorEvents(db, now);
  const pages = new ResultPages(db, now);
  const mock = new InProcessMock({ now });
  const credentials = new CredentialResolver(namedSecrets.resolver(tenantId), {
    clientCredentials: new ClientCredentialsCache(async (d, secret) => {
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: d.clientId ?? '', client_secret: secret, ...(d.scopes?.length ? { scope: d.scopes.join(' ') } : {}) });
      const res = await upstreamFetchFor(false)(d.tokenUrl ?? '', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
      if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
      return (await res.json()) as { access_token: string; expires_in?: number };
    }),
    now,
  });
  const http = new HttpInvoker(upstreamFetchFor, now);
  const pipeline = new Pipeline({
    audit,
    tracker,
    limiter,
    args: new ArgValidator(),
    credentials,
    http,
    mock,
    pages,
    errors,
    metrics,
    now,
    publicUrl: config.publicUrl,
    version: input.version,
    log: logger,
    onSuccess: (ctx, tool, args) => void recordTrafficExample(db, ctx.bundle.server.id, ctx.tenantId, tool.name, args, ctx.bundle.build.hash).catch(() => {}),
  });
  const ops = new OpsTools({
    db,
    audit,
    tracker,
    limiter,
    pages,
    errors,
    pipeline,
    redactor: () => redactionRules!.redactor(),
    metrics,
    now,
    log: logger,
    embed: async (text) => (embedder.status() === 'ready' ? embedder.embedQuery(text) : null),
    onInboxChanged: () => void coord.publish('events.inbox', {}).catch(() => {}),
  });

  /* ---------------------------------------------------------------- code mode */
  let executor: Executor | null = input.executor !== undefined ? input.executor : null;
  let embedded: EmbeddedExecutor | null = null;
  const executorHealth = new ExecutorHealth(() => executor, metrics, logger);
  const startExecutor = async (): Promise<void> => {
    if (input.executor !== undefined) return;
    const mode = config.env.NEUROUTER_EXECUTOR_MODE;
    if (mode === 'off') return;
    try {
      if (mode === 'local') executor = await LocalExecutor.create({ poolMax: config.env.NEUROUTER_EXECUTOR_POOL_MAX, prewarm: config.env.NEUROUTER_EXECUTOR_PREWARM, ...(config.env.MONTY_BINARY_PATH ? { binaryPath: config.env.MONTY_BINARY_PATH } : {}) });
      else if (mode === 'remote') executor = new SocketExecutor({ address: parseExecutorUrl(config.env.NEUROUTER_EXECUTOR_URL!), token: config.env.NEUROUTER_EXECUTOR_TOKEN!, ...(config.env.MONTY_BINARY_SHA256 ? { expectedMontySha256: config.env.MONTY_BINARY_SHA256 } : {}) });
      else {
        embedded = await spawnEmbeddedExecutor({
          poolMax: config.env.NEUROUTER_EXECUTOR_POOL_MAX,
          prewarm: config.env.NEUROUTER_EXECUTOR_PREWARM,
          socketPath: config.env.NEUROUTER_EXECUTOR_SOCKET,
          logLevel: config.env.LOG_LEVEL,
          nodeEnv: config.env.NODE_ENV,
          ...(config.env.NEUROUTER_EXECUTOR_TOKEN ? { token: config.env.NEUROUTER_EXECUTOR_TOKEN } : {}),
          ...(config.env.MONTY_BINARY_PATH ? { montyBinaryPath: config.env.MONTY_BINARY_PATH } : {}),
          onExit: (code, signal) => logger.warn({ code, signal }, 'code-mode executor exited; restarting'),
        });
        await embedded.ready(15_000);
        executor = embedded.executor;
      }
      logger.info({ mode }, 'code-mode executor started');
    } catch (err) {
      logger.error({ err, mode }, 'code-mode executor failed to start; code mode is unavailable');
      executor = null;
    }
    await executorHealth.check();
  };
  const scripts = new ScriptRunner({ db, executor: () => executor, pipeline, ops, tracker, audit, pages, metrics, now, log: logger, healthy: () => executorHealth.healthy });
  const argValidator = new ArgValidator();
  const dispatcher = new Dispatcher({ pipeline, ops, scripts, search, tracker, audit, args: argValidator, now });

  /* ---------------------------------------------------------------- control plane */
  const builds = new BuildsService(db, dbs.main.dialect, clock, coord, { onBuild: () => indexer?.kick() });
  const servers = new ServersService(db, clock, coord, builds, audit);
  const fetchSpec = createSpecFetcher(outboundFetch);
  const configSync = new ConfigSync({ db, clock, coord, servers, settings, audit, fetchSpec, tenantId });
  const apiKeys = new ApiKeysService(db, clock, config.hashPepper, audit, coord);
  const users = new UsersService(db, clock, audit, config);

  metrics.beforeRender = async () => {
    metrics.auditQueueDepth.set(auditStore.stats().queueDepth);
    metrics.embeddingStatus.reset();
    metrics.embeddingStatus.set({ status: embedder.status() }, embedder.status() === 'ready' ? 1 : 0);
  };

  const shutdown = async (): Promise<void> => {
    bus.close();
    executorHealth.stop();
    indexer?.close();
    await embedder.close().catch(() => {});
    await jobs.idle();
    if (embedded) await embedded.close().catch(() => {});
    else if (executor && input.executor === undefined) await executor.close().catch(() => {});
    for (const c of closers) await c();
    await auditStore.close(10_000).catch((err: unknown) => logger.error({ err }, 'audit flush on shutdown failed'));
  };

  return {
    config, logger, clock, dbs, coord, version: input.version, tenantId,
    settings, keyring, metrics, auditStore, audit, redactionRules: redactionRules!, envelope, secretProvider, namedSecrets, jobs, postCommit,
    outboundFetch, upstreamFetchFor, embedder, vectorIndex, indexer: indexer!, search,
    runtime, bus, limiter, authenticator, tracker, errors, pages, mock, credentials, http, pipeline, ops, scripts, dispatcher,
    executor: () => executor, executorHealth, startExecutor,
    builds, servers, fetchSpec, configSync, apiKeys, users,
    shutdown,
  };
}

export type Services = ReturnType<typeof createServices>;

/** Boot-time tasks: built-in redaction rules, install id, audit partitions, bootstrap admin, executor. */
export async function initServices(s: Services): Promise<void> {
  await s.redactionRules.seedBuiltins();
  if (!(await s.settings.get('installId'))) await s.settings.setIfAbsent('installId', newId());
  const parts = await s.auditStore.maintainPartitions();
  for (const f of parts.failed) s.logger.warn({ partition: f.name, error: f.error }, 'audit partition could not be created');
  await s.users.ensureBootstrapAdmin();
  await s.startExecutor();
}

/** Traffic examples (§9.6 step 13): first 3 distinct successful argument shapes per tool, redacted keys dropped. */
async function recordTrafficExample(db: Services['dbs']['main']['db'], serverId: string, tenantId: string, tool: string, args: Record<string, unknown>, buildHash: string): Promise<void> {
  const { sha256Hex } = await import('./kernel/lib/crypto.js');
  const { toJsonColumn } = await import('./kernel/lib/json.js');
  const shape = sha256Hex(JSON.stringify(Object.keys(args).sort()));
  const existing = await db.selectFrom('examples').select(['id', 'success_count', 'args_hash']).where('server_id', '=', serverId).where('tool_name', '=', tool).where('kind', '=', 'call').execute();
  const hit = existing.find((e) => e.args_hash === shape);
  const t = Date.now();
  if (hit) {
    await db.updateTable('examples').set({ success_count: hit.success_count + 1, last_success_at: t }).where('id', '=', hit.id).execute();
    return;
  }
  if (existing.length >= 3) return;
  const safe = Object.fromEntries(Object.entries(args).filter(([k]) => !/(pass|secret|token|key|auth)/i.test(k)));
  await db.insertInto('examples').values({ id: newId(), tenant_id: tenantId, server_id: serverId, tool_name: tool, kind: 'call', arguments: toJsonColumn(safe), code: null, args_hash: shape, source: 'traffic', success_count: 1, last_success_at: t, build_hash: buildHash }).onConflict((oc) => oc.doNothing()).execute();
}
