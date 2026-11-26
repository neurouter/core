import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { generateOpsStub, generateStubs, pyArgMap } from '@neurouter/compiler';
import type { Executor, HostCallResult, RunResult } from '@neurouter/executor';
import { META_CALL_ID, META_PLANNED_CHANGES, META_RESULT_HANDLE, META_TASK_ID, META_TRUNCATED, SCRIPT_BUILTIN_ALTERNATIVES, scriptBuiltinsLine, type ErrorCode, type ScriptStatus, type ToolDef } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { sha256Hex } from '../../kernel/lib/crypto.js';
import { newId } from '../../kernel/lib/ids.js';
import { toJsonColumn } from '../../kernel/lib/json.js';
import type { Metrics } from '../../kernel/observability/metrics.js';
import type { ResultPages } from '../shaping/result-pages.js';
import type { TaskTracker } from '../tasks/tracker.js';
import type { RunContext } from '../pipeline/context.js';
import { errorResult } from '../pipeline/errors.js';
import { errorDraft, okDraft, type Draft, type ErrorSpec } from '../envelope/draft.js';
import { errorInfoFor } from '../envelope/render.js';
import { closestNames } from '../envelope/relations.js';
import type { Call, EnvelopeErrorCode, ErrorInfo } from '../envelope/types.js';
import { NO_RESULT, v1Result } from '../envelope/v1.js';
import { envLabel, killSwitchFor, resolveVisibleTool, writeEnabled, type Confirmer, type McpToolResult, type Pipeline, type PlannedChange } from '../pipeline/pipeline.js';
import type { OpsTools } from '../ops/ops.js';
import { opFor } from '../ops/ops.js';
import { validateScript } from './validate.js';
import { wrapScript } from './wrap.js';

/** Ops helpers forwarded to the host (parallel / days_since / now run inside the executor). */
export const SCRIPT_OPS = ['log_decision', 'report_unmet_need', 'report_issue'] as const;

export const RUN_SCRIPT_DEFINITION = {
  name: 'run_script',
  title: 'Run a Python script against the API',
  description:
    'Run a short Python script that calls API tools as functions (e.g. <namespace>.<function>(arg=...)) and returns a JSON-serializable value with `return`. No imports, no files, no network: only the tool functions, built-ins (len, sorted, isinstance, type, iter/next, …; no map/filter/getattr) and ops.* helpers. Tool results are whole dicts/lists inside scripts (no maxItems/maxBytes cuts); the script result limit applies to what you return. Use mode="dry_run" to see planned writes without executing them. Get function signatures from search_tools.',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', minLength: 1, maxLength: 16384 },
      mode: { type: 'string', enum: ['dry_run', 'execute'], default: 'execute' },
      inputs: { type: 'object', description: 'Values bound as global variables', default: {} },
    },
    required: ['code'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
};

export interface RunScriptDeps {
  db: Kysely<MainDB>;
  executor: () => Executor | null;
  pipeline: Pipeline;
  ops: OpsTools;
  tracker: TaskTracker;
  audit: AuditRecorder;
  pages: ResultPages;
  metrics?: Metrics;
  now: () => number;
  log: { warn: (o: object, m: string) => void };
  /** Is the executor healthy right now (cached by the health loop)? */
  healthy: () => boolean;
}

interface Phase {
  name: 'validate' | 'type_check' | 'execute';
  status: 'ok' | 'failed' | 'skipped';
  durationMs: number;
}

const MAX_CONCURRENT_PER_PRINCIPAL = 2;

/** Contract 2: the Python exception a tool error raises inside a script (its message is the error object as JSON). */
const PY_ERROR: Partial<Record<EnvelopeErrorCode, string>> = {
  not_found: 'LookupError',
  invalid_args: 'ValueError',
  unknown_tool: 'AttributeError',
  forbidden: 'PermissionError',
  writes_disabled: 'PermissionError',
  policy_denied: 'PermissionError',
  confirmation_required: 'PermissionError',
  confirmation_declined: 'PermissionError',
  confirmation_unsupported: 'PermissionError',
  timeout: 'TimeoutError',
};

/** A JSON value as a Python literal. */
function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`).join(', ')}}`;
}

/** An API tool call as the `run_script` call that makes it (next calls inside code mode). */
function asScriptCall(call: Call, tools: ToolDef[]): Call {
  const t = tools.find((x) => x.name === call.tool);
  if (!t) return call;
  const inv = Object.fromEntries(Object.entries(pyArgMap(t)).map(([py, arg]) => [arg, py]));
  const kw = Object.entries(call.args).map(([k, v]) => `${inv[k] ?? k}=${pyLiteral(v)}`).join(', ');
  return { tool: 'run_script', args: { code: `return ${t.pyName}(${kw})` } };
}

export interface ScriptReply {
  result: McpToolResult;
  draft: Draft;
  inputRequired?: unknown;
}

/** How a script run is addressed in next calls (run_script itself, or the composite tool that wraps it). */
export interface ScriptCallAs {
  name: string;
  args: Record<string, unknown>;
}
const QUEUE_WAIT_MS = 5000;

/** Allowed functions for the principal: visible tools ∩ static ACL (steps 1–4 of §9.6, evaluated per tool). */
export function allowedTools(ctx: RunContext): ToolDef[] {
  return ctx.bundle.build.tools.filter((t) => {
    if (t.kind === 'composite' || !resolveVisibleTool(ctx, t.name)) return false;
    if (!ctx.principal.scopes.includes('tools:read')) return false;
    if (killSwitchFor(ctx, t, t.risk.write ? ['all', 'writes', 'code_mode'] : ['all', 'code_mode'])) return false;
    if (t.risk.write && (!ctx.principal.scopes.includes('tools:write') || !writeEnabled(ctx, t))) return false;
    return true;
  });
}

/** A call of a real tool of this server for the run_script example: spec/overlay example args, else placeholders. */
export function exampleCall(tools: ToolDef[]): string | null {
  const t = tools.find((x) => !x.risk.write && x.examples.length) ?? tools.find((x) => !x.risk.write) ?? tools[0];
  if (!t) return null;
  const props = (t.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const req = Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : [];
  const ex = t.examples[0]?.arguments ?? {};
  const py = (v: unknown): string => (v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'number' ? String(v) : '...');
  const placeholder = (p: Record<string, unknown> | undefined): string => (Array.isArray(p?.enum) && p.enum.length ? py(p.enum[0]) : p?.type === 'integer' || p?.type === 'number' ? '1' : p?.type === 'boolean' ? 'True' : '"..."');
  const map = pyArgMap(t);
  const inv = Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
  const args = req.slice(0, 4).map((a) => `${inv[a] ?? a}=${a in ex ? py(ex[a]) : placeholder(props[a])}`);
  return `${t.pyName}(${args.join(', ')})`;
}

/**
 * The run_script entry for this principal: the example names a real function of the server, and the
 * annotations say what a script can do here (writes possible → not read-only; destructive when any
 * callable tool is destructive).
 */
export function runScriptEntry(ctx: RunContext): typeof RUN_SCRIPT_DEFINITION & { annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } } {
  const tools = allowedTools(ctx);
  const call = exampleCall(tools);
  const writes = tools.some((t) => t.risk.write);
  const description = call ? RUN_SCRIPT_DEFINITION.description.replace('(e.g. <namespace>.<function>(arg=...))', `(e.g. ${call})`) : RUN_SCRIPT_DEFINITION.description;
  return { ...RUN_SCRIPT_DEFINITION, description, annotations: { readOnlyHint: !writes, destructiveHint: tools.some((t) => t.risk.write && t.risk.destructive), idempotentHint: false, openWorldHint: true } };
}

/** Whether `run_script` is available to this principal (§9.3). */
export function codeModeAvailable(ctx: RunContext, healthy: boolean): boolean {
  const b = ctx.bundle;
  return b.codeModeEnabled && b.environment.codeMode && healthy && ctx.principal.scopes.includes('code:run') && !killSwitchFor(ctx, null, ['code_mode', 'all']) && b.server.exposure.mode !== 'tools';
}

/**
 * `run_script` (§10.2): admission → task → validate (recipe cache) → per-principal stubs → executor
 * run with host calls through the same pipeline (`via: 'script'`) → result (truncated with a handle) →
 * `script_runs` row + one `script_run` audit row (+ one `tool_call` row per inner call).
 * Prod with writes: automatic dry run, one elicitation with the planned changes, then an execute run
 * bound to the approved plan (§9.7).
 */
export class ScriptRunner {
  private readonly validated = new Map<string, ReturnType<typeof validateScript>>();
  private readonly running = new Map<string, number>();
  private readonly stubCache = new Map<string, Record<string, string>>();

  constructor(private readonly d: RunScriptDeps) {}

  async run(ctx: RunContext, args: Record<string, unknown>, confirmer: Confirmer | null, signal?: AbortSignal, opts: { allowWithoutScope?: boolean; callAs?: ScriptCallAs } = {}): Promise<ScriptReply> {
    const code = typeof args.code === 'string' ? args.code : '';
    const mode = args.mode === 'dry_run' ? 'dry_run' : 'execute';
    const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? (args.inputs as Record<string, unknown>) : {};
    const callAs = opts.callAs ?? { name: 'run_script', args };
    const early = (message: string, code_: 'script_rejected' | 'executor_unavailable' | 'executor_busy', spec: Partial<ErrorSpec> = {}, extra: { retryAfterMs?: number } = {}): ScriptReply => ({
      result: errorResult(message, null, code_, extra),
      draft: errorDraft({ code: code_, message, name: callAs.name, args: callAs.args, next: [], ...(extra.retryAfterMs !== undefined ? { retryAfterMs: extra.retryAfterMs } : {}), ...spec }),
    });
    if (!code) return early('run_script needs `code`', 'script_rejected', { code: 'invalid_args', text: 'run_script needs `code` (a Python script); nothing was run.', issues: [{ path: '', keyword: 'required', params: { missingProperty: 'code' }, message: 'required' }] });
    if (Buffer.byteLength(code, 'utf8') > 16 * 1024) return early('Script larger than 16 KiB', 'script_rejected', { code: 'too_large', text: 'The script is larger than 16 KiB; nothing was run.' });
    const executor = this.d.executor();
    if (!executor || !(opts.allowWithoutScope ? this.d.healthy() && ctx.bundle.codeModeEnabled && !killSwitchFor(ctx, null, ['code_mode', 'all']) : codeModeAvailable(ctx, this.d.healthy()))) return early('Code mode is not available in this environment.', 'executor_unavailable', { text: 'Code mode is not available in this environment; call the API tools directly. Nothing was run.' });

    // per-principal concurrency (≤ 2), wait ≤ 5 s
    const key = ctx.credentialKey;
    const deadline = this.d.now() + QUEUE_WAIT_MS;
    while ((this.running.get(key) ?? 0) >= MAX_CONCURRENT_PER_PRINCIPAL) {
      if (this.d.now() > deadline) return early('Too many scripts running for this credential; retry shortly.', 'executor_busy', { next: [{ tool: callAs.name, args: callAs.args }] }, { retryAfterMs: 2000 });
      await new Promise((r) => setTimeout(r, 50));
    }
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    try {
      // writes that need confirmation (prod, or confirm set elsewhere): dry run first, then elicit once with the plan (§9.7)
      const confirmMode = ctx.bundle.environment.writes.confirm;
      const confirmWrites = ctx.bundle.environment.writes.enabled && confirmMode !== 'none';
      if (mode === 'execute' && confirmWrites) {
        const dry = await this.runOnce(executor, ctx, code, 'dry_run', inputs, callAs, signal, true);
        if (dry.status !== 'ok') return { result: dry.result, draft: dry.draft };
        if (dry.planned.length) {
          const listed = dry.planned.slice(0, 20).map((p) => `- ${p.method} ${p.path} (${p.tool})`).join('\n');
          const synthetic: ToolDef = { ...ctx.bundle.build.tools.find((t) => t.name === dry.planned[0]!.tool)!, name: 'run_script', title: `run a script with ${dry.planned.length} write(s)` };
          const planHash = sha256Hex(JSON.stringify(dry.planned.map((p) => `${p.tool}|${p.argsHash}`)));
          const out = confirmer ? await confirmer.confirm({ tool: synthetic, args: { code_hash: sha256Hex(code), plan: planHash }, argsHash: planHash, message: `Allow ${ctx.client.name ?? 'this agent'} to run a script that makes ${dry.planned.length} change(s) in ${envLabel(ctx)}?\n${listed}` }) : ({ status: 'unsupported' } as const);
          if (out.status === 'pending') return { result: NO_RESULT, draft: errorDraft({ code: 'confirmation_required', message: 'Waiting for the user to confirm.' }), inputRequired: out.result };
          if (out.status !== 'approved') {
            const where = envLabel(ctx);
            if (out.status === 'unsupported' && confirmMode === 'elicit') {
              // elicit: the dry run already ran; return its plan (nothing was executed) for the user to review
              const planned = dry.planned.map((p) => ({ tool: p.tool, method: p.method, path: p.path, arguments: p.arguments }));
              const r = await this.finishRejected(ctx, code, 'execute', 'confirm_declined', `Not executed: this client cannot ask the user to confirm writes in ${where}. The dry run planned ${planned.length} change(s), none made:\n${listed}\nShow them to the user; they can approve the script from a client with MCP elicitation support.`, 'confirmation_unsupported');
              const draft = errorDraft({ code: 'confirmation_unsupported', message: '', text: `The script makes ${planned.length} change(s) that need your user's approval in ${where}, and this client cannot ask; nothing changed. Show data.plan to the user.`, name: callAs.name, args: callAs.args, next: [] }, { write: true, data: { plan: planned.map((p) => ({ tool: p.tool, method: p.method, path: p.path, args: p.arguments })) } });
              return { result: { ...r, _meta: { ...(r._meta ?? {}), [META_PLANNED_CHANGES]: planned } }, draft };
            }
            const message = out.status === 'unsupported' ? `This client cannot ask the user to confirm writes in ${where}; the script was not run.` : 'The user declined the planned changes.';
            const r = await this.finishRejected(ctx, code, 'execute', 'confirm_declined', message, out.status === 'unsupported' ? 'confirmation_unsupported' : 'confirmation_declined');
            return { result: r, draft: errorDraft({ code: out.status === 'unsupported' ? 'confirmation_unsupported' : 'confirmation_declined', message: `${message} Nothing changed.`, name: callAs.name, args: callAs.args, next: [] }) };
          }
          const plan = new Set(dry.planned.map((p) => `${p.tool}|${p.argsHash}`));
          const run = await this.runOnce(executor, { ...ctx, approvedPlan: plan }, code, 'execute', inputs, callAs, signal);
          return { result: run.result, draft: run.draft };
        }
      }
      const run = await this.runOnce(executor, ctx, code, mode, inputs, callAs, signal);
      return { result: run.result, draft: run.draft };
    } finally {
      this.running.set(key, (this.running.get(key) ?? 1) - 1);
    }
  }

  private async finishRejected(ctx: RunContext, code: string, mode: 'dry_run' | 'execute', status: ScriptStatus, message: string, errorCode?: ErrorCode): Promise<McpToolResult> {
    const id = newId();
    const now = this.d.now();
    await this.d.db.insertInto('script_runs').values({ id, tenant_id: ctx.tenantId, task_id: ctx.taskId, server_id: ctx.server.id, environment_id: ctx.environment.id, user_id: null, credential_key: ctx.credentialKey, code: code.slice(0, 16384), code_hash: sha256Hex(code), mode, status, error: toJsonColumn({ type: status, message }), started_at: now, ended_at: now }).execute();
    this.d.audit.record({ ...this.d.pipeline.auditBase(ctx), kind: 'script_run', toolName: 'run_script', scriptRunId: id, decision: 'denied_confirmation', status: 'blocked', params: { code_hash: sha256Hex(code), mode }, errorMessage: message });
    return errorResult(message, null, errorCode ?? (status === 'confirm_declined' ? 'confirmation_declined' : 'script_rejected'));
  }

  /**
   * Contract-2 form of a run: `data` = the script's return value (dry run: `{result, plan}`), `truncated` when
   * the value is over the result limit, `state.left` / `script_calls`, and errors without tracebacks (a tool
   * error the script did not catch keeps its code and next calls).
   */
  private scriptDraft(
    ctx: RunContext,
    status: ScriptStatus,
    body: { error?: Record<string, unknown>; truncated?: boolean; preview?: unknown; valueBytes?: number },
    value: unknown,
    mode: 'dry_run' | 'execute',
    planned: PlannedChange[],
    callAs: ScriptCallAs,
    budget: { calls: number; left: { calls: number; seconds: number } },
    innerErrors: Map<string, ErrorInfo>,
    meta: Record<string, unknown>,
  ): Draft {
    const extra = { left: budget.left, scriptCalls: budget.calls, meta, ...(mode === 'dry_run' ? { flags: ['dry_run' as const] } : {}), ...(planned.length ? { write: true } : {}) };
    if (status === 'ok') {
      const plan = planned.map((p) => ({ tool: p.tool, method: p.method, path: p.path, args: p.arguments }));
      const data = mode === 'dry_run' ? { result: value, plan } : value;
      if (!body.truncated) return okDraft(data, extra);
      const shown = typeof body.preview === 'string' ? Buffer.byteLength(body.preview) : 0;
      return okDraft(data, {
        ...extra,
        truncated: { omitted_bytes: Math.max(0, (body.valueBytes ?? shown) - shown), next: { tool: callAs.name, args: callAs.args } },
        hint: `The return value (${body.valueBytes ?? '?'} bytes) is over the script result limit; data is its first part. Return less: filter, count or slice inside the script.`,
      });
    }
    const e = body.error ?? {};
    const raw = String(e.message ?? '').replace(/__neurouter_main__/g, 'script');
    const line = typeof e.line === 'number' ? e.line : undefined;
    const base = { name: callAs.name, args: callAs.args, ...(line !== undefined ? { line } : {}) };
    // an uncaught tool error: the message is the error object raised into the script
    const inner = [...innerErrors.entries()].find(([json]) => raw.includes(json))?.[1];
    if (inner) return errorDraft({ code: inner.code, message: inner.message, info: inner, ...base }, extra);
    const msg = (s: string) => (s.length <= 200 ? s : `${s.slice(0, 199)}…`);
    switch (status) {
      case 'rejected':
        return errorDraft({ code: 'script_rejected', message: raw, text: msg(`Script rejected: ${raw}${e.hint ? ` ${String(e.hint)}` : ''}`), next: [], ...base }, extra);
      case 'type_error':
      case 'syntax_error':
        return errorDraft({ code: 'script_type_error', message: raw, text: msg(`${status === 'syntax_error' ? 'Syntax error' : 'Type error'}: ${raw.split('\n')[0]}${e.hint ? ` ${String(e.hint)}` : ''}`), next: [], ...base }, extra);
      case 'limit_exceeded':
        return errorDraft({ code: 'script_limit', message: raw, text: msg(`Script limit exceeded: ${raw}. Do less per script.`), next: [], ...base }, extra);
      case 'executor_unavailable':
        return errorDraft({ code: 'executor_unavailable', message: raw, text: 'Code mode failed to run the script; nothing was run. Call the API tools directly.', next: [], ...base }, extra);
      case 'cancelled':
        return errorDraft({ code: 'unavailable', message: raw, text: 'The script was cancelled.', retry: 'yes', next: [], ...base }, extra);
      default:
        return errorDraft({ code: 'script_error', message: raw, text: msg(`${String(e.type ?? 'Error')}: ${raw.split('\n')[0]}${e.hint ? ` ${String(e.hint)}` : ''}`), next: [], ...base }, extra);
    }
  }

  /** Stubs regenerated from the filtered tool list, cached by (build, allowedSetHash). */
  private stubsFor(ctx: RunContext, tools: ToolDef[], ns: string): Record<string, string> {
    const ops = SCRIPT_OPS.filter((o) => ctx.bundle.server.opsTools[o]);
    const k = `${ctx.bundle.build.id}|${sha256Hex(tools.map((t) => t.name).join(','))}|${ops.join(',')}`;
    const hit = this.stubCache.get(k);
    if (hit) return hit;
    const out = { [ns]: generateStubs(tools, ns, { buildHash: ctx.bundle.build.hash }), ops: generateOpsStub(ops) };
    if (this.stubCache.size > 200) this.stubCache.clear();
    this.stubCache.set(k, out);
    return out;
  }

  private async runOnce(executor: Executor, ctx0: RunContext, code: string, mode: 'dry_run' | 'execute', inputs: Record<string, unknown>, callAs: ScriptCallAs, signal: AbortSignal | undefined, planOnly = false): Promise<{ status: ScriptStatus; result: McpToolResult; planned: PlannedChange[]; draft: Draft }> {
    const started = this.d.now();
    const runId = newId();
    const codeHash = sha256Hex(code);
    const phases: Phase[] = [];
    const planned: PlannedChange[] = [];
    const lim = ctx0.bundle.environment.limits.code;
    // task: attach, or open one with framing 'script'
    let taskId = ctx0.taskId;
    if (!taskId) {
      const p = ctx0.principal;
      taskId = await this.d.tracker.create(
        { tenantId: ctx0.tenantId, serverId: ctx0.server.id, environmentId: ctx0.environment.id, credentialKey: ctx0.credentialKey, clientName: ctx0.client.name, clientVersion: ctx0.client.version, principalType: p.type, userId: p.type === 'external' ? null : p.userId, apiKeyId: p.type === 'api_key' ? p.apiKeyId : null, oauthClientId: p.type === 'user' ? p.oauthClientId : null, traceId: null, origin: ctx0.origin },
        'script',
        null,
      );
    }
    const ctx: RunContext = { ...ctx0, taskId, via: 'script', mode: 'code', scriptRunId: runId, dryRun: mode === 'dry_run' };
    // the run shows on the request's gateway span; each inner upstream call gets its own client span
    ctx.trace?.setAttribute(mode === 'dry_run' ? 'neurouter.script_run_id.dry_run' : 'neurouter.script_run_id', runId);
    await this.d.db.insertInto('script_runs').values({ id: runId, tenant_id: ctx.tenantId, task_id: taskId, server_id: ctx.server.id, environment_id: ctx.environment.id, user_id: ctx.principal.type === 'external' ? null : ctx.principal.userId, credential_key: ctx.credentialKey, code: code.slice(0, 16384), code_hash: codeHash, mode, status: 'running', started_at: started }).execute();

    const ns = ctx.server.slug.replace(/-/g, '_');
    const finish = async (status: ScriptStatus, body: { value?: unknown; error?: Record<string, unknown>; stats?: Record<string, unknown>; stdout?: string; truncated?: boolean; preview?: unknown; valueBytes?: number }): Promise<{ status: ScriptStatus; result: McpToolResult; planned: PlannedChange[]; draft: Draft }> => {
      const ended = this.d.now();
      const stats = { wallMs: ended - started, toolCalls: calls, blockedCalls: blocked, suspensions: calls, ...(body.stats ?? {}) };
      let handle: string | null = null;
      let value = body.value;
      if (body.truncated) {
        handle = await this.d.pages.store(ctx.tenantId, ctx.credentialKey, body.preview ?? null);
        value = body.preview;
      }
      const auditId = newId();
      const preview = value === undefined ? null : JSON.stringify(value).slice(0, 8192);
      await this.d.db
        .updateTable('script_runs').where('tenant_id', '=', ctx.tenantId)
        .set({ status, error: body.error ? toJsonColumn(body.error) : null, result_preview: preview === null ? null : toJsonColumn(safeParse(preview)), result_bytes: body.valueBytes ?? (preview ? Buffer.byteLength(preview) : 0), result_handle: handle, planned_changes: toJsonColumn(planned.map(({ argsHash: _h, ...p }) => p)), stats: toJsonColumn(stats), phases: toJsonColumn(phases), stdout: body.stdout ? body.stdout.slice(0, 16384) : null, audit_id: auditId, ended_at: ended })
        .where('id', '=', runId)
        .execute();
      this.d.audit.record({
        ...this.d.pipeline.auditBase(ctx),
        id: auditId,
        kind: 'script_run',
        toolName: 'run_script',
        scriptRunId: runId,
        via: ctx0.via,
        decision: mode === 'dry_run' ? 'dry_run' : ctx.approvedPlan ? 'confirmed' : 'allowed',
        status: status === 'ok' ? 'ok' : status === 'limit_exceeded' ? 'limit_exceeded' : status === 'cancelled' ? 'cancelled' : status === 'rejected' || status === 'confirm_declined' ? 'blocked' : 'script_error',
        params: { code, code_hash: codeHash, mode, inputs },
        output: value ?? null,
        latencyMs: ended - started,
        dryRun: mode === 'dry_run',
        errorMessage: body.error ? String(body.error.message ?? '').slice(0, 1000) : null,
      });
      this.d.tracker.bump(taskId, { script_count: 1 });
      this.d.metrics?.scriptRuns.inc({ server: ctx.server.slug, environment: ctx.environment.slug, mode, status });
      this.d.metrics?.scriptDuration.observe({ status }, (ended - started) / 1000);
      this.d.metrics?.scriptToolCalls.observe(calls);
      const structured: Record<string, unknown> = { status, result: value ?? null, stats, ...(mode === 'dry_run' || planned.length ? { planned_changes: planned.map(({ argsHash: _h, ...p }) => p) } : {}), ...(body.error ? { error: body.error } : {}), ...(body.stdout ? { stdout: body.stdout.slice(0, 16384) } : {}) };
      const meta: Record<string, unknown> = { [META_CALL_ID]: auditId, [META_TASK_ID]: taskId, 'dev.neurouter/script-run-id': runId };
      if (handle) {
        meta[META_RESULT_HANDLE] = handle;
        meta[META_TRUNCATED] = { totalBytes: body.valueBytes ?? 0, returnedBytes: Buffer.byteLength(JSON.stringify(value ?? null)) };
      }
      const isError = status !== 'ok';
      const text = JSON.stringify(structured);
      const draft = this.scriptDraft(ctx, status, body, value ?? null, mode, planned, callAs, { calls, left: { calls: Math.max(0, lim.maxToolCalls - calls), seconds: Math.max(0, Math.floor((lim.wallTimeSec * 1000 - (ended - started)) / 1000)) } }, innerErrors, { [META_CALL_ID]: auditId, [META_TASK_ID]: taskId, 'dev.neurouter/script-run-id': runId });
      return { status, planned, result: v1Result(text.length > 8192 ? `${text.slice(0, 8150)}… (truncated preview)` : text, structured, meta, isError), draft };
    };
    /** contract 2: the error objects raised into the script (by JSON message), so an uncaught one becomes the run's error */
    const innerErrors = new Map<string, ErrorInfo>();
    let calls = 0;
    let blocked = 0;

    // validate (cached by code hash)
    const t0 = this.d.now();
    let v = this.validated.get(codeHash);
    if (!v) {
      v = validateScript(code, { namespaces: [ns, 'ops'] });
      if (this.validated.size > 1000) this.validated.delete(this.validated.keys().next().value!);
      this.validated.set(codeHash, v);
    }
    phases.push({ name: 'validate', status: v.ok ? 'ok' : 'failed', durationMs: this.d.now() - t0 });
    if (!v.ok) {
      phases.push({ name: 'type_check', status: 'skipped', durationMs: 0 }, { name: 'execute', status: 'skipped', durationMs: 0 });
      const e = v.errors[0]!;
      return finish('rejected', { error: { type: 'rejected', message: e.message, line: e.line, col: e.col, hint: e.hint, errors: v.errors } });
    }

    const tools = allowedTools(ctx);
    const byFn = new Map(tools.map((t) => [t.pyName, t]));
    const stubs = this.stubsFor(ctx, tools, ns);
    const opsFns = SCRIPT_OPS.filter((o) => ctx.bundle.server.opsTools[o]);
    const capability = `rc_${randomBytes(32).toString('base64url')}`;
    const wrapped = wrapScript(code);
    const v2 = ctx.contract === 2;
    const sem = new Semaphore(lim.maxConcurrentCalls);

    const host = {
      call: async (fn: string, kwargs: Record<string, unknown>): Promise<HostCallResult> => {
        if (calls >= lim.maxToolCalls) return { ok: false, error: { code: 'limit_exceeded', message: `${lim.maxToolCalls} tool calls` } };
        calls++;
        return sem.run(async () => {
          const raise = (info: ErrorInfo): HostCallResult => {
            const message = JSON.stringify(info);
            innerErrors.set(message, info);
            return { ok: false, error: { code: info.code, message, ...(PY_ERROR[info.code] ? { pyType: PY_ERROR[info.code] } : { pyType: 'RuntimeError' }) } } as HostCallResult;
          };
          const unknownFn = async (): Promise<HostCallResult> => raise(await errorInfoFor(ctx, { code: 'unknown_tool', message: '', text: `No function ${fn} in this script's namespaces; nothing was called.`, name: fn, closest: closestNames(fn, [...byFn.keys()]), next: [{ tool: 'search_tools', args: { query: fn.split('.').pop() ?? fn } }] }));
          if (fn.startsWith('ops.')) {
            const op = opFor(ctx, fn);
            if (!op || !(SCRIPT_OPS as readonly string[]).includes(op)) return v2 ? unknownFn() : { ok: false, error: { code: 'unknown_tool', message: `Tool not found or not permitted: ${fn}` } };
            const r = await this.d.ops.call(ctx, op, kwargs);
            return { ok: true, value: r.value };
          }
          const t = byFn.get(fn);
          if (!t) {
            blocked++;
            return v2 ? unknownFn() : { ok: false, error: { code: 'unknown_tool', message: `Tool not found or not permitted: ${fn}` } };
          }
          const map = pyArgMap(t);
          const argsIn: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(kwargs)) argsIn[map[k] ?? k] = val;
          const out = await this.d.pipeline.invoke(ctx, t.name, argsIn, { planned, ...(signal ? { signal } : {}) });
          if (!out.ok) {
            blocked += out.decision.startsWith('denied_') ? 1 : 0;
            if (v2 && out.draft.error) {
              // next calls name API tools; inside a script they become run_script calls of the same function
              const info = await errorInfoFor(ctx, out.draft.error);
              return raise({ ...info, next: info.next.map((c) => asScriptCall(c, tools)) });
            }
            return { ok: false, error: { code: out.error?.code ?? 'tool_error', message: out.error?.message ?? 'tool call failed', ...(out.error?.errorId ? { errorId: out.error.errorId } : {}) } };
          }
          return { ok: true, value: out.value ?? null };
        });
      },
    };

    const wall = new AbortController();
    const timer = setTimeout(() => wall.abort(new Error('wall time')), lim.wallTimeSec * 1000);
    const onAbort = () => wall.abort(new Error('cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const t1 = this.d.now();
    let res: RunResult;
    try {
      res = await executor.run(
        {
          runId,
          capability,
          code: wrapped.code,
          lineOffset: wrapped.lineOffset,
          colOffset: wrapped.colOffset,
          modules: { [ns]: { functions: tools.map((t) => t.pyName.split('.').slice(1).join('.')), stubs: stubs[ns]! }, ops: { functions: [...opsFns], stubs: stubs.ops! } },
          inputs,
          limits: { cpuTimeSec: lim.cpuTimeSec, wallTimeSec: lim.wallTimeSec, maxMemoryMb: lim.maxMemoryMb, maxToolCalls: lim.maxToolCalls, maxConcurrentCalls: lim.maxConcurrentCalls, maxResultBytes: lim.maxResultBytes },
          osPolicy: { datetime: new Date(started).toISOString(), seed: parseInt(sha256Hex(runId).slice(0, 8), 16) },
          typeCheck: true,
        },
        host,
        wall.signal,
      );
    } catch (err) {
      this.d.log.warn({ err }, 'executor run failed');
      phases.push({ name: 'type_check', status: 'skipped', durationMs: 0 }, { name: 'execute', status: 'failed', durationMs: this.d.now() - t1 });
      return finish('executor_unavailable', { error: { type: 'executor_unavailable', message: (err as Error).message } });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
    if (wall.signal.aborted && res.status === 'cancelled' && !signal?.aborted) res = { ...res, status: 'limit_exceeded', error: { type: 'TimeoutError', message: `wall time ${lim.wallTimeSec}s exceeded` } };
    if (res.status === 'crashed') this.d.metrics?.executorCrashes.inc();
    const execMs = this.d.now() - t1;
    if (res.status === 'type_error' || res.status === 'syntax_error') phases.push({ name: 'type_check', status: 'failed', durationMs: execMs }, { name: 'execute', status: 'skipped', durationMs: 0 });
    else phases.push({ name: 'type_check', status: 'ok', durationMs: 0 }, { name: 'execute', status: res.status === 'ok' ? 'ok' : 'failed', durationMs: execMs });
    void planOnly;
    return finish(res.status as ScriptStatus, { value: res.value, ...(res.error ? { error: withBuiltinHint({ ...res.error }) } : {}), stats: { wallMs: res.stats.wallMs, suspensions: res.stats.suspensions, toolCalls: calls }, stdout: res.stdout, truncated: res.truncated === true, preview: res.preview, valueBytes: res.valueBytes });
  }
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return { preview: s };
  }
}

class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(private readonly max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

/**
 * Monty reports an unsupported built-in as "Name `map` used when not defined": say what scripts can use
 * instead (agents otherwise retry the same call or guess).
 */
export function withBuiltinHint(error: Record<string, unknown>): Record<string, unknown> {
  const m = /Name `([A-Za-z_][A-Za-z0-9_]*)` used when not defined/.exec(String(error.message ?? ''));
  if (!m || error.hint) return error;
  const alt = SCRIPT_BUILTIN_ALTERNATIVES[m[1]!];
  return { ...error, hint: `${alt ? `${m[1]} is not available in scripts: ${alt}. ` : ''}${scriptBuiltinsLine()}` };
}
