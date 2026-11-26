import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { generateOpsStub, generateOpsStubV2, generateStubs, NR_HOST_STUBS, pyArgMap, pyCallText, pyNameMap, scriptApi, scriptCommonTypeStubs, scriptErrorType, scriptPrelude, shapeResponse } from '@neurouter/compiler';
import type { Executor, HostCallResult, RunResult } from '@neurouter/executor';
import { META_CALL_ID, META_PLANNED_CHANGES, META_RESULT_HANDLE, META_TASK_ID, META_TRUNCATED, opsMcpName, READ_RESULT, SCRIPT_BUILTIN_ALTERNATIVES, SCRIPT_RESULT_CHARS, scriptBuiltinsLine, type ErrorCode, type ScriptStatus, type ToolDef } from '@neurouter/shared';
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
import type { Call, EnvelopeErrorCode, ErrorInfo, Truncated } from '../envelope/types.js';
import { NO_RESULT, v1Result } from '../envelope/v1.js';
import { envLabel, killSwitchFor, resolveVisibleTool, writeEnabled, type Confirmer, type McpToolResult, type Pipeline, type PlannedChange } from '../pipeline/pipeline.js';
import type { OpsTools } from '../ops/ops.js';
import { opFor, reportEnabled } from '../ops/ops.js';
import { validateScript } from './validate.js';
import { writePlan, type ConfirmTokens } from '../pipeline/confirm-token.js';
import { CursorError, isNeurouterCursor, type CursorCodec, type CursorPayload } from '../paging/cursor.js';
import { exampleArgs, propsOf } from '../envelope/relations.js';
import { boundArgs, itemsOf, pagingPlan } from '../paging/plan.js';
import { wrapScript } from './wrap.js';

/** A contract-2 run_script value cut to the agent budget (B3). */
interface AgentCut {
  value: unknown;
  truncated: Truncated;
  hint: string;
}

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
  /** contract 2: confirm tokens for scripts with destructive calls outside prod (D5) */
  confirms?: ConfirmTokens;
  /** contract 2: page cursors (`fn.page()` / `Result.next()` / `fn.pages()`), the P2 codec */
  cursors?: CursorCodec;
}

/** What contract-2 code mode is given per run: module stubs, the prelude and the type-check declarations. */
interface ScriptSurface {
  stubs: Record<string, string>;
  prelude?: string;
  typeStubs?: string;
  opsFunctions: string[];
}

interface Phase {
  name: 'validate' | 'type_check' | 'execute';
  status: 'ok' | 'failed' | 'skipped';
  durationMs: number;
}

const MAX_CONCURRENT_PER_PRINCIPAL = 2;

/** A tool error raised into a script (by its `str(e)`), for the run's error when the script does not catch it. */
interface InnerError {
  info: ErrorInfo;
  plan?: unknown;
}

/** Contract 2: the error object `ops.error(e)` returns inside a script (next calls as `{fn, args}` with Python names). */
interface ScriptErrorObject {
  code: EnvelopeErrorCode;
  message: string;
  retry: ErrorInfo['retry'];
  retry_after_ms?: number;
  next: Array<{ fn: string; args: Record<string, unknown> }>;
  fields?: ErrorInfo['fields'];
  closest?: string[];
  upstream?: ErrorInfo['upstream'];
  error_id?: string;
  plan?: unknown;
}

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
function asScriptCall(call: Call, tools: ToolDef[], snake = false): Call {
  const t = tools.find((x) => x.name === call.tool);
  if (!t) return call;
  const inv = pyNameMap(t, { snake });
  const kw = Object.entries(call.args).map(([k, v]) => `${inv[k] ?? k}=${pyLiteral(v)}`).join(', ');
  return { tool: 'run_script', args: { code: `return ${t.pyName}(${kw})` } };
}

/** Contract 2: an envelope error as the script sees it (`ops.error(e)`, `str(e)`): next calls in Python form. */
function scriptErrorObject(info: ErrorInfo, tools: ToolDef[], plan: unknown): { error: ScriptErrorObject; text: string } {
  const next = info.next.map((c) => {
    const t = tools.find((x) => x.name === c.tool);
    if (!t) return { fn: c.tool, args: c.args };
    const names = pyNameMap(t, { snake: true });
    return { fn: t.pyName, args: Object.fromEntries(Object.entries(c.args).map(([k, v]) => [names[k] ?? k, v])) };
  });
  const firstTool = info.next[0] ? tools.find((x) => x.name === info.next[0]!.tool) : undefined;
  const nextText = info.next[0] ? (firstTool ? pyCallText(firstTool, info.next[0].args) : `${info.next[0].tool}(${JSON.stringify(info.next[0].args)})`) : '';
  const fields = info.fields?.map((f) => {
    const t = info.next[0] ? tools.find((x) => x.name === info.next[0]!.tool) : undefined;
    const py = t ? pyNameMap(t, { snake: true })[f.field] : undefined;
    return py ? { ...f, field: py } : f;
  });
  const error: ScriptErrorObject = {
    code: info.code,
    message: info.message,
    retry: info.retry,
    ...(info.retry_after_ms !== undefined ? { retry_after_ms: info.retry_after_ms } : {}),
    next,
    ...(fields?.length ? { fields } : {}),
    ...(info.closest?.length ? { closest: info.closest } : {}),
    ...(info.upstream ? { upstream: info.upstream } : {}),
    ...(info.error_id ? { error_id: info.error_id } : {}),
    ...(plan !== undefined ? { plan } : {}),
  };
  const head = `${info.code}: ${info.message}`;
  return { error, text: nextText && head.length + nextText.length < 380 ? `${head} Next: ${nextText}` : head };
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
export function runScriptEntry(ctx: RunContext): Omit<typeof RUN_SCRIPT_DEFINITION, 'inputSchema'> & { inputSchema: Record<string, unknown> } & { annotations: { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } } {
  const tools = allowedTools(ctx);
  const call = exampleCall(tools);
  const writes = tools.some((t) => t.risk.write);
  const description = ctx.contract === 2 ? runScriptDescriptionV2(ctx, tools) : call ? RUN_SCRIPT_DEFINITION.description.replace('(e.g. <namespace>.<function>(arg=...))', `(e.g. ${call})`) : RUN_SCRIPT_DEFINITION.description;
  const destructive = tools.some((t) => t.risk.write && t.risk.destructive);
  // contract 2 outside prod (D5): scripts with destructive calls run with the confirm token of their dry run
  const confirm = ctx.contract === 2 && destructive && ctx.bundle.environment.writes.confirm === 'none';
  const inputSchema = confirm ? { ...RUN_SCRIPT_DEFINITION.inputSchema, properties: { ...RUN_SCRIPT_DEFINITION.inputSchema.properties, confirm: { type: 'string', description: 'The token from the dry run (data.next / error.next) when the script makes destructive changes.' } } } : RUN_SCRIPT_DEFINITION.inputSchema;
  return { ...RUN_SCRIPT_DEFINITION, description, inputSchema, annotations: { readOnlyHint: !writes, destructiveHint: destructive, idempotentHint: false, openWorldHint: true } };
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
  private readonly stubCache = new Map<string, ScriptSurface>();

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
      // contract 2 outside prod (D5): a script whose dry run plans destructive calls runs only with a confirm token
      // for exactly that plan; the token round is the dry run's answer
      const gated = await this.tokenGate(executor, ctx, code, mode, inputs, args, callAs, signal);
      if (gated) return gated;
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
              const report = ctx.contract === 2 && ctx.bundle.server.opsTools.end_task ? [{ tool: 'neurouter_report', args: { kind: 'blocked', text: `needs approval for a script with ${planned.length} change(s) in ${where}` } }] : [];
              const draft = errorDraft({ code: 'confirmation_unsupported', message: '', text: `The script makes ${planned.length} change(s) that need your user's approval in ${where}, and this client cannot ask; nothing changed. Show data.plan to the user.`, name: callAs.name, args: callAs.args, next: report }, { write: true, data: { plan: this.planOf(ctx, dry.planned) } });
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

  /**
   * Contract 2, outside prod (D5): when the principal can call destructive tools, an `execute` run is dry-run first;
   * if the plan has destructive calls, the run needs `confirm` = a token bound to the code, inputs and that plan
   * (5 min, single use). Without one (or with a stale one) the answer is `confirmation_required` with `data.plan`
   * and the run_script call carrying a fresh token; with it, the script runs with exactly those destructive calls
   * approved (any other destructive call inside raises `confirmation_required`). Null: no gate applies.
   */
  private async tokenGate(executor: Executor, ctx: RunContext, code: string, mode: 'dry_run' | 'execute', inputs: Record<string, unknown>, args: Record<string, unknown>, callAs: ScriptCallAs, signal: AbortSignal | undefined): Promise<ScriptReply | null> {
    const env = ctx.bundle.environment;
    if (ctx.contract !== 2 || !this.d.confirms || mode !== 'execute' || !env.writes.enabled || env.writes.confirm !== 'none') return null;
    const destructiveTools = new Set(allowedTools(ctx).filter((t) => t.risk.write && t.risk.destructive).map((t) => t.name));
    if (!destructiveTools.size) return null;
    const dry = await this.runOnce(executor, ctx, code, 'dry_run', inputs, callAs, signal, true);
    if (dry.status !== 'ok') return { result: dry.result, draft: dry.draft };
    const destructive = dry.planned.filter((p) => destructiveTools.has(p.tool));
    if (!destructive.length) return null;
    const binding = this.scriptBinding(ctx, code, inputs, callAs, destructive);
    const token = typeof args.confirm === 'string' ? args.confirm : undefined;
    const problem = token ? await this.d.confirms.spend(token, binding) : 'missing';
    if (!problem) {
      const plan = new Set(destructive.map((p) => `${p.tool}|${p.argsHash}`));
      const run = await this.runOnce(executor, { ...ctx, approvedPlan: plan }, code, 'execute', inputs, callAs, signal);
      return { result: run.result, draft: run.draft };
    }
    const why = problem === 'expired' ? 'The confirm token expired (5 minutes). ' : problem === 'used' ? 'The confirm token was already used. ' : problem === 'missing' ? '' : 'The confirm token is for another script or plan. ';
    const text = `${why}The script makes ${destructive.length} destructive change(s); nothing changed yet. Repeat with the confirm token to run it.`;
    const next = { tool: callAs.name, args: { ...withoutConfirm(callAs.args), confirm: this.d.confirms.mint(binding) } };
    return { result: dry.result, draft: errorDraft({ code: 'confirmation_required', message: text, text, name: callAs.name, args: callAs.args, next: [next] }, { data: { plan: this.planOf(ctx, dry.planned) }, flags: ['dry_run'], write: true, ...(dry.draft.meta ? { meta: dry.draft.meta } : {}) }) };
  }

  /** What a script confirm token binds: the code, the inputs and the destructive calls of its plan. */
  private scriptBinding(ctx: RunContext, code: string, inputs: Record<string, unknown>, callAs: ScriptCallAs, destructive: PlannedChange[]) {
    const plan = sha256Hex(JSON.stringify(destructive.map((p) => `${p.tool}|${p.argsHash}`)));
    return { tenantId: ctx.tenantId, environmentId: ctx.environment.id, credentialKey: ctx.credentialKey, tool: callAs.name, args: { code: sha256Hex(code), inputs, plan } };
  }

  /** Contract-2 plan entries (target, effect, reversible); contract 1 keeps `{tool, method, path, args}`. */
  private planOf(ctx: RunContext, planned: PlannedChange[]): unknown[] {
    return planned.map((p) => {
      const t = ctx.contract === 2 ? ctx.bundle.build.tools.find((x) => x.name === p.tool) : undefined;
      return t ? writePlan(t, p.arguments) : { tool: p.tool, method: p.method, path: p.path, args: p.arguments };
    });
  }

  private async finishRejected(ctx: RunContext, code: string, mode: 'dry_run' | 'execute', status: ScriptStatus, message: string, errorCode?: ErrorCode): Promise<McpToolResult> {
    const id = newId();
    const now = this.d.now();
    await this.d.db.insertInto('script_runs').values({ id, tenant_id: ctx.tenantId, task_id: ctx.taskId, server_id: ctx.server.id, environment_id: ctx.environment.id, user_id: null, credential_key: ctx.credentialKey, code: code.slice(0, 16384), code_hash: sha256Hex(code), mode, status, error: toJsonColumn({ type: status, message }), started_at: now, ended_at: now }).execute();
    this.d.audit.record({ ...this.d.pipeline.auditBase(ctx), kind: 'script_run', toolName: 'run_script', scriptRunId: id, decision: 'denied_confirmation', status: 'blocked', params: { code_hash: sha256Hex(code), mode }, errorMessage: message });
    return errorResult(message, null, errorCode ?? (status === 'confirm_declined' ? 'confirmation_declined' : 'script_rejected'));
  }

  /**
   * Contract 2 (B3): a return value over the agent budget (`limits.code.resultChars`, default 8,192 characters, the
   * contract-1 cut) is cut like a tool result (a prefix of the list, or clipped fields), the whole value is stored for
   * `neurouter_read_result` (1 h), and the hint says how to need less. Null when it fits.
   */
  private async agentCut(ctx: RunContext, value: unknown, chars: number): Promise<AgentCut | null> {
    const json = JSON.stringify(value) ?? 'null';
    if (json.length <= chars) return null;
    const shaped = shapeResponse(value, {}, { maxBytes: chars });
    const t = shaped.truncated;
    if (!t) return null;
    const handle = await this.d.pages.store(ctx.tenantId, ctx.credentialKey, value);
    const truncated: Truncated = {
      ...(t.totalItems !== undefined && t.returnedItems !== undefined ? { items_omitted: t.totalItems - t.returnedItems } : {}),
      ...(t.fields?.length ? { fields: t.fields.slice(0, 20) } : {}),
      omitted_bytes: Math.max(0, t.totalBytes - t.returnedBytes),
      next: { tool: opsMcpName(READ_RESULT), args: { handle } },
    };
    const shown = t.totalItems !== undefined ? `${t.returnedItems} of ${t.totalItems} items` : `${t.returnedBytes} of ${t.totalBytes} bytes`;
    return { value: shaped.value, truncated, hint: `Result cut to ${chars} chars (${shown}). Return less: filter or count in the script, pass fields=[…] to the calls, or page with fn.page(); truncated.next has the rest.` };
  }

  /**
   * Contract-2 form of a run: `data` = the script's return value (dry run: `{result, plan}`), `truncated` when
   * the value is over the result limit, `state.left` / `script_calls`, and errors without tracebacks (a tool
   * error the script did not catch keeps its code and next calls).
   */
  private scriptDraft(
    ctx: RunContext,
    status: ScriptStatus,
    body: { error?: Record<string, unknown>; truncated?: boolean; preview?: unknown; valueBytes?: number; stdout?: string; agentCut?: AgentCut | null },
    value: unknown,
    mode: 'dry_run' | 'execute',
    planned: PlannedChange[],
    callAs: ScriptCallAs,
    budget: { calls: number; left: { calls: number; seconds: number } },
    innerErrors: Map<string, InnerError>,
    meta: Record<string, unknown>,
    src: { code: string; inputs: Record<string, unknown> },
  ): Draft {
    const scriptCode = src.code;
    const scriptInputs = src.inputs;
    // print() output comes back as `logs` (B6; the renderer bounds it)
    const extra = { left: budget.left, scriptCalls: budget.calls, meta, ...(mode === 'dry_run' ? { flags: ['dry_run' as const] } : {}), ...(planned.length ? { write: true } : {}), ...(body.stdout ? { logs: body.stdout } : {}) };
    if (status === 'ok') {
      const plan = this.planOf(ctx, planned);
      // contract 2 outside prod: a dry run that plans destructive calls also hands back the confirmed run (D5)
      const destructive = ctx.contract === 2 && this.d.confirms && ctx.bundle.environment.writes.confirm === 'none' ? planned.filter((p) => ctx.bundle.build.tools.find((t) => t.name === p.tool)?.risk.destructive) : [];
      const next = mode === 'dry_run' && destructive.length ? { tool: callAs.name, args: { ...withoutConfirm(callAs.args), mode: 'execute', confirm: this.d.confirms!.mint(this.scriptBinding(ctx, scriptCode, scriptInputs, callAs, destructive)) } } : null;
      const cut = body.agentCut ?? null;
      const shownValue = cut ? cut.value : value;
      const data = mode === 'dry_run' ? { result: shownValue, plan, ...(next ? { next } : {}) } : shownValue;
      // over the agent budget (B3): the first part, `truncated` with the stored whole value, and how to need less
      if (cut) return okDraft(data, { ...extra, truncated: cut.truncated, hint: cut.hint });
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
    const hit = [...innerErrors.entries()].find(([text]) => raw.includes(text))?.[1];
    if (hit) {
      const inner = hit.info;
      return errorDraft({ code: inner.code, message: inner.message, info: inner, ...base }, { ...extra, ...(hit.plan !== undefined ? { data: { plan: [hit.plan] } } : {}) });
    }
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

  /**
   * Contract 2: `_nr.call(fn, args, page?)`, the host side of every tool function in the prelude. Python keyword
   * names are mapped back (D8), a `c_` cursor (from `Result.page.next_cursor`) is checked with the P2 codec against
   * this call's other arguments, and the call runs through the pipeline. Tool errors come back as values
   * (`{ok: false, py, text, error}`) for the prelude to raise; `page: true` adds `items` and `page`.
   */
  private async nrCall(
    ctx: RunContext,
    kwargs: Record<string, unknown>,
    byFn: Map<string, ToolDef>,
    refuse: (info: ErrorInfo, plan?: unknown) => HostCallResult,
    unknownFn: (name: string) => Promise<ErrorInfo>,
    planned: PlannedChange[],
    signal: AbortSignal | undefined,
    onBlocked: () => void,
  ): Promise<HostCallResult> {
    const name = typeof kwargs.fn === 'string' ? kwargs.fn : '';
    const t = byFn.get(name);
    if (!t) {
      onBlocked();
      return refuse(await unknownFn(name || '(no function)'));
    }
    const raw = kwargs.args && typeof kwargs.args === 'object' && !Array.isArray(kwargs.args) ? (kwargs.args as Record<string, unknown>) : {};
    const map = pyArgMap(t, { snake: true });
    const plan = pagingPlan(t);
    const args: Record<string, unknown> = {};
    let cursor: string | undefined;
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'cursor' && typeof v === 'string' && isNeurouterCursor(v)) cursor = v;
      else args[map[k] ?? k] = v;
    }
    // a raw upstream cursor value passed as `cursor` goes to the upstream cursor parameter (as in tool mode)
    if (args.cursor !== undefined && !('cursor' in propsOf(t)) && plan.cursor) {
      args[plan.cursor.arg] = args.cursor;
      delete args.cursor;
    }
    let position: CursorPayload | undefined;
    if (cursor) {
      const problem = (() => {
        if (!this.d.cursors) return 'is not available here';
        try {
          position = this.d.cursors.decode(cursor, { tenantId: ctx.tenantId, credentialKey: ctx.credentialKey, tool: t.name, args: boundArgs(t, plan, args), contract: 2 });
          return null;
        } catch (err) {
          const p = err instanceof CursorError ? err.problem : 'malformed';
          return p === 'expired' ? 'expired (cursors last 1 hour)' : p === 'mismatch' ? 'belongs to another function or other arguments' : 'is not a page.next_cursor';
        }
      })();
      if (problem) {
        onBlocked();
        // other query arguments than the cursor's (B5): the first next call continues the cursor with its own arguments
        const binding = { tenantId: ctx.tenantId, credentialKey: ctx.credentialKey, tool: t.name, contract: 2 };
        const bound = this.d.cursors && problem.startsWith('belongs') ? this.d.cursors.boundArgs(cursor, binding) : null;
        const keep = bound ? [{ tool: t.name, args: { ...bound, ...(args.fields !== undefined ? { fields: args.fields } : {}), cursor } }] : [];
        const text = bound ? `The cursor belongs to other arguments; nothing was called. Continue it with its own arguments (next[0]), or call again without it.` : `The cursor ${problem}; nothing was called. Call again without it, with the same other arguments.`;
        return refuse(await errorInfoFor(ctx, { code: 'invalid_args', message: '', text, name: t.name, tool: t, args, issues: [{ path: '/cursor', keyword: 'cursor', params: {}, message: problem }], next: [...keep, { tool: t.name, args }] }));
      }
    }
    const out = await this.d.pipeline.invoke(ctx, t.name, args, { planned, ...(position ? { position } : {}), ...(signal ? { signal } : {}) });
    if (!out.ok) {
      if (out.decision.startsWith('denied_')) onBlocked();
      if (out.draft.error) return refuse(await errorInfoFor(ctx, out.draft.error), planOf(out.draft.data));
      return refuse({ code: 'upstream_error', message: out.error?.message ?? 'The call failed.', retry: 'no', next: [] });
    }
    const data = innerValue(ctx, out, args);
    if (kwargs.page !== true) return { ok: true, value: { ok: true, data } };
    return { ok: true, value: { ok: true, data, items: itemsOf(data), page: out.draft.page ?? null } };
  }

  /** Stubs regenerated from the filtered tool list, cached by (build, allowedSetHash, contract). */
  private surfaceFor(ctx: RunContext, tools: ToolDef[], ns: string): ScriptSurface {
    const ops = SCRIPT_OPS.filter((o) => ctx.bundle.server.opsTools[o]);
    const v2 = ctx.contract === 2;
    const report = v2 && reportEnabled(ctx);
    const confirmTokens = v2 && ctx.bundle.environment.writes.confirm === 'none';
    const k = `${ctx.bundle.build.id}|${sha256Hex(tools.map((t) => t.name).join(','))}|${ops.join(',')}|${v2 ? `2${report ? 'r' : ''}${confirmTokens ? 'c' : ''}` : 1}`;
    const hit = this.stubCache.get(k);
    if (hit) return hit;
    let out: ScriptSurface;
    if (!v2) out = { stubs: { [ns]: generateStubs(tools, ns, { buildHash: ctx.bundle.build.hash }), ops: generateOpsStub(ops) }, opsFunctions: [...ops] };
    else {
      const api = scriptApiFor(tools, ns, ctx.bundle.build.hash, confirmTokens);
      out = {
        stubs: { [ns]: api.stubs, ops: generateOpsStubV2(ops, report), _nr: NR_HOST_STUBS },
        prelude: scriptPrelude([{ ns, functions: tools.map((t) => t.pyName.split('.').slice(1).join('.')) }], ops, report),
        typeStubs: `${scriptCommonTypeStubs(ops, report)}${api.typeStubs}`,
        opsFunctions: [...ops, ...(report ? ['report'] : [])],
      };
    }
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
      const resultChars = lim.resultChars ?? SCRIPT_RESULT_CHARS;
      const agentCut = ctx.contract === 2 && status === 'ok' && !body.truncated ? await this.agentCut(ctx, value ?? null, resultChars) : null;
      const draft = this.scriptDraft(ctx, status, { ...body, agentCut }, value ?? null, mode, planned, callAs, { calls, left: { calls: Math.max(0, lim.maxToolCalls - calls), seconds: Math.max(0, Math.floor((lim.wallTimeSec * 1000 - (ended - started)) / 1000)) } }, innerErrors, { [META_CALL_ID]: auditId, [META_TASK_ID]: taskId, 'dev.neurouter/script-run-id': runId }, { code, inputs });
      return { status, planned, result: v1Result(text.length > resultChars ? `${text.slice(0, resultChars - 42)}… (truncated preview)` : text, structured, meta, isError), draft };
    };
    /** contract 2: the error objects raised into the script (by JSON message), so an uncaught one becomes the run's error */
    const innerErrors = new Map<string, InnerError>();
    let calls = 0;
    let blocked = 0;

    // validate (cached by code hash)
    const t0 = this.d.now();
    let v = this.validated.get(`${ctx0.contract}|${codeHash}`);
    if (!v) {
      v = validateScript(code, { namespaces: [ns, 'ops'], ...(ctx0.contract === 2 ? { allow: ['getattr', 'hasattr'] } : {}) });
      if (this.validated.size > 1000) this.validated.delete(this.validated.keys().next().value!);
      this.validated.set(`${ctx0.contract}|${codeHash}`, v);
    }
    phases.push({ name: 'validate', status: v.ok ? 'ok' : 'failed', durationMs: this.d.now() - t0 });
    if (!v.ok) {
      phases.push({ name: 'type_check', status: 'skipped', durationMs: 0 }, { name: 'execute', status: 'skipped', durationMs: 0 });
      const e = v.errors[0]!;
      return finish('rejected', { error: { type: 'rejected', message: e.message, line: e.line, col: e.col, hint: e.hint, errors: v.errors } });
    }

    const tools = allowedTools(ctx);
    const byFn = new Map(tools.map((t) => [t.pyName, t]));
    const surface = this.surfaceFor(ctx, tools, ns);
    const stubs = surface.stubs;
    const capability = `rc_${randomBytes(32).toString('base64url')}`;
    const wrapped = wrapScript(code);
    const v2 = ctx.contract === 2;
    const sem = new Semaphore(lim.maxConcurrentCalls);

    const host = {
      call: async (fn: string, kwargs: Record<string, unknown>): Promise<HostCallResult> => {
        if (calls >= lim.maxToolCalls) return { ok: false, error: { code: 'limit_exceeded', message: `${lim.maxToolCalls} tool calls` } };
        calls++;
        return sem.run(async () => {
          // contract 2: a tool error raised into the script: concise `str(e)` (`<code>: <message> Next: <call>`), the
          // structured error behind `ops.error(e)`, and the run's envelope error when the script does not catch it
          const scriptError = (info0: ErrorInfo, plan?: unknown): { error: ScriptErrorObject; text: string } => {
            // a destructive call outside the confirmed plan: the way on is to re-plan the script (its dry run gives a token)
            const info = info0.code === 'confirmation_required' ? { ...info0, next: [{ tool: callAs.name, args: withoutConfirm(callAs.args) }] } : info0;
            const runInfo = { ...info, next: info.code === 'confirmation_required' ? info.next : info.next.map((c) => asScriptCall(c, tools, true)) };
            const out = scriptErrorObject(info, tools, plan);
            innerErrors.set(out.text, { info: runInfo, plan });
            return out;
          };
          const raise = (info: ErrorInfo, plan?: unknown): HostCallResult => {
            const { text } = scriptError(info, plan);
            return { ok: false, error: { code: info.code, message: text, pyType: scriptErrorType(info.code) } } as HostCallResult;
          };
          /** `_nr.call` answers tool errors as values; the prelude raises them (no host-side exception). */
          const refuse = (info: ErrorInfo, plan?: unknown): HostCallResult => {
            const { error, text } = scriptError(info, plan);
            return { ok: true, value: { ok: false, py: scriptErrorType(info.code), text, error } };
          };
          const unknownFn = async (name: string): Promise<ErrorInfo> => errorInfoFor(ctx, { code: 'unknown_tool', message: '', text: `No function ${name} in this script's namespaces; nothing was called.`, name, closest: closestNames(name, [...byFn.keys()]), next: [{ tool: 'search_tools', args: { query: name.split('.').pop() ?? name } }] });
          if (fn === '_nr.call' && v2) return this.nrCall(ctx, kwargs, byFn, refuse, unknownFn, planned, signal, () => blocked++);
          if (fn.startsWith('ops.')) {
            const op = opFor(ctx, fn);
            if (!op || !(surface.opsFunctions as readonly string[]).includes(op)) return v2 ? raise(await unknownFn(fn)) : { ok: false, error: { code: 'unknown_tool', message: `Tool not found or not permitted: ${fn}` } };
            const r = await this.d.ops.call(ctx, op, kwargs);
            return { ok: true, value: r.value };
          }
          const t = byFn.get(fn);
          if (!t) {
            blocked++;
            return v2 ? raise(await unknownFn(fn)) : { ok: false, error: { code: 'unknown_tool', message: `Tool not found or not permitted: ${fn}` } };
          }
          const map = pyArgMap(t, { snake: v2 });
          const argsIn: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(kwargs)) argsIn[map[k] ?? k] = val;
          const out = await this.d.pipeline.invoke(ctx, t.name, argsIn, { planned, ...(signal ? { signal } : {}) });
          if (!out.ok) {
            blocked += out.decision.startsWith('denied_') ? 1 : 0;
            if (v2 && out.draft.error) return raise(await errorInfoFor(ctx, out.draft.error), planOf(out.draft.data));
            return { ok: false, error: { code: out.error?.code ?? 'tool_error', message: out.error?.message ?? 'tool call failed', ...(out.error?.errorId ? { errorId: out.error.errorId } : {}) } };
          }
          return { ok: true, value: v2 ? innerValue(ctx, out, argsIn) : (out.value ?? null) };
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
          modules: { [ns]: { functions: tools.map((t) => t.pyName.split('.').slice(1).join('.')), stubs: stubs[ns]! }, ops: { functions: surface.opsFunctions, stubs: stubs.ops! }, ...(v2 ? { _nr: { functions: ['call'], stubs: stubs._nr! } } : {}) },
          ...(surface.prelude ? { prelude: surface.prelude } : {}),
          ...(surface.typeStubs ? { typeStubs: surface.typeStubs } : {}),
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
    return finish(res.status as ScriptStatus, { value: res.value, ...(res.error ? { error: v2 ? scriptHintV2(withBuiltinHint({ ...res.error }, 2), ns, [...byFn.keys()]) : withBuiltinHint({ ...res.error }) } : {}), stats: { wallMs: res.stats.wallMs, suspensions: res.stats.suspensions, toolCalls: calls }, stdout: res.stdout, truncated: res.truncated === true, preview: res.preview, valueBytes: res.valueBytes });
  }
}

/** Call arguments without a confirm token (single use; next calls carry a fresh one). */
function withoutConfirm(args: Record<string, unknown>): Record<string, unknown> {
  const { confirm: _c, ...rest } = args;
  return rest;
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
export function withBuiltinHint(error: Record<string, unknown>, contract: 1 | 2 = 1): Record<string, unknown> {
  const m = /Name `([A-Za-z_][A-Za-z0-9_]*)` used when not defined/.exec(String(error.message ?? ''));
  if (!m || error.hint) return error;
  const alt = SCRIPT_BUILTIN_ALTERNATIVES[m[1]!];
  return { ...error, hint: `${alt ? `${m[1]} is not available in scripts: ${alt}. ` : ''}${scriptBuiltinsLine(contract)}` };
}

/** Attributes agents try on a caught tool error (the sandbox's exceptions carry none). */
const ERROR_ATTRS = new Set(['code', 'next', 'fields', 'retry', 'retry_after_ms', 'plan', 'message', 'closest', 'error_id', 'upstream']);

/**
 * Contract 2: type-check messages in the agent's terms. The prelude's private type names become the namespace
 * (`Object of type \`_nr_ns_acme\` has no attribute \`get_ordr\`` → `acme has no function get_ordr`, with the closest
 * names); attribute access on a caught error points at `ops.error(e)`.
 */
export function scriptHintV2(error: Record<string, unknown>, ns: string, fns: string[]): Record<string, unknown> {
  let message = String(error.message ?? '');
  const out: Record<string, unknown> = { ...error };
  const missing = /Object of type `_nr_ns_([A-Za-z0-9_]+)` has no attribute `([A-Za-z_][A-Za-z0-9_]*)`/.exec(message);
  if (missing) {
    const fn = `${missing[1]}.${missing[2]}`;
    message = `${missing[1]} has no function ${missing[2]}.`;
    const near = closestNames(fn, fns, 3);
    out.hint = `${near.length ? `Closest: ${near.join(', ')}. ` : ''}Find functions with search_tools.`;
  }
  const attr = /`(LookupError|ValueError|PermissionError|TimeoutError|RuntimeError|AttributeError)[^`]*` has no attribute `([a-z_]+)`|'(LookupError|ValueError|PermissionError|TimeoutError|RuntimeError|AttributeError)' object has no attribute '([a-z_]+)'/.exec(message);
  if (attr && ERROR_ATTRS.has(attr[2] ?? attr[4] ?? '')) out.hint = `Tool errors carry no attributes in scripts: use ops.error(e)["${attr[2] ?? attr[4]}"] (or str(e)).`;
  out.message = message.replace(/_nr_f_[A-Za-z0-9]+_([A-Za-z0-9_]+)\.__call__/g, `${ns}.$1`).replace(/_nr_ns_([A-Za-z0-9_]+)/g, '$1').replace(/_nr_t_[A-Za-z0-9_]+\./g, '');
  return out;
}

/** The `plan` of a refused write (confirmation_required / prod refusal), if any. */
function planOf(data: unknown): unknown {
  return data && typeof data === 'object' && !Array.isArray(data) && 'plan' in data ? (data as { plan: unknown }).plan : undefined;
}

/** Contract 2: what a tool function returns in a script; inner dry-run writes return `{plan}` (as `dry_run: true` does in tool mode). */
function innerValue(ctx: RunContext, out: { value?: unknown; decision: string; tool?: ToolDef }, args: Record<string, unknown>): unknown {
  if (ctx.dryRun && out.decision === 'dry_run' && out.tool?.risk.write) return { plan: writePlan(out.tool, args) };
  return out.value ?? null;
}

const apiCache = new Map<string, ReturnType<typeof scriptApi>>();

/** The contract-2 script API of a set of tools (stubs with docstrings, signatures, type-check declarations), cached. */
export function scriptApiFor(tools: ToolDef[], ns: string, buildHash: string, confirmTokens: boolean): ReturnType<typeof scriptApi> {
  const key = `${buildHash}|${ns}|${confirmTokens ? 1 : 0}|${sha256Hex(tools.map((t) => `${t.name}:${t.defHash}`).join(','))}`;
  const hit = apiCache.get(key);
  if (hit) return hit;
  const api = scriptApi(tools, ns, { buildHash, isList: (t) => pagingPlan(t).list, example: (t) => toolExample(t), confirmTokens });
  if (apiCache.size > 100) apiCache.clear();
  apiCache.set(key, api);
  return api;
}

/** The copy-ready example of a tool (schema argument names): the compiler's checked example, else overlay/spec/defaults. */
export function toolExample(t: ToolDef): Record<string, unknown> | null {
  const c = t.checkedExample;
  if (c && c.runs !== false) return c.arguments;
  return exampleArgs(t);
}

/**
 * Contract-2 `run_script` description (contract-v2 §5), per server: what the functions return, the paging and error
 * idioms, writes, the helpers and built-ins, and an example built from this server's own functions (a lookup by id
 * with its NotFound handling, and a list walked with `.pages()`). The example is executed in the tests.
 */
export function runScriptDescriptionV2(ctx: RunContext, tools: ToolDef[]): string {
  const ns = ctx.server.slug.replace(/-/g, '_');
  const reads = tools.filter((t) => !t.risk.write && t.kind !== 'composite');
  const withEx = (t: ToolDef) => toolExample(t) !== null;
  const lookup = reads.find((t) => withEx(t) && t.binding.type === 'http' && /\{[^}]+\}$/.test(t.binding.pathTemplate) && !pagingPlan(t).list);
  const list = reads.find((t) => withEx(t) && pagingPlan(t).list);
  const lines = [
    `Run a short Python script against the ${ctx.bundle.server.name} API and return a JSON value with \`return\`. Functions are ${ns}.<fn>(name=value, ...) (keyword arguments; find them with search_tools) and return plain data (dicts/lists).`,
    `Lists: ${ns}.<fn>.pages(..., max_items=500) returns the items of every page; ${ns}.<fn>.page(...) returns a Result (.data, .items, .page.next_cursor, .next()).`,
    'Errors raise NotFound, InvalidArgs, Forbidden, WritesDisabled, ConfirmationRequired, RateLimited, Timeout or UpstreamError (ToolError catches all): str(e) says what failed and the next call; ops.error(e) gives {code, next, fields, retry, plan}.',
    'Writes: mode="dry_run" returns the plan without changing anything; destructive changes then need the confirm token from error.next.',
    'ops: parallel, now, days_since, report(kind, text). No imports, files or network. ' + scriptBuiltinsLine(2),
  ];
  const ex: string[] = [];
  if (lookup) {
    const call = pyCallText(lookup, toolExample(lookup)!, ns);
    ex.push('try:', `    one = ${call}`, 'except NotFound as e:', '    return ops.error(e)["next"]');
  }
  if (list) {
    const args = toolExample(list)!;
    const call = pyCallText(list, args, ns).replace(/\)$/, `${Object.keys(args).length ? ', ' : ''}max_items=50)`).replace(`${ns}.${list.pyName.split('.').pop()}(`, `${ns}.${list.pyName.split('.').pop()}.pages(`);
    ex.push(`rows = ${call}`);
  }
  if (ex.length) {
    ex.push(`return {${[lookup ? '"one": one' : '', list ? '"count": len(rows)' : ''].filter(Boolean).join(', ')}}`);
    lines.push('', 'Example:', ...ex.map((l) => `  ${l}`), '');
  }
  return lines.join('\n');
}
