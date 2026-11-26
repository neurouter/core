import type { FastifyInstance } from 'fastify';
import type { ToolDef } from '@neurouter/shared';
import type { Services } from './deps.js';
import { newId } from './kernel/lib/ids.js';
import type { RuntimeBundle } from './kernel/runtime-config.js';
import { apiToolEntry } from './dataplane/mcp/surface.js';
import type { RunContext } from './dataplane/pipeline/context.js';
import { LocalLinkService } from './controlplane/auth/local-link.js';
import { LoginService } from './controlplane/auth/login.js';
import { OpenIdClientProvider, type OidcProvider } from './controlplane/auth/oidc.js';
import { SessionService } from './controlplane/auth/sessions.js';
import { embedderView, type ApiContext } from './controlplane/api/context.js';
import { apiPlugin } from './controlplane/api/plugin.js';
import type { ConsolePorts } from './controlplane/api/ports.js';
import { Views } from './controlplane/api/views.js';

/**
 * Console wiring (composition root, like `deps.ts`): builds the control plane's ApiContext and the
 * data-plane ports it is allowed to use (search, agent view, environment tests, mock reset).
 */
export function buildApiContext(s: Services, opts: { oidcProvider?: OidcProvider | null } = {}): ApiContext {
  const { config } = s;
  const sessions = new SessionService(s.dbs.main.db, s.clock, {
    cookieName: config.cookieNames.session,
    secure: config.publicUrl.startsWith('https://'),
    ttlMs: config.env.SESSION_TTL_HOURS * 3_600_000,
    idleMs: config.env.SESSION_IDLE_MINUTES * 60_000,
  });
  const oidcProvider: OidcProvider | null =
    opts.oidcProvider !== undefined
      ? opts.oidcProvider
      : config.env.OIDC_ISSUER && config.env.OIDC_CLIENT_ID && config.env.OIDC_CLIENT_SECRET
        ? new OpenIdClientProvider({ issuer: config.env.OIDC_ISSUER, clientId: config.env.OIDC_CLIENT_ID, clientSecret: config.env.OIDC_CLIENT_SECRET, allowInsecure: !config.isProduction && config.env.OIDC_ISSUER.startsWith('http://') })
        : null;
  const login = new LoginService(
    s.dbs.main.db,
    s.clock,
    s.envelope,
    s.users,
    s.audit,
    { redirectUri: `${config.publicUrl}/api/auth/oidc/callback`, scopes: config.env.OIDC_SCOPES, groupsClaim: config.env.OIDC_GROUPS_CLAIM, adminGroups: config.env.OIDC_ADMIN_GROUPS, defaultRole: config.env.OIDC_DEFAULT_ROLE, allowedEmailDomains: config.env.OIDC_ALLOWED_EMAIL_DOMAINS },
    oidcProvider,
  );
  const links = new LocalLinkService(s.dbs.main.db, s.clock, s.users, s.audit, config.publicUrl);
  const views = new Views(s.dbs.main.db, config.publicUrl, s.namedSecrets, s.tenantId);

  const adminCtx = (bundle: RuntimeBundle, userId: string): RunContext => ({
    tenantId: bundle.tenantId,
    server: { id: bundle.server.id, slug: bundle.server.slug },
    environment: { id: bundle.environment.id, slug: bundle.environment.slug, kind: bundle.environment.kind },
    principal: { type: 'user', userId, oauthTokenId: '', oauthClientId: '', scopes: ['tools:read', 'tools:write', 'code:run'], familyId: `console:${userId}`, name: 'console' },
    credentialKey: `console:${userId}`,
    client: { name: 'neurouter-console', version: s.version, protocolVersion: null, era: 'modern', caps: null },
    bundle,
    taskId: null,
    via: 'console',
    mode: 'tool',
    traceparent: null,
    ip: null,
    userAgent: null,
    requestId: newId(),
  });
  const bundleOf = async (environmentId: string) => {
    const b = await s.runtime.getByEnvironmentId(s.tenantId, environmentId);
    if (!b) throw new Error('environment has no active build');
    return b;
  };

  const ports: ConsolePorts = {
    async searchTools(environmentId, q, format, limit) {
      const ctx = adminCtx(await bundleOf(environmentId), 'console');
      const res = await s.dispatcher.search(ctx, q, limit, format, true);
      return { tools: res.tools as unknown as Array<Record<string, unknown>>, totalVisible: res.totalVisible, mode: res.mode, ...(res.tools.length ? {} : { hint: 'No tool matches. If the user needs something this API cannot do, call neurouter_report_unmet_need.' }) };
    },
    async agentEntry(tool: ToolDef, environmentId) {
      if (!environmentId) return { name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema };
      const ctx = adminCtx(await bundleOf(environmentId), 'console');
      return apiToolEntry(ctx, tool) as unknown as Record<string, unknown>;
    },
    async testEnvironment(environmentId, toolName, args, userId) {
      const bundle = await bundleOf(environmentId);
      const env = bundle.environment;
      const credential = await s.credentials.presence(env.auth, env.id);
      if (!toolName) {
        if (env.isMock) return { ok: true, latencyMs: 0, credential: 'not_required' };
        const t0 = s.clock.now();
        try {
          const res = await s.upstreamFetchFor(env.allowHttp)(env.baseUrl, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
          return { ok: res.status < 500, latencyMs: s.clock.now() - t0, status: res.status, credential: credential === 'missing' ? 'missing' : res.status === 401 || res.status === 403 ? 'rejected' : credential };
        } catch (err) {
          return { ok: false, latencyMs: null, credential, detail: (err as Error).message.slice(0, 300) };
        }
      }
      const tool = bundle.build.tools.find((t) => t.name === toolName && !t.hidden);
      if (!tool) return { ok: false, latencyMs: null, credential, detail: `Unknown tool ${toolName}` };
      if (tool.risk.write) return { ok: false, latencyMs: null, credential, detail: 'Test calls are limited to read tools' };
      const t0 = s.clock.now();
      const out = await s.pipeline.invoke(adminCtx(bundle, userId), toolName, args ?? {});
      const status = out.error?.code === 'upstream_auth' ? 'rejected' : credential;
      return { ok: out.ok, latencyMs: s.clock.now() - t0, credential: status, ...(out.ok ? { result: out.value } : { detail: out.error?.message ?? out.status }) };
    },
    resetMock(environmentId, seed) {
      s.mock.reset(`env:${environmentId}`, seed);
    },
    async mockSample(environmentId, tool) {
      const bundle = await bundleOf(environmentId);
      if (!bundle.environment.isMock || tool.risk.write) return null;
      const args = tool.examples[0]?.arguments ?? {};
      const out = await s.pipeline.invoke({ ...adminCtx(bundle, 'console'), mockNamespace: `preview:${environmentId}` }, tool.name, args);
      return out.ok ? out.value : null;
    },
    executorStatus() {
      const last = s.executorHealth.last;
      return { mode: config.env.NEUROUTER_EXECUTOR_MODE, ok: s.executorHealth.healthy, montyVersion: last?.montyVersion || null, poolMax: last?.poolSize ?? config.env.NEUROUTER_EXECUTOR_POOL_MAX, busy: last?.busy ?? 0, detail: last?.detail ?? null };
    },
  };

  return {
    config,
    logger: s.logger,
    clock: s.clock,
    dbs: s.dbs,
    coord: s.coord,
    tenantId: s.tenantId,
    version: s.version,
    settings: s.settings,
    audit: s.audit,
    auditStore: s.auditStore,
    jobs: s.jobs,
    namedSecrets: s.namedSecrets,
    runtime: s.runtime,
    servers: s.servers,
    builds: s.builds,
    fetchSpec: s.fetchSpec,
    configSync: s.configSync,
    apiKeys: s.apiKeys,
    users: s.users,
    sessions,
    login,
    oidcProvider,
    links,
    views,
    ports,
    embedderStatus: () => embedderView(s.embedder.status()),
    embedderModel: config.env.EMBEDDINGS_ENABLED ? config.env.EMBEDDINGS_MODEL : null,
    coordinationBackend: s.coord.backend,
    instanceId: config.instanceId,
    postCommit: s.postCommit,
    evals: s.evals,
  };
}

/** The console `/api` + `/public` plugin for `routePlugins`. */
export function consolePlugin(s: Services, ctx?: ApiContext): (app: FastifyInstance) => Promise<void> {
  const c = ctx ?? buildApiContext(s);
  return (app) => apiPlugin(app, c);
}

/** One-time console sign-in URL (CLI `console-link`, first-start banner). */
export async function mintConsoleLink(s: Services): Promise<string> {
  return (await new LocalLinkService(s.dbs.main.db, s.clock, s.users, s.audit, s.config.publicUrl).create()).url;
}
