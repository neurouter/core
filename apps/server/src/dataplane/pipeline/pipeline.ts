import { GRAPHQL_ACCEPT, MOCK_PAGING_HEADER, shapeResponse, wrapStructured } from '@neurouter/compiler';
import {
  META_CALL_ID,
  META_DRY_RUN,
  META_GRAPHQL_ERRORS,
  META_NEXT_TOOLS,
  META_PLANNED_CHANGES,
  META_RESULT_HANDLE,
  META_RETRY_AFTER_MS,
  META_TASK_ID,
  META_TRUNCATED,
  META_UNTRUSTED,
  META_UPSTREAM_HEADERS,
  type AuditDecision,
  type AuditStatus,
  type ErrorCode,
  type PolicyStepName,
  type PolicyStepResult,
  type ToolDef,
} from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { AuditEventInput } from '../../kernel/audit/types.js';
import { hashCanonical } from '../../kernel/lib/jcs.js';
import { newId } from '../../kernel/lib/ids.js';
import type { Metrics } from '../../kernel/observability/metrics.js';
import type { CredentialResolver } from '../http/credentials.js';
import { InvokeError, type HttpInvoker, type MockUpstream, type UpstreamResponse } from '../http/invoker.js';
import { buildHttpRequest, RequestBuildError, toSpecArgs, applyArgTransforms, hostAllowed } from '../http/request-builder.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import type { ResultPages } from '../shaping/result-pages.js';
import { looksLikeInjection, scanUntrusted, UNTRUSTED_PREFIX } from '../shaping/sanitize.js';
import { errorDraft, okDraft, type Draft, type ErrorSpec } from '../envelope/draft.js';
import { clippedView, isListTool, listView, untrustedPaths, type ListPaging } from '../envelope/page.js';
import { CursorError, isNeurouterCursor, type CursorBinding, type CursorCodec, type CursorPayload } from '../paging/cursor.js';
import { projectFields } from '../paging/fields.js';
import { applyPosition, boundArgs, itemsOf, nextSignals, pagingPlan, splitArgs, type NextSignals, type PagingPlan } from '../paging/plan.js';
import { nounOf, pathId } from '../envelope/relations.js';
import { NO_RESULT, v1Result } from '../envelope/v1.js';
import type { TaskTracker } from '../tasks/tracker.js';
import type { ArgValidator } from './arg-validate.js';
import { principalUserId, traceIdOf, type RunContext } from './context.js';
import { errorResult, type ErrorEvents } from './errors.js';
import { evaluatePolicies } from './policy.js';
import { readBackView, writePlan, type ConfirmProblem, type ConfirmTokens, type WritePlan } from './confirm-token.js';

export interface PolicyStep {
  step: PolicyStepName;
  result: PolicyStepResult;
  detail?: string;
}

import type { McpToolResult } from '../envelope/v1.js';
export type { McpToolResult };

export interface PlannedChange {
  tool: string;
  method: string;
  path: string;
  arguments: Record<string, unknown>;
  wouldConfirm: boolean;
  argsHash: string;
}

/** What the confirmation step asks the MCP layer (§9.7). */
export type ConfirmOutcome = { status: 'approved' } | { status: 'declined' } | { status: 'unsupported' } | { status: 'pending'; result: unknown };

export interface Confirmer {
  confirm(req: { tool: ToolDef; args: Record<string, unknown>; argsHash: string; message: string }): Promise<ConfirmOutcome>;
}

export interface InvokeOptions {
  /** Resolve by Python name (`ns.fn`) instead of the MCP name (scripts). */
  byPyName?: boolean;
  confirmer?: Confirmer | null;
  signal?: AbortSignal;
  /** Collect planned writes (dry-run scripts). */
  planned?: PlannedChange[];
  /** contract 2, scripts (`ops.pages`): start at this upstream page position */
  position?: CursorPayload;
}

export interface ToolOutcome {
  ok: boolean;
  /** true when the tool is unknown/hidden/not permitted (direct MCP calls answer JSON-RPC -32602). */
  unknown: boolean;
  decision: AuditDecision;
  status: AuditStatus;
  result: McpToolResult;
  /** Shaped JSON value (scripts get this as the function's return value). */
  value?: unknown;
  error?: { code: ErrorCode; message: string; errorId: string | null };
  auditId: string;
  /** MRTR `input_required` result for a pending prod confirmation. */
  inputRequired?: unknown;
  tool?: ToolDef;
  /** The same outcome in contract-neutral form (rendered as the contract-2 envelope). */
  draft: Draft;
  /** contract 2, list tools: where the upstream's next page starts (scripts page with it) */
  paging?: { more: boolean; next: Exclude<CursorPayload, { k: 'r' }> | null };
}

export interface PipelineDeps {
  audit: AuditRecorder;
  tracker: TaskTracker;
  limiter: RateLimiter;
  args: ArgValidator;
  credentials: CredentialResolver;
  http: HttpInvoker;
  mock: MockUpstream;
  pages: ResultPages;
  errors: ErrorEvents;
  metrics?: Metrics;
  now: () => number;
  publicUrl: string;
  version: string;
  /** contract 2: signs and checks `page.next_cursor` (absent: no cursors) */
  cursors?: CursorCodec;
  /** contract 2: confirm tokens for destructive writes outside prod (D5; absent: no token gate) */
  confirms?: ConfirmTokens;
  /** Records usage + traffic examples after a successful call (post-commit; never fails the call). */
  onSuccess?: (ctx: RunContext, tool: ToolDef, args: Record<string, unknown>) => void;
  log: { warn: (o: object, m: string) => void };
}

const PREVIEW_TEXT_BYTES = 8192;

export function argsHashOf(tool: string, args: Record<string, unknown>): string {
  return hashCanonical({ tool, args });
}

function compactJson(v: unknown): string {
  const s = JSON.stringify(v);
  if (s === undefined) return 'null';
  if (Buffer.byteLength(s) <= PREVIEW_TEXT_BYTES) return s;
  return `${Buffer.from(s).subarray(0, PREVIEW_TEXT_BYTES - 40).toString('utf8')}… (truncated preview)`;
}

/** Finds a visible tool the principal may see (profile filter); hidden/out-of-profile = unknown (§18.3). */
export function resolveVisibleTool(ctx: RunContext, name: string, byPyName = false): ToolDef | null {
  const tools = ctx.bundle.build.tools;
  const t = byPyName ? tools.find((x) => x.pyName === name) : tools.find((x) => x.name === name);
  if (!t || t.hidden) return null;
  if (ctx.principal.type === 'api_key' && ctx.principal.profile) {
    const allowed = ctx.bundle.build.profiles[ctx.principal.profile];
    if (allowed && !allowed.includes(t.name)) return null;
  }
  return t;
}

/** Kill switch lookup (§9.6 step 2): global, server, environment, tool; kinds all / writes / code_mode. */
export function killSwitchFor(ctx: RunContext, tool: ToolDef | null, kinds: readonly ('all' | 'writes' | 'code_mode')[]): { target: string; kind: string; reason: string } | null {
  const b = ctx.bundle;
  for (const k of b.killSwitches) {
    if (!kinds.includes(k.kind)) continue;
    const hit =
      k.scope === 'global' ||
      (k.scope === 'server' && (k.target === b.server.id || k.target === b.server.slug)) ||
      (k.scope === 'environment' && (k.target === b.environment.id || k.target === `${b.server.slug}/${b.environment.slug}`)) ||
      (k.scope === 'tool' && tool !== null && (k.target === `${b.server.slug}/${b.environment.slug}/${tool.name}` || k.target === `${b.server.slug}/*/${tool.name}`));
    if (hit) return { target: k.scope === 'global' ? 'Everything' : k.target, kind: k.kind, reason: k.reason };
  }
  return null;
}

/** Whether a write tool is enabled in the environment (§9.7, read-only by default). */
export function writeEnabled(ctx: RunContext, tool: ToolDef): boolean {
  const w = ctx.bundle.environment.writes;
  if (!w.enabled) return false;
  return w.tools === null || w.tools.includes(tool.name);
}

/**
 * The policy pipeline (§9.6). One implementation serves direct calls, `call_tool`, every inner call
 * of a script and composite tools. Each step appends to `policy_trail`; every non-allowed outcome
 * creates an `error_events` row and returns `error_id` + `next-tools` hints.
 */
export class Pipeline {
  constructor(private readonly d: PipelineDeps) {}

  private base(ctx: RunContext): Omit<AuditEventInput, 'id' | 'ts' | 'kind' | 'decision' | 'status'> {
    const p = ctx.principal;
    return {
      tenantId: ctx.tenantId,
      requestId: ctx.requestId,
      userId: principalUserId(p),
      apiKeyId: p.type === 'api_key' ? p.apiKeyId : null,
      oauthClientId: p.type === 'user' ? p.oauthClientId : null,
      principalType: p.type,
      externalSubject: p.type === 'external' ? p.subject : null,
      credentialKey: ctx.credentialKey,
      clientName: ctx.client.name,
      clientVersion: ctx.client.version,
      protocolVersion: ctx.client.protocolVersion,
      clientEra: ctx.client.era,
      serverId: ctx.server.id,
      environmentId: ctx.environment.id,
      environmentKind: ctx.environment.kind,
      taskId: ctx.taskId,
      scriptRunId: ctx.scriptRunId ?? null,
      via: ctx.via,
      mode: ctx.mode,
      traceId: traceIdOf(ctx.traceparent),
      spanId: ctx.spanId ?? null,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };
  }

  /** Shared audit base for other producers (search, ops, scripts). */
  auditBase(ctx: RunContext): Omit<AuditEventInput, 'id' | 'ts' | 'kind' | 'decision' | 'status'> {
    return this.base(ctx);
  }

  async invoke(ctx: RunContext, name: string, rawArgs: Record<string, unknown>, opts: InvokeOptions = {}): Promise<ToolOutcome> {
    const start = this.d.now();
    const auditId = newId();
    const trail: PolicyStep[] = [];
    const step = (s: PolicyStepName, r: PolicyStepResult, detail?: string) => trail.push({ step: s, result: r, ...(detail ? { detail } : {}) });
    let tool: ToolDef | null = null;
    let args = rawArgs;
    const metaBase = (): Record<string, unknown> => ({ [META_CALL_ID]: auditId, ...(ctx.taskId ? { [META_TASK_ID]: ctx.taskId } : {}) });

    const record = (decision: AuditDecision, status: AuditStatus, extra: Partial<AuditEventInput> = {}) => {
      step('audit', 'pass');
      const write = tool?.risk.write ?? false;
      this.d.audit.record({
        ...this.base(ctx),
        id: auditId,
        kind: 'tool_call',
        toolName: tool?.name ?? name,
        toolId: tool ? (ctx.bundle.build.toolRowIds[tool.name] ?? null) : null,
        decision,
        status,
        params: args,
        write,
        dryRun: decision === 'dry_run',
        confirm: decision === 'confirmed' ? 'elicited' : 'none',
        policyTrail: trail,
        latencyMs: this.d.now() - start,
        ...extra,
      });
      this.d.metrics?.toolCall(ctx.bundle.server.slug, ctx.bundle.environment.slug, tool?.name ?? name, ctx.via, decision, status, (this.d.now() - start) / 1000);
      const blocked = decision.startsWith('denied_');
      this.d.tracker.bump(ctx.taskId, { call_count: 1, ...(status !== 'ok' && !blocked ? { error_count: 1 } : {}), ...(blocked ? { blocked_count: 1 } : {}), ...(write && status === 'ok' && decision !== 'dry_run' ? { write_count: 1 } : {}) });
      if (tool) this.d.tracker.remember(ctx.taskId, { tool: tool.name, tags: tool.tags, ok: status === 'ok' && !blocked });
    };

    const fail = async (decision: AuditDecision, status: AuditStatus, code: ErrorCode, message: string, detail: Record<string, unknown>, extra: { retryAfterMs?: number; nextTools?: string[]; audit?: Partial<AuditEventInput>; unknown?: boolean; meta?: Record<string, unknown>; spec?: Partial<ErrorSpec>; data?: unknown } = {}): Promise<ToolOutcome> => {
      let errorId: string | null = null;
      try {
        errorId = await this.d.errors.record({ tenantId: ctx.tenantId, taskId: ctx.taskId, auditId, toolName: tool?.name ?? name, code, detail: { tool: tool?.name ?? name, environment: ctx.environment.slug, ...detail } });
      } catch (err) {
        this.d.log.warn({ err }, 'error event not recorded');
      }
      record(decision, status, { errorCode: code, errorMessage: message.slice(0, 1000), errorId, decisionReason: code, ...(extra.audit ?? {}) });
      const r = errorResult(message, errorId, code, { ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}), ...(extra.nextTools ? { nextTools: extra.nextTools } : {}), meta: { ...metaBase(), ...(extra.meta ?? {}) } });
      const spec: ErrorSpec = { code, message, errorId, ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}), tool, name, args: rawArgs, ...(extra.spec ?? {}) };
      const draft = errorDraft(spec, { meta: metaBase(), ...(extra.data !== undefined ? { data: extra.data } : {}) });
      return { ok: false, unknown: extra.unknown ?? false, decision, status, result: r, error: { code, message, errorId }, auditId, draft, ...(tool ? { tool } : {}) };
    };

    // 0 audit admission (fail closed, not audited)
    if (!this.d.audit.canAccept()) {
      const message = 'Audit unavailable: tool calls are refused until audit logging recovers. Retry shortly.';
      return { ok: false, unknown: false, decision: 'denied_disabled', status: 'blocked', result: errorResult(message, null, 'audit_unavailable'), error: { code: 'audit_unavailable', message: 'Audit unavailable', errorId: null }, auditId, draft: errorDraft({ code: 'audit_unavailable', message: `${message} Nothing was called.`, name, args: rawArgs }) };
    }

    // 1 resolve (hidden / out-of-profile = unknown; identical responses, §18.3)
    tool = resolveVisibleTool(ctx, name, opts.byPyName);
    if (!tool) {
      step('resolve', 'fail', 'unknown');
      const out = await fail('denied_acl', 'blocked', 'unknown_tool', `Tool not found or not permitted: ${name}. Use search_tools to find tools you can call.`, {}, { unknown: true, nextTools: ['search_tools'] });
      return out;
    }
    step('resolve', 'pass', tool.name);

    // 2 kill switches
    const ks = killSwitchFor(ctx, tool, tool.risk.write ? ['all', 'writes'] : ['all']) ?? (ctx.via === 'script' ? killSwitchFor(ctx, tool, ['code_mode']) : null);
    if (ks) {
      step('kill_switch', 'fail', `${ks.kind}:${ks.target}`);
      return fail('denied_disabled', 'blocked', 'kill_switch', `${tool.name} is disabled by the operator (${ks.kind}).`, { target: ks.target, kind: ks.kind, reason: ks.reason ? `: ${ks.reason}` : '' });
    }
    step('kill_switch', 'pass');

    // 3 ACL: scopes
    const scopes = ctx.principal.scopes;
    if (!scopes.includes('tools:read')) {
      step('acl', 'fail', 'tools:read');
      return fail('denied_acl', 'blocked', 'not_permitted', `Your credential may not call tools (missing scope tools:read).`, { scope: 'tools:read' });
    }
    if (tool.risk.write && !scopes.includes('tools:write')) {
      step('acl', 'fail', 'tools:write');
      return fail('denied_acl', 'blocked', 'not_permitted', `${tool.name} changes data and your credential lacks the tools:write scope.`, { scope: 'tools:write' });
    }
    step('acl', 'pass');

    // 4 read-only default
    if (tool.risk.write && !writeEnabled(ctx, tool)) {
      step('read_only', 'fail');
      const w = ctx.bundle.environment.writes;
      const allowList = w.enabled && w.tools ? ` (writes are enabled only for: ${w.tools.join(', ') || 'no tools'})` : ' (read-only)';
      return fail('denied_read_only', 'blocked', 'writes_disabled', `Writes are off in the ${ctx.environment.slug} environment${allowList}; ${tool.name} was not called.`, { allowList });
    }
    step('read_only', tool.risk.write ? 'pass' : 'skip');

    // 5 arguments. Contract 2 first takes out its own (cursor, limit, fields; contract-v2 §2.1, D6) and checks them;
    // then overlay defaults and ajv against the upstream input schema (compiled per defHash)
    const plan: PagingPlan | null = ctx.contract === 2 && tool.kind !== 'composite' ? pagingPlan(tool) : null;
    const own = plan && ctx.via !== 'script' ? splitArgs(plan, rawArgs) : null;
    const extraArgs: Record<string, unknown> = {};
    if (own?.cursor !== undefined && plan?.names.cursor) extraArgs[plan.names.cursor] = own.cursor;
    if (own?.fields && plan) extraArgs[plan.names.fields] = own.fields;
    const agentArgs = own ? own.upstream : rawArgs;
    if (own?.issues.length) {
      step('arguments', 'fail', own.issues.map((i) => i.path).join(', '));
      const bad = new Set(own.issues.map((i) => i.path.slice(1)));
      return fail('allowed', 'invalid_args', 'invalid_args', `Invalid arguments for ${tool.name}: ${own.issues.map((i) => `${i.path.slice(1)} ${i.message}`).join('; ')}`, { errors: own.issues.map((i) => i.message).join('; ') }, { spec: { issues: own.issues, next: [{ tool: tool.name, args: Object.fromEntries(Object.entries(rawArgs).filter(([k]) => !bad.has(k))) }] } });
    }
    let position: CursorPayload | null = opts.position ?? null;
    if (own?.cursor !== undefined && plan) {
      const cursorArg = plan.names.cursor!;
      const first = Object.fromEntries(Object.entries(rawArgs).filter(([k]) => k !== cursorArg));
      if (isNeurouterCursor(own.cursor) && this.d.cursors) {
        const binding = this.cursorBinding(ctx, tool, rawArgs, plan);
        try {
          position = this.d.cursors.decode(own.cursor, binding);
        } catch (err) {
          const problem = err instanceof CursorError ? err.problem : 'malformed';
          step('arguments', 'fail', `cursor ${problem}`);
          // other query arguments than the cursor's: continuing it keeps the cursor (its own arguments, this projection)
          const bound = problem === 'mismatch' ? this.d.cursors.boundArgs(own.cursor, binding) : null;
          if (bound) {
            const keep = { ...bound, ...(own.fields ? { [plan.names.fields]: own.fields } : {}), [cursorArg]: own.cursor };
            const changed = [...new Set([...Object.keys(bound), ...Object.keys(binding.args)])].filter((k) => JSON.stringify(bound[k]) !== JSON.stringify(binding.args[k]));
            const why = `was issued for other arguments (${changed.join(', ').slice(0, 60)})`;
            return fail('allowed', 'invalid_args', 'invalid_args', `The cursor ${why}; ${tool.name} was not called.`, { errors: 'cursor mismatch' }, { spec: { text: `The cursor ${why}; nothing was called. Continue it with its arguments (error.next[0]), or start the new query on page 1.`, issues: [{ path: `/${cursorArg}`, keyword: 'cursor', params: {}, message: why }], next: [{ tool: tool.name, args: keep }, { tool: tool.name, args: first }] } });
          }
          const why = problem === 'expired' ? 'expired (cursors last 1 hour)' : problem === 'mismatch' ? 'belongs to another tool, other arguments or another credential, or was altered' : 'is not a page.next_cursor';
          return fail('allowed', 'invalid_args', 'invalid_args', `The cursor ${why}; ${tool.name} was not called.`, { errors: `cursor ${problem}` }, { spec: { text: `The cursor ${why}; nothing was called. Repeat the first call, or pass the same other arguments.`, issues: [{ path: `/${cursorArg}`, keyword: 'cursor', params: {}, message: why }], next: [{ tool: tool.name, args: first }] } });
        }
      } else if (plan.cursor) agentArgs[plan.cursor.arg] = own.cursor; // an upstream cursor value (from data): passed through
      else {
        step('arguments', 'fail', 'cursor');
        return fail('allowed', 'invalid_args', 'invalid_args', `${tool.name} has no upstream cursor; pass page.next_cursor as ${cursorArg}.`, { errors: 'cursor' }, { spec: { issues: [{ path: `/${cursorArg}`, keyword: 'cursor', params: {}, message: 'is not a page.next_cursor' }], next: [{ tool: tool.name, args: first }] } });
      }
    }
    args = applyArgTransforms(tool, agentArgs);
    const check = this.d.args.check(tool.defHash, tool.inputSchema, args);
    if (!check.ok) {
      step('arguments', 'fail', check.errors.slice(0, 3).join('; '));
      return fail('allowed', 'invalid_args', 'invalid_args', `Invalid arguments for ${tool.name}:\n- ${check.errors.join('\n- ')}`, { errors: check.errors.join('; '), schema: JSON.stringify(tool.inputSchema).slice(0, 1500) }, { spec: { issues: check.issues, ...(own ? { args: agentArgs, extraArgs } : {}) } });
    }
    step('arguments', 'pass');

    // 6 policies (incl. built-in no-raw-urls and data-flow rules over the task history)
    const pol = evaluatePolicies(ctx.bundle.environment.policies, tool, args, this.d.tracker.callHistory(ctx.taskId), new Date(this.d.now()));
    if (pol.deny) {
      step('policy', 'fail', pol.policy);
      return fail('denied_policy', 'blocked', 'policy_denied', `${pol.message} (policy ${pol.policy})`, { policy: pol.policy, message: pol.message });
    }
    step('policy', 'pass');

    // 7 rate limits (principal, principal × tool); an eval reference session computes ground truth (harness work,
    // not agent traffic: a long-workflow reference script walks every item) and is not throttled
    const lim = ctx.bundle.environment.limits;
    const principalLimit = ctx.principal.type === 'api_key' && ctx.principal.rateLimit ? ctx.principal.rateLimit : lim.rateLimit;
    const rl = ctx.fullObjects ? { allowed: true as const } : await this.d.limiter.take(this.d.limiter.checksFor({ environmentId: ctx.environment.id, credentialKey: ctx.credentialKey, tool: tool.name, principalLimit, toolLimit: lim.toolRateLimit }));
    if (!rl.allowed) {
      step('rate_limit', 'fail', rl.scope);
      const secs = Math.max(1, Math.ceil(rl.retryAfterMs / 1000));
      this.d.metrics?.rateLimited(rl.scope);
      const out = await fail('denied_rate_limit', 'blocked', 'rate_limited', `Rate limit exceeded for ${tool.name}; retry after ${secs}s.`, { retryAfterSec: secs, scopeDetail: ` (${rl.scope})` }, { retryAfterMs: rl.retryAfterMs });
      out.draft.left = { calls: 0 };
      return out;
    }
    step('rate_limit', 'pass');
    // contract 2 (§2.4): `state.left.calls` once a rate-limit bucket is down to 20%
    const left = rl.left && rl.left.calls <= rl.left.capacity * 0.2 ? { calls: rl.left.calls } : undefined;

    const argsHash = argsHashOf(tool.name, args);
    // confirmation applies wherever the environment asks for it (prod: always; `none` is invalid there)
    const confirmMode = ctx.bundle.environment.writes.confirm;
    const wouldConfirm = tool.risk.write && confirmMode !== 'none';

    // contract 2 (D5): the call without its own arguments, the base of confirm tokens and next calls
    const confirmName = plan?.names.confirm ?? null;
    const bound = Object.fromEntries(Object.entries(rawArgs).filter(([k]) => k !== confirmName && k !== plan?.names.dryRun && rawArgs[k] !== undefined));
    const tokenGate = ctx.contract === 2 && tool.risk.write && tool.risk.destructive && confirmMode === 'none' && this.d.confirms !== undefined;
    const binding = { tenantId: ctx.tenantId, environmentId: ctx.environment.id, credentialKey: ctx.credentialKey, tool: tool.name, args: bound };

    // 8a contract 2: `dry_run: true` returns the plan; outside prod a destructive tool's plan carries the confirmed call
    if (own?.dryRun && tool.risk.write) {
      step('dry_run', 'pass', 'dry_run argument');
      const p = await this.labelled(ctx, tool, agentArgs, writePlan(tool, agentArgs));
      const value = { plan: p, ...(tokenGate && confirmName ? { next: { tool: tool.name, args: { ...bound, [confirmName]: this.d.confirms!.mint(binding) } } } : {}) };
      record('dry_run', 'ok', { output: value });
      return { ok: true, unknown: false, decision: 'dry_run', status: 'ok', value, result: v1Result(compactJson(value), value, { ...metaBase(), [META_DRY_RUN]: true }), auditId, tool, draft: okDraft(value, { flags: ['dry_run'], write: true, meta: metaBase() }) };
    }

    // 8 dry-run short-circuit
    if (ctx.dryRun && tool.risk.write) {
      step('dry_run', 'pass');
      const planned = this.plannedChange(tool, args, wouldConfirm, argsHash);
      opts.planned?.push(planned);
      const value = { dry_run: true, planned: { tool: planned.tool, method: planned.method, path: planned.path, arguments: planned.arguments } };
      record('dry_run', 'ok', { output: value });
      return { ok: true, unknown: false, decision: 'dry_run', status: 'ok', value, result: v1Result(compactJson(value), value, { ...metaBase(), [META_DRY_RUN]: true }), auditId, tool, draft: okDraft(value, { flags: ['dry_run'], meta: metaBase() }) };
    }
    step('dry_run', 'skip');

    // 9a contract 2 (D5), outside prod: a destructive call needs a confirm token from its own plan; script runs
    // need the call in the plan approved with a token (run_script answers the token round itself)
    const confirmationRequired = async (problem: ConfirmProblem | 'script' | null): Promise<ToolOutcome> => {
      const p = problem === 'script' ? writePlan(tool!, agentArgs) : await this.labelled(ctx, tool!, agentArgs, writePlan(tool!, agentArgs));
      const why = problem === 'expired' ? 'The confirm token expired (5 minutes). ' : problem === 'used' ? 'The confirm token was already used. ' : problem === 'mismatch' || problem === 'malformed' ? 'The confirm token is for another call. ' : '';
      const script = problem === 'script';
      const token = script ? null : this.d.confirms!.mint(binding);
      step('confirm', 'fail', script ? 'not in the confirmed plan' : problem ? `token ${problem}` : 'confirm token required');
      record('dry_run', 'ok', { output: { plan: p }, decisionReason: 'confirmation_required' });
      const text = `${why}${tool!.name} is destructive${p.reversible ? '' : ' and irreversible'}; nothing changed yet. ${script ? 'Dry-run the script, then run it with the confirm token.' : 'Repeat with the confirm token to execute.'}`;
      const next = script ? [] : [{ tool: tool!.name, args: { ...bound, [confirmName ?? 'confirm']: token } }];
      return { ok: false, unknown: false, decision: 'dry_run', status: 'blocked', result: errorResult(text, null, 'confirmation_declined'), error: { code: 'confirmation_declined', message: text, errorId: null }, auditId, tool: tool!, draft: errorDraft({ code: 'confirmation_required', message: text, text, tool, name, args: rawArgs, next }, { data: { plan: p }, flags: ['dry_run'], write: true, meta: metaBase() }) };
    };
    if (tokenGate && ctx.via === 'script' && !ctx.dryRun) {
      if (!ctx.approvedPlan?.has(`${tool.name}|${argsHash}`)) return confirmationRequired('script');
      step('confirm', 'pass', 'confirmed plan');
    } else if (tokenGate && ctx.via !== 'script' && !ctx.dryRun) {
      if (!own?.confirm) return confirmationRequired(null);
      const problem = await this.d.confirms!.spend(own.confirm, binding);
      if (problem) return confirmationRequired(problem);
      step('confirm', 'pass', 'confirm token');
    }

    // 9 write confirmation on prod (§9.7); contract-2 confirm tokens are never accepted here (D5)
    let decision: AuditDecision = 'allowed';
    if (wouldConfirm) {
      if (ctx.via === 'script' && ctx.approvedPlan) {
        if (!ctx.approvedPlan.has(`${tool.name}|${argsHash}`)) {
          step('confirm', 'fail', 'not in approved plan');
          return fail('denied_confirmation', 'blocked', 'confirmation_declined', `This write is not in the approved plan; ${tool.name} was not called.`, {});
        }
        decision = 'confirmed';
        step('confirm', 'pass', 'approved plan');
      } else {
        const msg = ctx.contract === 2 ? this.confirmMessageV2(ctx, tool, args) : this.confirmMessage(ctx, tool, args);
        const out = opts.confirmer ? await opts.confirmer.confirm({ tool, args, argsHash, message: msg }) : ({ status: 'unsupported' } as const);
        if (out.status === 'pending') {
          step('confirm', 'skip', 'elicitation sent');
          return { ok: false, unknown: false, decision: 'allowed', status: 'ok', result: NO_RESULT, auditId, inputRequired: out.result, tool, draft: errorDraft({ code: 'confirmation_required', message: 'Waiting for the user to confirm.', tool, name, args: rawArgs }) };
        }
        if (out.status === 'unsupported') {
          step('confirm', 'fail', 'unsupported');
          const where = envLabel(ctx);
          if (confirmMode === 'elicit') {
            // elicit: hand back the planned change (not executed) so the user can review and run it elsewhere
            const planned = this.plannedChange(tool, args, true, argsHash);
            const change = { tool: planned.tool, method: planned.method, path: planned.path, arguments: planned.arguments };
            return fail('denied_confirmation', 'blocked', 'confirmation_unsupported', `Not executed: this client cannot ask the user to confirm writes in ${where}. Planned change (nothing was changed): ${planned.method} ${planned.path} ${compactJson(planned.arguments).slice(0, 2000)}. Show it to the user; they can approve it from a client with MCP elicitation support.`, {}, {
              meta: { [META_PLANNED_CHANGES]: [change] },
              audit: { output: { planned: [change] } },
              spec: { text: `${tool.name} needs your user's approval in ${where} and this client cannot ask; nothing changed. Show data.plan to the user.`, ...(ctx.contract === 2 && ctx.bundle.server.opsTools.end_task ? { next: [{ tool: 'neurouter_report', args: { kind: 'blocked', text: `needs approval for ${tool.name} in ${where}` } }] } : {}) },
              data: { plan: ctx.contract === 2 ? await this.labelled(ctx, tool, agentArgs, writePlan(tool, agentArgs)) : { tool: change.tool, method: change.method, path: change.path, args: change.arguments } },
            });
          }
          return fail('denied_confirmation', 'blocked', 'confirmation_unsupported', `This client cannot ask the user to confirm writes in ${where}; ${tool.name} was not called.`, {}, { spec: { text: `This client cannot ask the user to confirm writes in ${where}; ${tool.name} was not called. Nothing changed.` } });
        }
        if (out.status === 'declined') {
          step('confirm', 'fail', 'declined');
          return fail('denied_confirmation', 'blocked', 'confirmation_declined', `The user declined ${tool.title || tool.name} in ${envLabel(ctx)}.`, {});
        }
        decision = 'confirmed';
        step('confirm', 'pass', 'elicited');
      }
    } else step('confirm', 'skip');

    // contract 2: the rest of a list Neurouter cut is served from the stored result (no upstream call)
    if (position?.k === 'r') return this.storedPage(ctx, tool, rawArgs, agentArgs, position, plan!, own?.fields, { record, fail, metaBase, step, decision });

    // contract 2, overlay readBack: the target as it is before the write (read through the pipeline, its own audit row)
    const before = tool.risk.write && tool.readBack && !ctx.dryRun ? await this.readBack(ctx, tool, agentArgs) : null;

    // 10–11 routing, credentials, request build, invoke
    if (tool.kind === 'composite') {
      step('routing', 'fail', 'composite');
      return fail(decision, 'tool_error', 'executor_unavailable', `${tool.name} is a composite tool; it runs through code mode.`, {});
    }
    let upstream: UpstreamResponse;
    const env = ctx.bundle.environment;
    const specArgs = toSpecArgs(tool, args);
    // contract 2: the page a cursor points at (upstream cursor, page, offset or Link query)
    let extraQuery: Record<string, string | string[]> = {};
    if (position && plan) extraQuery = applyPosition(tool, plan, specArgs, position).extraQuery;
    let urlTemplate = '';
    try {
      if (env.isMock) {
        step('routing', 'pass', 'mock');
        upstream = await this.callMock(ctx, tool, specArgs, extraQuery);
      } else {
        const cred = await this.d.credentials.resolve(env.auth, {
          tenantId: ctx.tenantId,
          environmentId: env.id,
          userId: principalUserId(ctx.principal),
          inbound: ctx.principal.type === 'external' ? { bearer: ctx.principal.bearer, audiences: ((ctx.principal as unknown as { audiences?: string[] }).audiences ?? []) } : null,
          publicUrl: this.d.publicUrl,
        });
        if (!cred.ok) {
          step('routing', 'fail', cred.code);
          if (cred.code === 'credential_missing') return fail(decision, 'tool_error', 'credential_missing', `The ${env.slug} environment has no credential configured.`, { ref: cred.ref });
          return fail(decision, 'tool_error', 'upstream_auth_required', `Connect your account first: ${cred.connectUrl}`, { connectUrl: cred.connectUrl });
        }
        step('routing', 'pass', env.baseUrl);
        if (tool.binding.type === 'graphql') {
          const base = new URL(env.baseUrl);
          const url = new URL(base.origin + base.pathname.replace(/\/$/, '') + (tool.binding.endpointPath ?? ''));
          if (!hostAllowed(url, env.allowedHosts)) throw new RequestBuildError(`host ${url.host} is not in allowedHosts`, 'host_not_allowed');
          urlTemplate = url.pathname;
          const variables = Object.fromEntries(tool.binding.variables.map((v) => [v.name, specArgs[v.arg]]).filter(([, v]) => v !== undefined));
          const body = JSON.stringify({ query: tool.binding.document, variables });
          upstream = await this.traced(ctx, tool.name, (trace) => this.d.http.invoke(env.id, { method: 'POST', url, urlTemplate, headers: { accept: GRAPHQL_ACCEPT, 'content-type': 'application/json', 'user-agent': `neurouter/${this.d.version}`, ...lower(env.headers), ...cred.headers, ...trace }, body }, { timeoutMs: lim.timeoutMs, maxBytes: lim.maxResponseBytes, allowHttp: env.allowHttp, ...(opts.signal ? { signal: opts.signal } : {}) }));
        } else {
          const req = buildHttpRequest(tool, specArgs, { baseUrl: env.baseUrl, headers: env.headers, allowedHosts: env.allowedHosts, credentials: cred, extraQuery }, this.d.version);
          urlTemplate = req.urlTemplate;
          upstream = await this.traced(ctx, tool.name, (trace) => this.d.http.invoke(env.id, { ...req, headers: { ...req.headers, ...trace } }, { timeoutMs: lim.timeoutMs, maxBytes: lim.maxResponseBytes, allowHttp: env.allowHttp, ...(opts.signal ? { signal: opts.signal } : {}) }));
        }
      }
      step('upstream', 'pass', String(upstream.status));
    } catch (err) {
      if (err instanceof RequestBuildError) {
        step('routing', 'fail', err.code);
        if (err.code === 'host_not_allowed') return fail('denied_policy', 'blocked', 'policy_denied', err.message, { policy: 'allowed-hosts', message: err.message });
        return fail(decision, 'invalid_args', 'invalid_args', err.message, { errors: err.message });
      }
      const ie = err instanceof InvokeError ? err : new InvokeError((err as Error).message, 'transport');
      step('upstream', 'fail', ie.kind);
      if (ie.kind === 'cancelled') {
        record(decision, 'cancelled', { errorCode: 'cancelled' });
        return { ok: false, unknown: false, decision, status: 'cancelled', result: errorResult('Cancelled', null, 'upstream_error'), auditId, tool, draft: errorDraft({ code: 'unavailable', message: 'The call was cancelled.', retry: 'yes', tool, name, args: rawArgs }) };
      }
      if (ie.kind === 'timeout') return fail(decision, 'timeout', 'timeout', `The API did not answer within ${lim.timeoutMs} ms.`, { timeoutMs: lim.timeoutMs });
      if (ie.kind === 'response_too_large') return fail(decision, 'upstream_error', 'response_too_large', `The API response exceeded ${lim.maxResponseBytes} bytes.`, { maxBytes: lim.maxResponseBytes });
      if (ie.kind === 'blocked') return fail('denied_policy', 'blocked', 'policy_denied', 'The upstream address is not allowed by the outbound network policy.', { policy: 'ssrf-guard', message: 'blocked address' });
      return fail(decision, 'upstream_error', 'upstream_error', `The API is unreachable (${ie.kind}).`, { detail: ie.message.slice(0, 300) });
    }

    // 12 response: status mapping, redact/shaping/truncation, untrusted scan
    const upstreamMeta = { upstreamStatus: upstream.status, upstreamLatencyMs: upstream.latencyMs };
    const st = upstream.status;
    if (st < 200 || st >= 300 || (tool.binding.type === 'http' && tool.binding.successStatuses.length && !tool.binding.successStatuses.includes(st) && st >= 300)) {
      const excerpt = compactJson(upstream.body).slice(0, 1024);
      const retryAfterMs = upstream.headers['retry-after'] ? Math.max(0, Number(upstream.headers['retry-after']) * 1000) || undefined : undefined;
      const a = { audit: upstreamMeta, spec: { upstream: { status: st, body: upstream.body } } };
      if (st === 401 || st === 403) return fail(decision, 'tool_error', 'upstream_auth', `The API answered ${st} for ${tool.name}.`, { status: st }, a);
      if (st === 404) return fail(decision, 'tool_error', 'upstream_not_found', `The API answered 404 for ${tool.name}: ${excerpt}`, { status: st }, a);
      if (st === 409) return fail(decision, 'tool_error', 'upstream_conflict', `The API reported a conflict: ${excerpt}`, { detail: excerpt }, a);
      if (st === 400 || st === 422) return fail(decision, 'tool_error', 'upstream_validation', `The API rejected the request: ${excerpt}`, { detail: excerpt }, a);
      if (st === 429) return fail(decision, 'tool_error', 'upstream_rate_limited', 'The API answered 429 (rate limited).', { retryAfterSec: retryAfterMs ? Math.ceil(retryAfterMs / 1000) : 60 }, { ...a, ...(retryAfterMs ? { retryAfterMs } : {}) });
      if (st >= 500) return fail(decision, 'upstream_error', 'upstream_error', `The API failed with ${st}: ${excerpt}`, { detail: `${st} ${excerpt.slice(0, 200)}` }, a);
      return fail(decision, 'tool_error', 'upstream_validation', `The API answered ${st}: ${excerpt}`, { detail: excerpt }, a);
    }
    let body = upstream.body;
    const meta: Record<string, unknown> = metaBase();
    if (tool.binding.type === 'graphql' && body && typeof body === 'object') {
      const g = body as { data?: Record<string, unknown> | null; errors?: Array<{ message?: string }> };
      if (g.errors?.length && !g.data) return fail(decision, 'tool_error', 'upstream_validation', `GraphQL errors: ${g.errors.map((e) => e.message).join('; ').slice(0, 800)}`, { detail: g.errors.map((e) => e.message).join('; ').slice(0, 800) }, { audit: upstreamMeta, spec: { upstream: { status: upstream.status, body: g.errors.map((e) => e.message).join('; ') } } });
      if (g.errors?.length) meta[META_GRAPHQL_ERRORS] = g.errors.map((e) => e.message ?? '');
      let v: unknown = g.data ?? null;
      for (const p of tool.binding.resultPath) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[p] : undefined;
      body = v ?? null;
    }
    let value: unknown = body;
    let text: string;
    let shaped: ReturnType<typeof shapeResponse> | undefined;
    // contract 2: where the upstream's next page starts (read from the raw body, before shaping drops keys)
    const signals = plan?.list ? nextSignals(plan, specArgs, body, upstream.headers, env.isMock ? MOCK_BASE : env.baseUrl, sizeDefault(tool, plan)) : null;
    try {
      // scripts get whole (shaped) values: no maxItems/maxBytes on inner calls; the script reduces the data
      // and run_script's result-size limit bounds what it returns. Tool-mode results keep both limits.
      // Contract 2 `fields` replaces the overlay `include` (the default set) and is applied after shaping, on the
      // agent-visible names; a projection gets the whole 64 KB tool-mode budget.
      // eval reference calls (ground truth) get full objects: the overlay's default projection is the agent's default, not the truth (B7)
      const shaping = ctx.fullObjects && tool.shaping?.include ? { ...tool.shaping, include: undefined } : tool.shaping;
      shaped = own?.fields ? this.shapeFields(body, tool, own.fields, plan!.list) : shapeResponse(body, shaping, ctx.via === 'script' ? { limits: false } : { maxBytes: 64 * 1024 });
      value = shaped.value;
      if (shaped.truncated) {
        const handle = await this.d.pages.store(ctx.tenantId, ctx.credentialKey, shaped.full);
        meta[META_RESULT_HANDLE] = handle;
        meta[META_TRUNCATED] = shaped.truncated;
        meta[META_NEXT_TOOLS] = ['neurouter_read_result'];
      }
      step('response', 'pass', shaped.truncated ? 'truncated' : undefined);
    } catch (err) {
      this.d.log.warn({ err, tool: tool.name }, 'response shaping failed; returning the raw result');
      step('response', 'skip', 'shaping failed');
    }
    text = compactJson(value);
    if (shaped?.truncated) {
      const t = shaped.truncated;
      const clipped = t.fields?.length ? `Clipped to fit: ${t.fields.slice(0, 10).join(', ')}${t.fields.length > 10 ? ` (+${t.fields.length - 10} more)` : ''}.` : `Showing ${t.returnedBytes} of ${t.totalBytes} bytes.`;
      text = `${t.totalItems !== undefined ? `Showing ${t.returnedItems ?? '?'} of ${t.totalItems} items.` : clipped} Call neurouter_read_result(handle="${String(meta[META_RESULT_HANDLE])}", offset) for more.\n${text}`;
    }
    if (scanUntrusted(value)) {
      meta[META_UNTRUSTED] = true;
      meta[META_NEXT_TOOLS] = [...new Set([...((meta[META_NEXT_TOOLS] as string[] | undefined) ?? []), 'neurouter_report_issue'])];
      text = `${UNTRUSTED_PREFIX}\n${text}`;
    }
    const keep = Object.fromEntries(Object.entries(upstream.headers).filter(([k]) => k === 'link' || k.startsWith('x-ratelimit')));
    if (Object.keys(keep).length) meta[META_UPSTREAM_HEADERS] = keep;
    if (upstream.headers['retry-after']) meta[META_RETRY_AFTER_MS] = Number(upstream.headers['retry-after']) * 1000;

    // contract 2, overlay readBack: data = {before, after, response} (the values an agent verifies), wrote = the label
    let wroteLabel: string | undefined;
    if (before) {
      const after = await this.readBack(ctx, tool, agentArgs);
      const keys = Object.keys(before.values);
      value = { before: before.values, after: after ? Object.fromEntries(keys.map((k) => [k, after.values[k] ?? null])) : null, response: value };
      wroteLabel = (after ?? before).label;
    }

    // 13 record
    record(decision, 'ok', { ...upstreamMeta, output: value });
    try {
      this.d.onSuccess?.(ctx, tool, rawArgs);
    } catch (err) {
      this.d.log.warn({ err }, 'post-call hook failed');
    }
    void urlTemplate;
    const handle = (meta[META_RESULT_HANDLE] as string | undefined) ?? null;
    const draft = this.successDraft(ctx, tool, rawArgs, value, shaped?.truncated, { signals, handle, plan }, upstream.headers, decision, metaBase(), wroteLabel);
    if (left) draft.left = left;
    return { ok: true, unknown: false, decision, status: 'ok', value, result: v1Result(text, wrapStructured(value), meta), auditId, tool, draft, ...(signals ? { paging: { more: signals.more, next: signals.next } } : {}) };
  }

  /** What a contract-2 cursor of this call is bound to: the agent's query arguments (`boundArgs`: no cursor, no `fields`). */
  private cursorBinding(ctx: RunContext, tool: ToolDef, rawArgs: Record<string, unknown>, plan: PagingPlan): CursorBinding {
    return { tenantId: ctx.tenantId, credentialKey: ctx.credentialKey, tool: tool.name, args: boundArgs(tool, plan, rawArgs), contract: 2 };
  }

  /** The encoder for `page.next_cursor` of this call (null without a codec or outside contract 2). */
  private cursorEncoder(ctx: RunContext, tool: ToolDef, rawArgs: Record<string, unknown>, plan: PagingPlan | null): (p: CursorPayload) => string | null {
    const codec = this.d.cursors;
    if (!codec || !plan?.names.cursor || ctx.contract !== 2) return () => null;
    const binding = this.cursorBinding(ctx, tool, rawArgs, plan);
    return (p) => codec.encode(p, binding);
  }

  /** Shaping with a `fields` projection: shaped without `include` or limits, projected, then cut to the limits. */
  private shapeFields(body: unknown, tool: ToolDef, fields: string[], list: boolean): ReturnType<typeof shapeResponse> {
    const { include: _i, maxItems, maxBytes, ...rest } = tool.shaping ?? {};
    const base = shapeResponse(body, rest, { limits: false });
    const projected = projectFields(base.value, fields, list);
    return shapeResponse(projected, { ...(maxItems !== undefined ? { maxItems } : {}), maxBytes: Math.max(maxBytes ?? 0, 64 * 1024) }, { maxBytes: 64 * 1024 });
  }

  /**
   * Contract 2: the next part of a list Neurouter cut, from the stored result (`r` cursor). Same policy steps as an
   * upstream call up to here (ACL, policies, rate limit); the items are cut to the tool's limits again, and the
   * page after the stored ones is the upstream's next page.
   */
  private async storedPage(
    ctx: RunContext,
    tool: ToolDef,
    rawArgs: Record<string, unknown>,
    agentArgs: Record<string, unknown>,
    pos: Extract<CursorPayload, { k: 'r' }>,
    plan: PagingPlan,
    fields: string[] | undefined,
    h: { record: (d: AuditDecision, s: AuditStatus, extra?: Partial<AuditEventInput>) => void; fail: (decision: AuditDecision, status: AuditStatus, code: ErrorCode, message: string, detail: Record<string, unknown>, extra?: { spec?: Partial<ErrorSpec> }) => Promise<ToolOutcome>; metaBase: () => Record<string, unknown>; step: (s: PolicyStepName, r: PolicyStepResult, detail?: string) => void; decision: AuditDecision },
  ): Promise<ToolOutcome> {
    const full = await this.d.pages.load(ctx.tenantId, ctx.credentialKey, pos.h);
    const list = itemsOf(full);
    if (full === null || !list) {
      h.step('routing', 'fail', 'result page expired');
      const first = Object.fromEntries(Object.entries(rawArgs).filter(([k]) => k !== plan.names.cursor));
      return h.fail(h.decision, 'invalid_args', 'invalid_args', `The cursor's stored page expired; ${tool.name} was not called.`, { errors: 'result page expired' }, { spec: { text: 'The stored pages behind this cursor expired (1 hour); nothing was called. Repeat the first call.', next: [{ tool: tool.name, args: first }] } });
    }
    h.step('routing', 'pass', 'result page');
    const rest = list.slice(pos.n);
    const cut = Array.isArray(full) ? rest : Object.fromEntries(Object.entries(full as Record<string, unknown>).map(([k, v]) => [k, v === list ? rest : v]));
    // `fields` is not bound into the cursor (B5): this page's projection applies to the stored items
    const remainder = fields?.length ? projectFields(cut, fields, true) : cut;
    const { maxItems, maxBytes } = tool.shaping ?? {};
    const shaped = shapeResponse(remainder, { ...(maxItems !== undefined ? { maxItems } : {}), ...(maxBytes !== undefined ? { maxBytes: fields ? Math.max(maxBytes, 64 * 1024) : maxBytes } : {}) }, { maxBytes: 64 * 1024 });
    h.step('response', 'pass', 'result page');
    h.record(h.decision, 'ok', { output: shaped.value, decisionReason: 'result_page' });
    const meta = h.metaBase();
    const paging: ListPaging = {
      encode: this.cursorEncoder(ctx, tool, rawArgs, plan),
      signals: null,
      handle: pos.h,
      stored: { offset: pos.n, length: list.length, total: pos.t ?? null, then: pos.then ?? null },
      own: [plan.names.cursor, plan.names.fields].filter((x): x is string => Boolean(x)),
    };
    const v = listView(tool, agentArgs, shaped.value, shaped.truncated, paging);
    const draft = okDraft(shaped.value, { page: v.page, truncated: v.truncated, ...(v.hint ? { hint: v.hint } : {}), meta });
    return { ok: true, unknown: false, decision: h.decision, status: 'ok', value: shaped.value, result: v1Result(compactJson(shaped.value), wrapStructured(shaped.value), meta), auditId: String(meta[META_CALL_ID]), tool, draft };
  }

  /** Contract-neutral success: `page` on list tools, `truncated` for clipped objects, flags for instruction-like text, `wrote` after writes. */
  private successDraft(ctx: RunContext, tool: ToolDef, args: Record<string, unknown>, value: unknown, cut: Parameters<typeof listView>[3], p: { signals: NextSignals | null; handle: string | null; plan: PagingPlan | null }, headers: Record<string, string>, decision: AuditDecision, meta: Record<string, unknown>, wroteLabel?: string): Draft {
    void headers;
    const extra: Omit<Draft, 'ok' | 'data'> = { meta };
    const own = p.plan ? [p.plan.names.cursor, p.plan.names.fields].filter((x): x is string => Boolean(x)) : [];
    if (isListTool(tool, value)) {
      const v = listView(tool, args, value, cut, { encode: this.cursorEncoder(ctx, tool, args, p.plan), signals: p.signals, handle: p.handle, own });
      extra.page = v.page;
      extra.truncated = v.truncated;
      if (v.hint) extra.hint = v.hint;
    } else if (cut) extra.truncated = clippedView(cut, tool, args, p.plan?.names.fields ?? 'fields', p.handle);
    const flagged = untrustedPaths(value, looksLikeInjection);
    if (flagged.length) {
      extra.flags = ['instruction_like_text'];
      extra.flagPaths = flagged;
    }
    if (tool.risk.write && decision !== 'dry_run') {
      const id = pathId(tool, args)?.value ?? (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).id : undefined);
      extra.wrote = wroteLabel ? `${tool.name} → ${wroteLabel}`.slice(0, 120) : `${tool.name} → ${nounOf(tool)}${id !== undefined && id !== null && typeof id !== 'object' ? ` ${String(id).slice(0, 60)}` : ''}`;
    }
    return okDraft(value, extra);
  }

  /**
   * Runs one upstream HTTP call in its own client span under the request's gateway span (§10.5).
   * `trace` = headers to add: the minted `traceparent` when no OTel SDK records (with the SDK, the
   * undici instrumentation injects the client span's context itself).
   */
  private traced<T>(ctx: RunContext, name: string, fn: (trace: Record<string, string>) => Promise<T>): Promise<T> {
    if (!ctx.trace) return fn({});
    const t = ctx.trace;
    return t.upstream(name, (meta) => fn(t.recording ? {} : meta));
  }

  plannedChange(tool: ToolDef, args: Record<string, unknown>, wouldConfirm: boolean, argsHash: string): PlannedChange {
    const method = tool.binding.type === 'http' ? tool.binding.method : tool.binding.type === 'graphql' ? 'POST' : 'SCRIPT';
    const path = tool.binding.type === 'http' ? tool.binding.pathTemplate : tool.binding.type === 'graphql' ? `graphql:${tool.binding.operationType}` : tool.name;
    return { tool: tool.name, method, path, arguments: args, wouldConfirm, argsHash };
  }

  /**
   * Contract 2, overlay `readBack` (tool mode): reads the write's target with the declared read tool (same required
   * arguments) through the pipeline. Null when not configured, in scripts, or when the read fails.
   */
  private async readBack(ctx: RunContext, tool: ToolDef, args: Record<string, unknown>): Promise<{ label: string; values: Record<string, unknown> } | null> {
    const rb = tool.readBack;
    if (!rb || ctx.contract !== 2 || ctx.via === 'script') return null;
    const r = ctx.bundle.build.tools.find((x) => x.name === rb.tool);
    if (!r || r.risk.write) return null;
    const a: Record<string, unknown> = {};
    for (const k of Array.isArray(r.inputSchema.required) ? (r.inputSchema.required as string[]) : []) {
      if (args[k] === undefined) return null;
      a[k] = args[k];
    }
    const out = await this.invoke(ctx, r.name, a);
    if (!out.ok || !out.value || typeof out.value !== 'object') return null;
    return readBackView(tool, args, out.value, rb.label);
  }

  /** A write plan with the target's human label and current values (overlay readBack, contract 2). */
  private async labelled(ctx: RunContext, tool: ToolDef, args: Record<string, unknown>, p: WritePlan): Promise<WritePlan> {
    const rb = await this.readBack(ctx, tool, args);
    return rb ? { ...p, target: rb.label, before: rb.values } : p;
  }

  /** Contract 2: the prod approval prompt also says what the write does and whether it can be undone. */
  confirmMessageV2(ctx: RunContext, tool: ToolDef, args: Record<string, unknown>): string {
    const p = writePlan(tool, args);
    return `${this.confirmMessage(ctx, tool, args)}\nEffect: ${p.effect}${p.target ? ` (${p.target})` : ''}\n${p.reversible ? 'Can be undone.' : 'Irreversible.'}`;
  }

  confirmMessage(ctx: RunContext, tool: ToolDef, args: Record<string, unknown>): string {
    const p = this.plannedChange(tool, args, true, '');
    const summary = Object.entries(args)
      .slice(0, 8)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 60) : JSON.stringify(v)?.slice(0, 60)}`)
      .join(', ');
    return `Allow ${ctx.client.name ?? 'this agent'} to ${tool.title || tool.name} in ${envLabel(ctx)}?\n${p.method} ${p.path}\n${summary}`;
  }

  private async callMock(ctx: RunContext, tool: ToolDef, specArgs: Record<string, unknown>, extraQuery: Record<string, string | string[]> = {}): Promise<UpstreamResponse> {
    // bound to the authenticated request: its tenant, its environment, `env` unless an eval namespace was accepted (G13)
    const ns = { tenantId: ctx.tenantId, environmentId: ctx.environment.id, name: ctx.mockNamespace ?? 'env' };
    const started = this.d.now();
    let method = 'POST';
    let path = '/graphql';
    let query: Record<string, string | string[]> = {};
    let body: unknown;
    const headers: Record<string, string> = {};
    if (tool.binding.type === 'http') {
      const req = buildHttpRequest(tool, specArgs, { baseUrl: MOCK_BASE, headers: {}, allowedHosts: ['mock.invalid'], credentials: { headers: {}, query: {} }, extraQuery }, this.d.version);
      method = req.method;
      path = req.url.pathname;
      query = {};
      for (const [k, v] of req.url.searchParams) {
        const prev = query[k];
        query[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
      }
      body = req.body !== undefined ? JSON.parse(req.body) : undefined;
      Object.assign(headers, req.headers);
      // contract 2 follows the mock's next-page tokens, so they must be real ones
      if (ctx.contract === 2) headers[MOCK_PAGING_HEADER] = 'tokens';
    } else if (tool.binding.type === 'graphql') {
      path = tool.binding.endpointPath ?? '/graphql';
      body = { query: tool.binding.document, variables: Object.fromEntries(tool.binding.variables.map((v) => [v.name, specArgs[v.arg]]).filter(([, v]) => v !== undefined)) };
    }
    const res = await this.d.mock.handle({ ns, method, path, query, headers, body, mockModel: ctx.bundle.build.mockModel() });
    const json = res.body === undefined ? '' : JSON.stringify(res.body);
    return { status: res.status, body: res.body ?? null, bytes: Buffer.byteLength(json ?? ''), headers: Object.fromEntries(Object.entries(res.headers ?? {}).filter(([k]) => /^(link|retry-after|x-ratelimit-.*)$/i.test(k)).map(([k, v]) => [k.toLowerCase(), v])), latencyMs: this.d.now() - started };
  }
}

/** The base URL the in-process mock is addressed with (Link URLs from the mock resolve against it). */
const MOCK_BASE = 'http://mock.invalid';

/** The default page size of a tool's upstream page-size argument (page/offset arithmetic). */
function sizeDefault(tool: ToolDef, plan: PagingPlan): number | undefined {
  if (!plan.size) return undefined;
  const p = (tool.inputSchema.properties as Record<string, { default?: unknown }> | undefined)?.[plan.size.arg];
  return typeof p?.default === 'number' ? p.default : undefined;
}

/** `PROD` for production environments (the confirmation prompts say so loudly), else the environment slug. */
export function envLabel(ctx: Pick<RunContext, 'environment'>): string {
  return ctx.environment.kind === 'prod' ? 'PROD' : `the ${ctx.environment.slug} environment`;
}

function lower(h: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));
}
