import type { ContractVersion, OutputSchemaMode, Scope, TaskFraming, Via } from '@neurouter/shared';
import type { CallTrace } from '../../kernel/observability/tracing.js';
import type { RuntimeBundle } from '../../kernel/runtime-config.js';

export type Principal =
  | { type: 'api_key'; userId: string; apiKeyId: string; scopes: Scope[]; profile: string | null; purpose: 'user' | 'eval'; name: string; rateLimit: { perMinute: number; burst: number } | null }
  | { type: 'user'; userId: string; oauthTokenId: string; oauthClientId: string; scopes: Scope[]; familyId: string; name: string }
  | { type: 'external'; subject: string; issuer: string; scopes: Scope[]; bearer: string; name: string };

export interface ClientInfo {
  name: string | null;
  version: string | null;
  protocolVersion: string | null;
  era: 'modern' | 'legacy';
  caps: Record<string, unknown> | null;
}

/**
 * Where the traffic comes from: `eval` for the eval runner's per-attempt keys (`api_keys.purpose = 'eval'`),
 * `live` for everything else. Derived once at authentication (`originOf`). Eval traffic gets the same
 * agent-facing behaviour, but never feeds product signals: no inbox rows (unmet needs, issues, need
 * groups), no ops/task metrics, no `usage_daily`; tasks carry `tasks.origin`.
 */
export type TrafficOrigin = 'live' | 'eval';

export function originOf(p: Principal): TrafficOrigin {
  return p.type === 'api_key' && p.purpose === 'eval' ? 'eval' : 'live';
}

/** Fixed at authentication; never taken from tool arguments (§9.2). */
export interface RunContext {
  tenantId: string;
  server: { id: string; slug: string };
  environment: { id: string; slug: string; kind: 'dev' | 'qa' | 'prod' };
  principal: Principal;
  /** api_key id | oauth token family id | `ext:${iss}|${sub}` */
  credentialKey: string;
  /** Fixed at authentication from the principal (`originOf`). */
  origin: TrafficOrigin;
  client: ClientInfo;
  bundle: RuntimeBundle;
  taskId: string | null;
  /** Framing of the resolved task (one-time begin_task tip for inferred tasks). */
  framing?: TaskFraming | null;
  via: Via;
  mode: 'tool' | 'code';
  scriptRunId?: string;
  dryRun?: boolean;
  /** Execute run bound to an approved plan (prod code mode, §9.7): `${tool}|${argsHash}` pairs. */
  approvedPlan?: Set<string>;
  traceparent: string | null;
  /** Gateway span of the MCP request (audit `span_id`); inner script calls share it. */
  spanId?: string | null;
  /** The request's trace (tools/call): upstream calls run in their own client span under it. */
  trace?: CallTrace;
  ip: string | null;
  userAgent: string | null;
  /** Mock state namespace name (`MockNs.name`) when not `env`: an accepted eval/gen `X-Neurouter-Mock-State` (G13), or a console preview. */
  mockNamespace?: string;
  /** Exposure override (`X-Neurouter-Exposure: tools|code`), any credential; code falls back to tools when unavailable. */
  exposureOverride?: 'tools' | 'code';
  /** Eval reference session (`X-Neurouter-Reference`, eval keys): results without the overlay `include` projection (B7), and no rate limits (ground truth). */
  fullObjects?: boolean;
  /** Negotiated agent contract of the session (contract-v2 §1); absent = 1 (console and internal callers). */
  contract?: ContractVersion;
  /** `exposure.outputSchema` in effect for this session. */
  outputSchema?: OutputSchemaMode;
  requestId: string;
}

export const RC_KEY = 'neurouter.rc';

export function principalUserId(p: Principal): string | null {
  return p.type === 'external' ? null : p.userId;
}

export function principalId(p: Principal): string {
  return p.type === 'api_key' ? p.apiKeyId : p.type === 'user' ? p.userId : `${p.issuer}|${p.subject}`;
}

/** W3C traceparent → trace id. */
export function traceIdOf(traceparent: string | null | undefined): string | null {
  const m = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/.exec(traceparent?.trim().toLowerCase() ?? '');
  return m && !/^0+$/.test(m[1]!) ? m[1]! : null;
}
