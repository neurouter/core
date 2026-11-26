import type { Logger } from 'pino';
import { EvalArgsTap } from './kernel/audit/eval-args-tap.js';
import { LocalExecutor, parseExecutorUrl, SocketExecutor, spawnEmbeddedExecutor, type EmbeddedExecutor, type Executor } from '@neurouter/executor';
import { AuditRecorder } from './kernel/audit/recorder.js';
import { SqlAuditStore, type AuditStore } from './kernel/audit/store.js';
import { createArchiveStore, type ArchiveStore } from './kernel/audit/archive/index.js';
import { auditMacKey } from './kernel/audit/chain.js';
import { RedactionRulesService } from './kernel/audit/redaction-rules.service.js';
import { SinkDispatcher } from './kernel/audit/sinks/dispatcher.js';
import { createOtlpLogProvider, OtelLogsSink, type LogProviderLike } from './kernel/audit/sinks/otel-logs.js';
import type { AuditSink } from './kernel/audit/sinks/sink.js';
import { WebhookSink } from './kernel/audit/sinks/webhook.js';
import type { AuditWriteContext, CommittedAuditRow } from './kernel/audit/writer.js';
import type { Config } from './kernel/config/load.js';
import type { CoordinationStore } from './kernel/coordination/types.js';
import type { Databases } from './kernel/db/index.js';
import type { Clock } from './kernel/lib/clock.js';
import { newId } from './kernel/lib/ids.js';
import { createSafeFetch, type FetchLike } from './kernel/lib/net/safe-fetch.js';
import { outboundPolicy, proxyOptions, upstreamPolicy } from './kernel/lib/net/policy.js';
import { Metrics } from './kernel/observability/metrics.js';
import { DbRuntimeConfigSource } from './kernel/runtime-config.js';
import { BuiltinSecretProvider } from './kernel/secrets/builtin.provider.js';
import { EnvelopeService } from './kernel/secrets/envelope.service.js';
import { EnvKeyring } from './kernel/secrets/keyring.js';
import { CursorCodec } from './dataplane/paging/cursor.js';
import { ConfirmTokens } from './dataplane/pipeline/confirm-token.js';
import { NamedSecrets } from './kernel/secrets/named-secrets.js';
import { SETTING_DEFAULTS, SettingsService } from './kernel/settings/settings.service.js';
import { EnvRefGate } from './kernel/secrets/env-refs.js';
import { SingleTenantResolver, type TenantResolver } from './kernel/tenancy/index.js';
import { DEFAULT_MODEL_KEYS, DEFAULT_QUOTAS, DEFAULT_SECRET_REFS, DEFAULT_USAGE, type NeurouterExtensions } from './extensions.js';
import { JobsService } from './kernel/jobs/jobs.service.js';
import { McpAuthenticator } from './dataplane/auth/authenticate.js';
import { ExternalJwtVerifier } from './dataplane/auth/external-jwt.js';
import { ClientCredentialsCache, CredentialResolver } from './dataplane/http/credentials.js';
import { HttpInvoker } from './dataplane/http/invoker.js';
import { DbMockStateStore } from './dataplane/mock/db-store.js';
import { InProcessMock } from './dataplane/mock/mock-upstream.js';
import { MockNamespaceBinder } from './dataplane/mock/namespace.js';
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
import { createGraphqlIntrospector, createSpecFetcher } from './controlplane/servers/fetch-spec.js';
import { ConfigSync } from './controlplane/config-sync/reconcile.js';
import { ApiKeysService } from './controlplane/keys/api-keys.service.js';
import { UsersService } from './controlplane/users/users.service.js';
import { ExecutorHealth } from './dataplane/code/executor-health.js';
import { EvalsService } from './controlplane/evals/evals.service.js';
import { MemoryMockStateStore, sampleEntities, type GraphqlMockModel, type MockStateStore, type OpenApiMockModel } from '@neurouter/compiler';
import { AuthorizationService } from './controlplane/oauth/authorize.js';
import { CimdResolver } from './controlplane/oauth/cimd.js';
import { OAuthClientsService } from './controlplane/oauth/clients.service.js';
import { DbSessionLookup, type ConsoleSessionLookup } from './controlplane/oauth/session.js';
import { OAuthTokensService } from './controlplane/oauth/tokens.service.js';
import { UpstreamOAuthService } from './controlplane/upstream-oauth/upstream-oauth.service.js';

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
  /** OTel logs provider override for the audit sink (tests). */
  otelLogProvider?: () => Promise<LogProviderLike>;
  /** Extension points (multi-tenancy spec §1.4); core defaults when absent. */
  extensions?: NeurouterExtensions;
  /** An executor boot already in flight (`bootExecutor`, started by `startServer` before the DB setup). */
  executorBoot?: Promise<ExecutorBoot>;
}

export interface ExecutorBoot {
  executor: Executor | null;
  embedded: EmbeddedExecutor | null;
  /** Set when the executor failed to start (code mode unavailable); never thrown. */
  error?: unknown;
}

/**
 * Starts the code-mode executor for `NEUROUTER_EXECUTOR_MODE` (embedded: spawns the child and awaits
 * its socket). Never rejects: a failure is returned in `error`. Independent of the database, so
 * `startServer` runs it concurrently with migrations and service init (cold start).
 */
export async function bootExecutor(config: Config, logger: Logger): Promise<ExecutorBoot> {
  const mode = config.env.NEUROUTER_EXECUTOR_MODE;
  if (mode === 'off') return { executor: null, embedded: null };
  let embedded: EmbeddedExecutor | null = null;
  try {
    if (mode === 'local') return { executor: await LocalExecutor.create({ poolMax: config.env.NEUROUTER_EXECUTOR_POOL_MAX, prewarm: config.env.NEUROUTER_EXECUTOR_PREWARM, ...(config.env.MONTY_BINARY_PATH ? { binaryPath: config.env.MONTY_BINARY_PATH } : {}) }), embedded: null };
    if (mode === 'remote') return { executor: new SocketExecutor({ address: parseExecutorUrl(config.env.NEUROUTER_EXECUTOR_URL!), token: config.env.NEUROUTER_EXECUTOR_TOKEN!, ...(config.env.MONTY_BINARY_SHA256 ? { expectedMontySha256: config.env.MONTY_BINARY_SHA256 } : {}) }), embedded: null };
    embedded = spawnEmbeddedExecutor({
      poolMax: config.env.NEUROUTER_EXECUTOR_POOL_MAX,
      prewarm: config.env.NEUROUTER_EXECUTOR_PREWARM,
      socketPath: config.env.NEUROUTER_EXECUTOR_SOCKET,
      logLevel: config.env.LOG_LEVEL,
      nodeEnv: config.env.NODE_ENV,
      ...(config.env.NEUROUTER_EXECUTOR_TOKEN ? { token: config.env.NEUROUTER_EXECUTOR_TOKEN } : {}),
      ...(config.env.MONTY_BINARY_PATH ? { montyBinaryPath: config.env.MONTY_BINARY_PATH } : {}),
      // pinned at image build: the child verifies the binary against it, the parent skips its own hash
      ...(config.env.MONTY_BINARY_PATH && config.env.MONTY_BINARY_SHA256 ? { montyBinarySha256: config.env.MONTY_BINARY_SHA256 } : {}),
      onExit: (code, signal) => logger.warn({ code, signal }, 'code-mode executor exited; restarting'),
      // relays the child's own log lines (pool started, listening, fatal errors) into the server log
      logger,
    });
    await embedded.ready(15_000);
    return { executor: embedded.executor, embedded };
  } catch (err) {
    if (embedded) await embedded.close().catch(() => {});
    return { executor: null, embedded: null, error: err };
  }
}

/** Releases an executor boot that was never handed to the services (startup failed before). */
export async function releaseExecutorBoot(boot: Promise<ExecutorBoot>): Promise<void> {
  const r = await boot;
  if (r.embedded) await r.embedded.close().catch(() => {});
  else await r.executor?.close().catch(() => {});
}

export { upstreamPolicy, outboundPolicy } from './kernel/lib/net/policy.js';

/** Composition root: constructs services with explicit dependencies (no DI framework). The only module importing both planes. */
export function createServices(input: ServiceInputs) {
  const { config, logger, dbs, clock, coordination: coord } = input;
  const db = dbs.main.db;
  const now = () => clock.now();
  const ext: NeurouterExtensions = input.extensions ?? {};
  const tenancy: TenantResolver = ext.tenancy ?? new SingleTenantResolver(db);
  const secretRefs = ext.secretRefs ?? DEFAULT_SECRET_REFS;
  const modelKeys = ext.modelKeys ?? DEFAULT_MODEL_KEYS;
  const quotas = ext.quotas ?? DEFAULT_QUOTAS;
  const usage = ext.usage ?? DEFAULT_USAGE;
  const settings = new SettingsService(db, clock, coord);
  /** `env:NAME` references on behalf of a tenant (spec §4.9 G12). */
  const envRefs = new EnvRefGate({ policy: secretRefs, allow: config.env.NEUROUTER_SECRET_ENV_ALLOW, tenant: (id) => tenancy.byId(id) });
  const keyring = new EnvKeyring(config.masterKeys, config.activeKeyId);
  const closers: Array<() => Promise<void>> = [];

  /* ---------------------------------------------------------------- audit + observability */
  const metrics = new Metrics({ defaultMetrics: input.defaultMetrics ?? true, perServerLabels: config.env.METRICS_PER_SERVER_LABELS });
  let redactionRules: RedactionRulesService | null = null;
  let failClosed = true;
  let ftsEnabled = true;
  let installId: string | null = null;
  const writeContext = async (): Promise<AuditWriteContext> => {
    const [maxBytes, fc, fts, toolLabel] = await Promise.all([settings.get('auditFullOutputMaxBytes'), settings.get('auditFailClosed'), settings.get('auditFtsEnabled'), settings.get('metricsToolLabel')]);
    failClosed = fc;
    ftsEnabled = fts;
    metrics.toolLabel = toolLabel;
    installId ??= (await settings.get('installId')) ?? (await settings.setIfAbsent('installId', newId()));
    // tenant keys (search param keys, full output) come from `tenantContext` per row's tenant; these are the defaults
    return { redactor: await redactionRules!.redactor(), searchParamKeys: SETTING_DEFAULTS.auditSearchParamKeys, storeFullOutput: SETTING_DEFAULTS.auditStoreFullOutput, fullOutputMaxBytes: maxBytes, installId: installId! };
  };
  const tenantWriteContext = async (tenantId: string) => {
    const [searchParamKeys, storeFullOutput] = await Promise.all([settings.get('auditSearchParamKeys', tenantId), settings.get('auditStoreFullOutput', tenantId)]);
    return { searchParamKeys, storeFullOutput };
  };
  const archive = input.archive !== undefined ? input.archive : createArchiveStore(config.env.AUDIT_ARCHIVE_URL);
  const postCommit: Array<(rows: readonly CommittedAuditRow[]) => void> = [];
  const auditStoreRaw: AuditStore =
    input.auditStore ??
    new SqlAuditStore(dbs.audit.db, dbs.audit.dialect, {
      clock,
      log: logger,
      context: writeContext,
      tenantContext: tenantWriteContext,
      failClosed: () => failClosed,
      ftsEnabled: () => ftsEnabled,
      mac: { signer: () => ({ keyId: keyring.activeKekId, key: auditMacKey(keyring.derivationKey()) }), keyFor: (kid) => (keyring.has(kid) ? auditMacKey(keyring.derivationKey(kid)) : null) },
      archive,
      onCommitted: (rows) => {
        metrics.observeAudit(rows);
        void recordUsage(db, rows).catch((err: unknown) => logger.warn({ err }, 'usage_daily update failed'));
        void Promise.resolve()
          .then(() => usage.record(rows.filter((r) => r.kind === 'tool_call').map((r) => ({ tenantId: r.tenant_id, meter: 'tool_calls' as const, value: 1, at: Number(r.ts), dedupKey: r.id }))))
          .catch((err: unknown) => logger.warn({ err }, 'usage sink failed'));
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
  // eval-only clear arguments (the audit log keeps them redacted): captured for watched eval keys, never persisted
  const evalArgs = new EvalArgsTap();
  const auditStore: AuditStore = auditStoreRaw;
  const recordAudit = auditStore.record.bind(auditStore);
  auditStore.record = (e) => {
    evalArgs.capture(e);
    return recordAudit(e);
  };
  const audit = new AuditRecorder(auditStore, clock, logger);
  redactionRules = new RedactionRulesService(db, clock, audit, coord);
  const envelope = new EnvelopeService(db, keyring, clock);
  const secretProvider = new BuiltinSecretProvider(db, envelope, clock);
  const namedSecrets = new NamedSecrets(db, secretProvider, clock);
  const jobs = new JobsService(db, clock, logger);

  /* ---------------------------------------------------------------- outbound */
  let outboundFetch = input.outboundFetch;
  if (!outboundFetch) {
    const f = createSafeFetch({ policy: outboundPolicy(config), ...proxyOptions(config), maxBytes: 16 * 1024 * 1024, timeoutMs: 30_000, maxRedirects: 3 });
    closers.push(() => f.close());
    outboundFetch = f;
  }
  const upstreamFetches = new Map<boolean, FetchLike>();
  const upstreamFetchFor = (allowHttp: boolean): FetchLike => {
    if (input.upstreamFetch) return input.upstreamFetch;
    let f = upstreamFetches.get(allowHttp);
    if (!f) {
      const sf = createSafeFetch({ policy: upstreamPolicy(config, allowHttp), ...proxyOptions(config), maxBytes: 64 * 1024 * 1024, connectTimeoutMs: 5000, maxRedirects: 0 });
      closers.push(() => sf.close());
      upstreamFetches.set(allowHttp, sf);
      f = sf;
    }
    return f;
  };

  /* ---------------------------------------------------------------- audit export (SIEM sinks, §9.7) */
  // P0: sinks are configured by the instance's default tenant and receive only that tenant's rows
  // (per-tenant cursors for many tenants: P1, spec §3.7)
  let otelLogProvider: Promise<LogProviderLike> | null = null;
  const sinkTenant = async (): Promise<string | null> => (await tenancy.defaultTenant())?.id ?? null;
  const auditSinks = async (): Promise<AuditSink[]> => {
    const tenantId = await sinkTenant();
    if (!tenantId) return [];
    const cfg = await settings.get('auditSinks', tenantId);
    const out: AuditSink[] = [];
    if (cfg.webhook.enabled && cfg.webhook.url) {
      const ref = cfg.webhook.secretRef;
      const secret = async (): Promise<string | null> => {
        if (!ref) return null;
        if (ref === 'stored') return namedSecrets.get(tenantId, 'settings', 'audit', 'webhook_secret');
        return ref.startsWith('env:') ? envRefs.read(tenantId, ref.slice(4)) : null;
      };
      out.push(new WebhookSink({ url: cfg.webhook.url, secret, fetch: outboundFetch!, now }));
    }
    if (cfg.otelLogs.enabled) {
      otelLogProvider ??= (input.otelLogProvider ?? createOtlpLogProvider)();
      out.push(new OtelLogsSink(await otelLogProvider));
    }
    return out;
  };
  const sinkDispatcher = new SinkDispatcher({ db: dbs.audit.db, store: auditStore, sinks: auditSinks, tenant: sinkTenant, clock, log: logger });
  closers.push(async () => {
    if (otelLogProvider) await (await otelLogProvider).shutdown().catch(() => {});
  });

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
  const runtime = new DbRuntimeConfigSource(db, clock, coord, { codeModeEnabled: (tenantId) => settings.get('codeModeEnabled', tenantId), codeLimitsCap: () => settings.get('codeLimitsCap') });
  const bus = new CoordinationEventBus(coord);
  runtime.subscribe(() => bus.publish({ kind: 'tools_list_changed' } as never));
  const rateLimitStore = coord.backend === 'postgres' && dbs.main.dialect === 'postgres' ? new LeaseRateLimitStore(new PgBucketExecutor(db), clock) : (coord.rateLimit ?? new MemoryRateLimitStore(clock));
  const limiter = new RateLimiter(rateLimitStore);
  const external = config.externalAs ? new ExternalJwtVerifier(config.externalAs) : null;
  const authenticator = new McpAuthenticator(db, clock, { pepper: config.hashPepper, external, resourceBase: { publicUrl: config.publicUrl, aliases: config.env.NEUROUTER_RESOURCE_ALIASES } }, coord);
  const tracker = new TaskTracker(db, now, (taskId, tenantId) => void coord.publish('events.task', { taskId, tenantId }).catch(() => {}));
  const errors = new ErrorEvents(db, now);
  const pages = new ResultPages(db, now);
  // mock state (multi-tenancy spec §7): in the database by default, so every instance shares it
  const mockStore: MockStateStore = config.env.NEUROUTER_MOCK_STORE === 'memory' ? new MemoryMockStateStore({ now }) : new DbMockStateStore(db, now);
  const mock = new InProcessMock({ store: mockStore });
  const mockNamespaces = new MockNamespaceBinder(db, now);
  // constructed early: the data plane's CredentialResolver reads delegated upstream tokens through it
  const isMember = async (tenantId: string, userId: string): Promise<boolean> => (await tenancy.roleOf(tenantId, userId)) !== null;
  const upstreamOAuth = new UpstreamOAuthService({ db, clock, envelope, coord, audit, secrets: namedSecrets.resolver(envRefs), fetch: (allowHttp) => upstreamFetchFor(allowHttp), publicUrl: config.publicUrl, pepper: config.hashPepper, isMember, log: logger });
  const credentials = new CredentialResolver(namedSecrets.resolver(envRefs), {
    clientCredentials: new ClientCredentialsCache(async (d, secret) => {
      const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: d.clientId ?? '', client_secret: secret, ...(d.scopes?.length ? { scope: d.scopes.join(' ') } : {}) });
      const res = await upstreamFetchFor(false)(d.tokenUrl ?? '', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
      if (!res.ok) throw new Error(`token endpoint answered ${res.status}`);
      return (await res.json()) as { access_token: string; expires_in?: number };
    }),
    upstreamTokens: (tenantId, environmentId, userId) => upstreamOAuth.token(tenantId, environmentId, userId),
    now,
  });
  const http = new HttpInvoker(upstreamFetchFor, now);
  const confirms = new ConfirmTokens(db, keyring, now);
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
    cursors: CursorCodec.fromKeyring(keyring, now),
    confirms,
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
    onInboxChanged: (tenantId) => void coord.publish('events.inbox', { tenantId }).catch(() => {}),
  });

  /* ---------------------------------------------------------------- code mode */
  let executor: Executor | null = input.executor !== undefined ? input.executor : null;
  let embedded: EmbeddedExecutor | null = null;
  const executorHealth = new ExecutorHealth(() => executor, metrics, logger);
  const startExecutor = async (): Promise<void> => {
    if (input.executor !== undefined) return;
    const mode = config.env.NEUROUTER_EXECUTOR_MODE;
    if (mode === 'off') return;
    // the boot was started by startServer before the DB setup (overlap), else here
    const r = await (input.executorBoot ?? bootExecutor(config, logger));
    executor = r.executor;
    if (executor && ext.executor) executor = ext.executor(executor);
    embedded = r.embedded;
    if (r.error === undefined) logger.info({ mode }, 'code-mode executor started');
    else logger.error({ err: r.error, mode }, 'code-mode executor failed to start; code mode is unavailable');
    await executorHealth.check();
  };
  const scripts = new ScriptRunner({ db, executor: () => executor, pipeline, ops, tracker, audit, pages, metrics, now, log: logger, healthy: () => executorHealth.healthy, confirms });
  const argValidator = new ArgValidator();
  const dispatcher = new Dispatcher({
    pipeline,
    ops,
    scripts,
    search,
    tracker,
    audit,
    args: argValidator,
    now,
    log: logger,
    onToolsChanged: () => bus.publish({ kind: 'tools_list_changed' } as never),
    // contract-2 envelopes that fail their own schema or budgets are bugs: fail loudly in tests, log in production
    strictEnvelopes: config.env.NODE_ENV === 'test',
  });

  /* ---------------------------------------------------------------- control plane */
  const builds = new BuildsService(db, dbs.main.dialect, clock, coord, { onBuild: () => indexer?.kick() });
  const servers = new ServersService(db, clock, coord, builds, audit, config.env.NEUROUTER_NEW_SERVER_CONTRACT);
  const fetchSpec = createSpecFetcher(outboundFetch);
  const introspectGraphql = createGraphqlIntrospector(outboundFetch);
  const configSync = new ConfigSync({ db, clock, coord, servers, settings, audit, fetchSpec, tenant: async () => (await tenancy.defaultTenant())?.id ?? null });
  const apiKeys = new ApiKeysService(db, clock, config.hashPepper, audit, coord);
  const users = new UsersService(db, clock, audit, config, async () => (await tenancy.defaultTenant())?.id ?? null);

  /* ---------------------------------------------------------------- MCP OAuth 2.1 AS + upstream OAuth broker (§13.3, §13.5) */
  const oauthClients = new OAuthClientsService(db, clock, new CimdResolver(outboundFetch, now), settings, config.hashPepper, audit, coord);
  const resourceBase = { publicUrl: config.publicUrl, aliases: config.env.NEUROUTER_RESOURCE_ALIASES };
  const oauthTokens = new OAuthTokensService(db, clock, coord, audit, { pepper: config.hashPepper, accessTtlSec: config.env.OAUTH_ACCESS_TOKEN_TTL_SEC, refreshTtlDays: config.env.OAUTH_REFRESH_TOKEN_TTL_DAYS, resourceBase });
  const consoleSessions: ConsoleSessionLookup = new DbSessionLookup(db, clock, { cookieName: config.cookieNames.session, idleMs: config.env.SESSION_IDLE_MINUTES * 60_000 });
  const authorization = new AuthorizationService(db, clock, oauthClients, oauthTokens, audit, { issuer: config.publicUrl, publicUrl: config.publicUrl, pepper: config.hashPepper, codeModeEnabled: (tenantId) => settings.get('codeModeEnabled', tenantId), isMember, tenancy, resourceAliases: config.env.NEUROUTER_RESOURCE_ALIASES, loginUrl: (r) => consoleSessions.loginUrl(r) });

  /* ---------------------------------------------------------------- evals (§15) */
  const localUrl = { value: config.publicUrl };
  const mockModelFor = async (tenant: string, environmentId: string): Promise<OpenApiMockModel | null> => {
    const b = await runtime.getByEnvironmentId(tenant, environmentId);
    const m = b?.build.mockModel() as OpenApiMockModel | GraphqlMockModel | null | undefined;
    return m && m.kind === 'openapi' ? m : null;
  };
  const evals = new EvalsService({
    db,
    clock,
    jobs,
    settings,
    secrets: namedSecrets,
    keys: apiKeys,
    servers,
    builds,
    auditStore,
    env: config.env as unknown as Record<string, string | undefined>,
    modelKeys,
    tenancy,
    defaultModel: config.env.NEUROUTER_EVAL_MODEL,
    metrics,
    log: logger,
    onProgress: (tenantId, runId, done, total) => void coord.publish('events.eval', { tenantId, runId, done, total }).catch(() => {}),
    ports: {
      evalArgs,
      baseUrl: () => localUrl.value,
      resetMock: (ns) => mockStore.reset(ns),
      mockSamples: async (ns, n) => {
        const m = await mockModelFor(ns.tenantId, ns.environmentId);
        if (!m) return {};
        return Object.fromEntries((await sampleEntities(m, mockStore, ns, n)).map((e) => [e.resource, e.items]));
      },
      mockState: (ns) => async (resource, scope, where) => {
        const m = await mockModelFor(ns.tenantId, ns.environmentId);
        const r = m ? (m.resources[resource] ?? Object.values(m.resources).find((x) => x.name === resource)) : undefined;
        if (!m || !r) return [];
        const sc = { ...Object.fromEntries(r.scopeParams.map((p) => [p, r.defaultScope[p] ?? 'demo'])), ...(scope ?? {}) };
        return (await mockStore.list(ns, r, sc)).filter((it) => Object.entries(where).every(([k, v]) => JSON.stringify((it as Record<string, unknown>)[k]) === JSON.stringify(v)));
      },
    },
  });

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
    config, logger, clock, dbs, coord, version: input.version,
    extensions: ext, tenancy, quotas, usage, secretRefs, modelKeys, envRefs,
    settings, keyring, metrics, auditStore, audit, sinkDispatcher, redactionRules: redactionRules!, envelope, secretProvider, namedSecrets, jobs, postCommit,
    outboundFetch, upstreamFetchFor, embedder, vectorIndex, indexer: indexer!, search,
    runtime, bus, limiter, authenticator, tracker, errors, pages, mock, mockStore, mockNamespaces, credentials, http, pipeline, ops, scripts, dispatcher,
    executor: () => executor, executorHealth, startExecutor,
    builds, servers, fetchSpec, introspectGraphql, configSync, apiKeys, users,
    oauthClients, oauthTokens, authorization, consoleSessions, upstreamOAuth,
    evals, localUrl,
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
  const existing = await db.selectFrom('examples').select(['id', 'success_count', 'args_hash']).where('tenant_id', '=', tenantId).where('server_id', '=', serverId).where('tool_name', '=', tool).where('kind', '=', 'call').execute();
  const hit = existing.find((e) => e.args_hash === shape);
  const t = Date.now();
  if (hit) {
    await db.updateTable('examples').set({ success_count: hit.success_count + 1, last_success_at: t }).where('id', '=', hit.id).where('tenant_id', '=', tenantId).execute();
    return;
  }
  if (existing.length >= 3) return;
  const safe = Object.fromEntries(Object.entries(args).filter(([k]) => !/(pass|secret|token|key|auth)/i.test(k)));
  await db.insertInto('examples').values({ id: newId(), tenant_id: tenantId, server_id: serverId, tool_name: tool, kind: 'call', arguments: toJsonColumn(safe), code: null, args_hash: shape, source: 'traffic', success_count: 1, last_success_at: t, build_hash: buildHash }).onConflict((oc) => oc.doNothing()).execute();
}
