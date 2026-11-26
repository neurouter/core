import type { TenantResolver } from '../../kernel/tenancy/types.js';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { createMcpHandler, inputRequired, inputResponse, ProtocolError, Server, type McpHttpHandler, type McpRequestContext, type ServerContext, type ServerEventBus } from '@modelcontextprotocol/server';
import { CONTRACT_VERSIONS, HEADER_BUILD, HEADER_CONTRACT, HEADER_EXPOSURE, HEADER_MOCK_STATE, HEADER_REFERENCE, META_CONTRACT, META_TASK_ID, type ContractVersion } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import { newId } from '../../kernel/lib/ids.js';
import type { Keyring } from '../../kernel/secrets/keyring.js';
import { contractSetting, outputSchemaSetting, type RuntimeBundle, type RuntimeConfigSource } from '../../kernel/runtime-config.js';
import type { McpAuthenticator } from '../auth/authenticate.js';
import type { MockNamespaceBinder } from '../mock/namespace.js';
import { originOf, RC_KEY, traceIdOf, type ClientInfo, type Principal, type RunContext, type TrafficOrigin } from '../pipeline/context.js';
import type { Confirmer, ConfirmOutcome, Pipeline } from '../pipeline/pipeline.js';
import type { TaskTracker } from '../tasks/tracker.js';
import { startCallTrace } from '../../kernel/observability/tracing.js';
import { bearerChallenge, protectedResourceMetadata } from './challenge.js';
import type { Dispatcher } from './dispatch.js';
import { InflightCalls, inspectJsonRpc, LegacyClientInfo } from './inflight.js';
import { originAllowed } from './origin.js';
import { buildSurface, instructions } from './surface.js';
import { RequestStateError, unwrapConfirmState, wrapConfirmState } from './translate.js';

const ENVELOPE_CAPS = 'io.modelcontextprotocol/clientCapabilities';
const ENVELOPE_CLIENT = 'io.modelcontextprotocol/clientInfo';
const ENVELOPE_VERSION = 'io.modelcontextprotocol/protocolVersion';
const CONFIRM_TTL_MS = 10 * 60_000;
const CONFIRM_KEY = 'neurouter_confirm';

export interface McpRouteDeps {
  publicUrl: string;
  allowedOrigins: readonly string[];
  version: string;
  runtime: RuntimeConfigSource;
  authenticator: McpAuthenticator;
  pipeline: Pipeline;
  dispatcher: Dispatcher;
  tracker: TaskTracker;
  audit: AuditRecorder;
  keyring: Keyring;
  bus: ServerEventBus;
  executorHealthy: () => boolean;
  /** Pinned-by-usage tools per environment (top-N by 7-day calls, §9.4). */
  usagePinned?: (environmentId: string) => string[];
  nativeSearchClients?: () => string[];
  externalIssuer?: string | null;
  keepAliveMs?: number;
  now: () => number;
  onAuthFailure?: (reason: string, method: 'api_key' | 'oauth' | 'external') => void;
  inflight?: InflightCalls;
  legacyClients?: LegacyClientInfo;
  /** Request → tenant (spec §3.2). */
  tenancy: Pick<TenantResolver, 'forMcp'>;
  /** `NEUROUTER_MAINTENANCE`: 503 on every MCP request. */
  maintenance?: () => boolean;
  /** Accepts the eval mock-state header only when bound to this tenant/environment/run (G13). */
  mockNamespaces: MockNamespaceBinder;
}

/** What the HTTP layer hands the SDK factory (per HTTP request). */
interface RequestCtx {
  bundle: RuntimeBundle;
  principal: Principal;
  credentialKey: string;
  origin: TrafficOrigin;
  ip: string;
  userAgent: string | null;
  traceparent: string | null;
  legacyClient: { name: string | null; version: string | null; protocolVersion: string | null; capabilities?: Record<string, unknown> | null } | null;
  mockNamespace?: string;
  exposureOverride?: 'tools' | 'code';
  /** eval reference session (`X-Neurouter-Reference: 1`, eval keys only): full objects */
  fullObjects?: boolean;
  /** `X-Neurouter-Contract` (contract negotiation) */
  contractHeader?: string;
  /** client capabilities of a 2026-07-28 request envelope, seen before the SDK (negotiation in the factory) */
  envelopeCaps?: Record<string, unknown> | null;
  /** `Mcp-Session-Id` (contract 2 infers one task per session, D1) */
  sessionId?: string;
}

/**
 * Contract negotiation (contract-v2 §1): the client capability `experimental["dev.neurouter/contract"] =
 * {"versions":[2,1]}`, else the `X-Neurouter-Contract` header (`2` or `2,1`), picks the highest version both
 * sides support; neither (or nothing in common) → the environment/server setting.
 */
export function negotiateContract(b: Pick<RuntimeBundle, 'server' | 'environment'>, caps: Record<string, unknown> | null | undefined, headerValue: string | undefined): ContractVersion {
  const exp = caps?.experimental && typeof caps.experimental === 'object' ? (caps.experimental as Record<string, unknown>)[META_CONTRACT] : undefined;
  const fromCaps = exp && typeof exp === 'object' && Array.isArray((exp as { versions?: unknown }).versions) ? ((exp as { versions: unknown[] }).versions as unknown[]) : null;
  const fromHeader = headerValue ? headerValue.split(',').map((x) => Number(x.trim())) : null;
  for (const offered of [fromCaps, fromHeader]) {
    if (!offered) continue;
    const common = CONTRACT_VERSIONS.filter((v) => offered.includes(v));
    if (common.length) return common[0]!;
  }
  return contractSetting(b);
}

function header(req: FastifyRequest, name: string): string | undefined {
  const v = req.headers[name];
  return Array.isArray(v) ? v[0] : v;
}

function clientInfo(c: ServerContext, server: Server, era: 'modern' | 'legacy', rc: RequestCtx): ClientInfo {
  const env = ((c.mcpReq as unknown as { envelope?: Record<string, unknown> }).envelope ?? {}) as Record<string, unknown>;
  const ci = (env[ENVELOPE_CLIENT] as { name?: string; version?: string } | undefined) ?? server.getClientVersion() ?? (rc.legacyClient ? { name: rc.legacyClient.name ?? undefined, version: rc.legacyClient.version ?? undefined } : undefined);
  return {
    name: ci?.name ? String(ci.name).slice(0, 200) : null,
    version: ci?.version ? String(ci.version).slice(0, 100) : null,
    protocolVersion: (env[ENVELOPE_VERSION] as string | undefined) ?? server.getNegotiatedProtocolVersion() ?? rc.legacyClient?.protocolVersion ?? null,
    era,
    caps: (env[ENVELOPE_CAPS] as Record<string, unknown> | undefined) ?? (server.getClientCapabilities() as Record<string, unknown> | undefined) ?? rc.legacyClient?.capabilities ?? null,
  };
}

/**
 * Builds the per-request RunContext (§9.2): tenant, server, environment and principal come only
 * from the authenticated request; the task is resolved per request (§12.1).
 */
async function runContext(d: McpRouteDeps, rc: RequestCtx, c: ServerContext, server: Server, era: 'modern' | 'legacy', createTask: boolean): Promise<RunContext> {
  const b = rc.bundle;
  const client = clientInfo(c, server, era, rc);
  const meta = ((c.mcpReq as unknown as { _meta?: Record<string, unknown> })._meta ?? {}) as Record<string, unknown>;
  const metaTask = typeof meta[META_TASK_ID] === 'string' ? (meta[META_TASK_ID] as string) : null;
  const tp = typeof meta.traceparent === 'string' ? meta.traceparent : rc.traceparent;
  const p = rc.principal;
  const contract = negotiateContract(b, client.caps ?? rc.envelopeCaps, rc.contractHeader);
  const owner = {
    tenantId: b.tenantId,
    serverId: b.server.id,
    environmentId: b.environment.id,
    credentialKey: rc.credentialKey,
    clientName: client.name,
    clientVersion: client.version,
    principalType: p.type,
    userId: p.type === 'external' ? null : p.userId,
    apiKeyId: p.type === 'api_key' ? p.apiKeyId : null,
    oauthClientId: p.type === 'user' ? p.oauthClientId : null,
    traceId: traceIdOf(tp),
    origin: rc.origin,
    // contract 2 (D1): tasks are inferred per (credential, client, MCP session) with the idle gap
    ...(contract === 2 && rc.sessionId ? { sessionKey: rc.sessionId.slice(0, 200) } : {}),
  };
  const task = await d.tracker.resolve(owner, metaTask, { create: createTask });
  return {
    tenantId: b.tenantId,
    server: { id: b.server.id, slug: b.server.slug },
    environment: { id: b.environment.id, slug: b.environment.slug, kind: b.environment.kind },
    principal: p,
    credentialKey: rc.credentialKey,
    origin: rc.origin,
    client,
    bundle: b,
    taskId: task.taskId,
    framing: task.framing,
    via: rc.origin === 'eval' ? 'eval' : 'direct',
    mode: 'tool',
    traceparent: tp,
    ip: rc.ip,
    userAgent: rc.userAgent,
    requestId: newId(),
    ...(rc.mockNamespace ? { mockNamespace: rc.mockNamespace } : {}),
    ...(rc.exposureOverride ? { exposureOverride: rc.exposureOverride } : {}),
    ...(rc.fullObjects ? { fullObjects: true } : {}),
    contract,
    outputSchema: outputSchemaSetting(b),
  };
}

/**
 * Prod write confirmation (§9.7). Modern clients with the elicitation capability: an MRTR
 * `input_required` result whose `requestState` is AES-GCM-wrapped and bound to
 * `(tool, argsHash, credentialKey, exp)`; legacy clients: `elicitInput` on the held SSE stream.
 */
function makeConfirmer(d: McpRouteDeps, ctx: RunContext, c: ServerContext): Confirmer | null {
  const caps = ctx.client.caps ?? {};
  const canElicit = Boolean((caps as Record<string, unknown>).elicitation);
  if (!canElicit) return null;
  const mcpReq = c.mcpReq as unknown as { requestState?: <T>() => T | undefined; inputResponses?: Record<string, unknown> };
  const schema = { type: 'object' as const, properties: { approve: { type: 'boolean' as const, title: 'Approve this change' } }, required: ['approve'] };
  return {
    confirm: async ({ tool, argsHash, message }): Promise<ConfirmOutcome> => {
      // Deviation (§9.7 legacy path): a stateless server cannot receive the client's answer to a
      // server-initiated elicitInput (it arrives as a separate POST with no session; the SDK's
      // per-request legacy serving cannot receive server-to-client requests), so 2025-era clients are
      // treated as not elicitation-capable: `elicit` returns the planned change unexecuted,
      // `deny_without_elicitation` refuses.
      if (ctx.client.era === 'legacy') return { status: 'unsupported' };
      const raw = mcpReq.requestState?.<unknown>();
      if (typeof raw === 'string') {
        try {
          const st = unwrapConfirmState(d.keyring, raw, d.now());
          if (st.tool !== tool.name || st.argsHash !== argsHash || st.credentialKey !== ctx.credentialKey) throw new RequestStateError('binding mismatch');
          const resp = inputResponse(mcpReq.inputResponses, CONFIRM_KEY);
          if (resp.kind === 'elicit' && resp.action === 'accept' && resp.content?.approve === true) return { status: 'approved' };
          return { status: 'declined' };
        } catch (err) {
          throw new ProtocolError(-32602, (err as Error).message);
        }
      }
      const requestState = wrapConfirmState(d.keyring, { tool: tool.name, argsHash, credentialKey: ctx.credentialKey, exp: d.now() + CONFIRM_TTL_MS });
      return { status: 'pending', result: inputRequired({ inputRequests: { [CONFIRM_KEY]: inputRequired.elicit({ message, requestedSchema: schema } as never) }, requestState }) };
    },
  };
}

export function buildServerFactory(d: McpRouteDeps) {
  return (mctx: McpRequestContext): Server => {
    const rc = (mctx.authInfo?.extra as Record<string, unknown> | undefined)?.[RC_KEY] as RequestCtx | undefined;
    if (!rc) throw new Error('unauthenticated MCP request reached the server factory');
    const b = rc.bundle;
    // instructions depend on the principal's surface; compute a provisional one without client info
    const provisional: RunContext = {
      tenantId: b.tenantId,
      server: { id: b.server.id, slug: b.server.slug },
      environment: { id: b.environment.id, slug: b.environment.slug, kind: b.environment.kind },
      principal: rc.principal,
      credentialKey: rc.credentialKey,
      origin: rc.origin,
      client: { name: rc.legacyClient?.name ?? null, version: null, protocolVersion: null, era: mctx.era, caps: null },
      bundle: b,
      taskId: null,
      via: 'direct',
      mode: 'tool',
      traceparent: rc.traceparent,
      ip: rc.ip,
      userAgent: rc.userAgent,
      requestId: newId(),
      ...(rc.exposureOverride ? { exposureOverride: rc.exposureOverride } : {}),
      contract: negotiateContract(b, rc.legacyClient?.capabilities ?? rc.envelopeCaps, rc.contractHeader),
      outputSchema: outputSchemaSetting(b),
    };
    const surfaceOpts = { executorHealthy: d.executorHealthy(), usagePinned: d.usagePinned?.(b.environment.id) ?? [], nativeSearchClients: d.nativeSearchClients?.() ?? [], typedIssues: d.dispatcher.typedIssues };
    const provisionalSurface = buildSurface(provisional, surfaceOpts);
    // contract 2 reports the active version in serverInfo._meta (contract-v2 §1); contract 1 keeps the 0.2.x serverInfo
    const server = new Server(
      { name: `neurouter-${b.server.slug}`, title: `${b.server.name} via Neurouter`, version: d.version, ...(provisional.contract === 2 ? { _meta: { [META_CONTRACT]: 2 } } : {}) } as never,
      { capabilities: { tools: { listChanged: true } }, instructions: instructions(provisional, provisionalSurface), cacheHints: { 'tools/list': { ttlMs: 60_000, cacheScope: 'private' } } } as never,
    );
    server.setRequestHandler('tools/list', async (_req, c) => {
      const ctx = await runContext(d, rc, c as ServerContext, server, mctx.era, false);
      const surface = buildSurface(ctx, surfaceOpts);
      d.audit.record({ ...d.pipeline.auditBase(ctx), kind: 'tools_list', decision: 'allowed', status: 'ok', output: { count: surface.tools.length, mode: surface.mode, discovery: surface.discovery } });
      return { tools: surface.tools.map((t) => structuredClone(t)) as never };
    });
    server.setRequestHandler('tools/call', async (req, c) => {
      const base = await runContext(d, rc, c as ServerContext, server, mctx.era, true);
      // gateway span `tools/call {tool}` (§10.5): parent from params._meta.traceparent, else the HTTP header
      const meta = ((c as ServerContext).mcpReq as unknown as { _meta?: Record<string, unknown> })._meta ?? {};
      const span = startCallTrace({
        method: 'tools/call',
        toolName: req.params.name,
        metaTraceparent: typeof meta.traceparent === 'string' ? meta.traceparent : null,
        metaTracestate: typeof meta.tracestate === 'string' ? meta.tracestate : null,
        httpTraceparent: rc.traceparent,
        protocolVersion: base.client.protocolVersion,
      });
      const ctx: RunContext = { ...base, traceparent: span.traceparent, spanId: span.spanId, trace: span };
      let error: string | null = null;
      try {
        const surface = buildSurface(ctx, surfaceOpts);
        const confirmer = makeConfirmer(d, ctx, c as ServerContext);
        const signal = (c as unknown as { mcpReq: { signal?: AbortSignal } }).mcpReq.signal;
        const out = await d.dispatcher.call(ctx, req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>, surface, confirmer, signal);
        // contract 1 only: contract 2 answers unknown tools with an envelope
        if (out.kind === 'unknown') {
          error = 'unknown_tool';
          throw new ProtocolError(-32602, out.message);
        }
        if (out.kind === 'input_required') {
          if (ctx.client.era !== 'modern') throw new ProtocolError(-32603, 'confirmation requires the 2026-07-28 protocol');
          return out.result as never;
        }
        if ((out.result as { isError?: boolean }).isError) error = 'tool_error';
        return server.projectCallToolResult(out.result as never, undefined);
      } catch (err) {
        error ??= (err as Error).name || 'Error';
        throw err;
      } finally {
        span.end({ error });
      }
    });
    return server;
  };
}

/**
 * `/mcp/{server}/{env}` (§9.1; ADAPT Hub gateway/mcp-route.ts): Origin check → bearer auth with
 * per-endpoint PRM challenge → SDK handler (stateless, `sse` for tools/call by `Mcp-Method`, else
 * `auto`). Unknown server/env → 404 after authentication; disabled env → 503.
 */
export async function mcpRoutes(app: FastifyInstance, d: McpRouteDeps): Promise<{ handlers: McpHttpHandler[] }> {
  const factory = buildServerFactory(d);
  const inflight = d.inflight ?? new InflightCalls();
  const legacyClients = d.legacyClients ?? new LegacyClientInfo();
  const common = { legacy: 'stateless' as const, bus: d.bus, keepAliveMs: d.keepAliveMs ?? 15_000, maxRequestBodySize: 4 * 1024 * 1024 };
  const callHandler = createMcpHandler(factory, { ...common, responseMode: 'sse' });
  const defaultHandler = createMcpHandler(factory, { ...common, responseMode: 'auto' });

  app.get<{ Params: { server: string; env: string } }>('/.well-known/oauth-protected-resource/mcp/:server/:env', async (req, reply) =>
    reply.header('cache-control', 'public, max-age=3600').header('access-control-allow-origin', '*').send(protectedResourceMetadata(d.publicUrl, req.params.server, req.params.env, d.externalIssuer)),
  );

  await app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'string', bodyLimit: 4 * 1024 * 1024 }, (_req, body, done) => done(null, body));

    const handle = async (req: FastifyRequest<{ Params: { server: string; env: string } }>, reply: FastifyReply) => {
      const { server: serverSlug, env: envSlug } = req.params;
      if (!originAllowed(header(req, 'origin'), d.publicUrl, d.allowedOrigins)) {
        return reply.status(403).type('application/json').send({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Origin not allowed' } });
      }
      const challenge = (error?: 'invalid_token' | 'insufficient_scope') => bearerChallenge(d.publicUrl, serverSlug, envSlug, error);
      const authz = header(req, 'authorization');
      // maintenance window (spec §11 M3): no MCP traffic while the database is being moved
      if (d.maintenance?.()) return reply.status(503).header('retry-after', '120').type('application/json').send({ error: 'maintenance', error_description: 'Neurouter is in maintenance; retry shortly' });
      // the tenant comes from the resolver (legacy 2-segment route: the deployment's default tenant), never a constant (spec §3.2)
      const tenant = await d.tenancy.forMcp({ tenantSlug: null, serverSlug, envSlug });
      const bundle = tenant ? await d.runtime.get(tenant.id, serverSlug, envSlug) : null;
      if (!bundle) {
        if (!authz) return reply.status(401).header('www-authenticate', challenge()).type('application/json').send({ error: 'unauthorized', error_description: 'Authentication required' });
        return reply.status(404).type('application/json').send({ error: 'not_found' });
      }
      const resourceUri = `${d.publicUrl}/mcp/${serverSlug}/${envSlug}`;
      const auth = await d.authenticator.authenticate(authz, { tenantId: bundle.tenantId, serverId: bundle.server.id, environmentId: bundle.environment.id, resourceUri }, { ip: req.ip });
      if (!auth.ok) {
        d.onAuthFailure?.(auth.reason, /^bearer\s+nrk_at_/i.test(authz ?? '') ? 'oauth' : /^bearer\s+nrk_/i.test(authz ?? '') ? 'api_key' : 'external');
        const status = auth.error === 'insufficient_scope' ? 403 : 401;
        return reply
          .status(status)
          .header('www-authenticate', challenge(auth.error === 'missing_token' ? undefined : auth.error))
          .type('application/json')
          .send({ error: auth.error === 'missing_token' ? 'unauthorized' : auth.error, error_description: auth.error === 'missing_token' ? 'Authentication required' : 'The access token is invalid or not permitted' });
      }
      if (bundle.environment.status !== 'active' || bundle.server.status !== 'active') return reply.status(503).type('application/json').send({ error: 'environment_disabled' });

      const ua = header(req, 'user-agent');
      const body = req.method === 'POST' ? ((req.body as string | undefined) ?? '') : undefined;
      const sessionId = header(req, 'mcp-session-id') ?? null;
      const rpc = inspectJsonRpc(body);
      if (rpc.initialize) legacyClients.remember(auth.credentialKey, sessionId, rpc.initialize);
      for (const id of rpc.cancels) void inflight.cancel(auth.credentialKey, id).catch(() => {});
      const origin = originOf(auth.principal);
      const isEval = origin === 'eval';
      const mockNs = await d.mockNamespaces.bind(header(req, HEADER_MOCK_STATE), { tenantId: bundle.tenantId, environmentId: bundle.environment.id, principal: auth.principal });
      // any credential may narrow its own surface (console "code mode only" snippets); code still needs
      // code mode to be available (env codeMode, code:run scope, kill switches, executor), see effectiveMode
      const exp = header(req, HEADER_EXPOSURE)?.trim().toLowerCase();
      const buildOverride = isEval ? header(req, HEADER_BUILD) : undefined;
      const effective = buildOverride ? await d.runtime.withBuild(bundle, buildOverride) : bundle;
      if (!effective) return reply.status(404).type('application/json').send({ error: 'build_not_found' });
      const rc: RequestCtx = {
        bundle: effective,
        principal: auth.principal,
        credentialKey: auth.credentialKey,
        origin,
        ip: req.ip,
        userAgent: ua ? ua.slice(0, 512) : null,
        traceparent: header(req, 'traceparent') ?? null,
        legacyClient: legacyClients.get(auth.credentialKey, sessionId),
        ...(mockNs !== 'env' ? { mockNamespace: mockNs } : {}),
        ...(exp === 'tools' || exp === 'code' ? { exposureOverride: exp } : {}),
        ...(isEval && header(req, HEADER_REFERENCE) === '1' ? { fullObjects: true } : {}),
        ...(header(req, HEADER_CONTRACT) ? { contractHeader: header(req, HEADER_CONTRACT)!.slice(0, 20) } : {}),
        ...(rpc.envelopeCaps ? { envelopeCaps: rpc.envelopeCaps } : {}),
        ...(sessionId ? { sessionId } : {}),
      };
      const abort = new AbortController();
      const releases = rpc.calls.map((id) => inflight.register(auth.credentialKey, id, abort));
      const release = () => {
        for (const r of releases.splice(0)) r();
      };
      reply.raw.once('close', () => {
        if (!reply.raw.writableEnded) abort.abort(new Error('client disconnected'));
        release();
      });
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || k === 'host' || k === 'connection' || k === 'content-length') continue;
        headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      }
      const request = new Request(new URL(req.url, d.publicUrl), { method: req.method, headers, signal: abort.signal, ...(body !== undefined ? { body } : {}) });
      const handler = header(req, 'mcp-method') === 'tools/call' ? callHandler : defaultHandler;
      let res: Response;
      try {
        res = await handler.fetch(request, { authInfo: { token: '', clientId: auth.credentialKey, scopes: auth.principal.scopes, resource: new URL(resourceUri), extra: { [RC_KEY]: rc } } as never });
      } catch (err) {
        release();
        throw err;
      }
      reply.status(res.status);
      res.headers.forEach((value, key) => {
        if (key !== 'content-length') reply.header(key, value);
      });
      if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) reply.header('x-accel-buffering', 'no').header('cache-control', 'no-cache, no-transform');
      if (!res.body) {
        release();
        return reply.send();
      }
      return reply.send(Readable.fromWeb(res.body as never));
    };
    scope.post('/mcp/:server/:env', handle);
    scope.get('/mcp/:server/:env', handle);
    scope.delete('/mcp/:server/:env', handle);
  });
  return { handlers: [callHandler, defaultHandler] };
}
