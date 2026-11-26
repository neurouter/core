import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { generateOpsStub, generateStubs, pyArgMap } from '@neurouter/compiler';
import type { Executor, HostCallResult, RunResult } from '@neurouter/executor';
import { META_CALL_ID, META_PLANNED_CHANGES, META_RESULT_HANDLE, META_TASK_ID, META_TRUNCATED, type ErrorCode, type ScriptStatus, type ToolDef } from '@neurouter/shared';
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
    'Run a short Python script that calls API tools as functions (e.g. github.list_issues(owner=..., repo=...)) and returns a JSON-serializable value with `return`. No imports, no files, no network: only the tool functions, built-ins and ops.* helpers. Tool results are dicts/lists. Use mode="dry_run" to see planned writes without executing them. Get function signatures from search_tools.',
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
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
} as const;

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

  async run(ctx: RunContext, args: Record<string, unknown>, confirmer: Confirmer | null, signal?: AbortSignal, opts: { allowWithoutScope?: boolean } = {}): Promise<{ result: McpToolResult; inputRequired?: unknown }> {
    const code = typeof args.code === 'string' ? args.code : '';
    const mode = args.mode === 'dry_run' ? 'dry_run' : 'execute';
    const inputs = args.inputs && typeof args.inputs === 'object' && !Array.isArray(args.inputs) ? (args.inputs as Record<string, unknown>) : {};
    if (!code) return { result: errorResult('run_script needs `code`', null, 'script_rejected') };
    if (Buffer.byteLength(code, 'utf8') > 16 * 1024) return { result: errorResult('Script larger than 16 KiB', null, 'script_rejected') };
    const executor = this.d.executor();
    if (!executor || !(opts.allowWithoutScope ? this.d.healthy() && ctx.bundle.codeModeEnabled && !killSwitchFor(ctx, null, ['code_mode', 'all']) : codeModeAvailable(ctx, this.d.healthy()))) return { result: errorResult('Code mode is not available in this environment.', null, 'executor_unavailable') };

    // per-principal concurrency (≤ 2), wait ≤ 5 s
    const key = ctx.credentialKey;
    const deadline = this.d.now() + QUEUE_WAIT_MS;
    while ((this.running.get(key) ?? 0) >= MAX_CONCURRENT_PER_PRINCIPAL) {
      if (this.d.now() > deadline) return { result: errorResult('Too many scripts running for this credential; retry shortly.', null, 'executor_busy', { retryAfterMs: 2000 }) };
      await new Promise((r) => setTimeout(r, 50));
    }
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
    try {
      // writes that need confirmation (prod, or confirm set elsewhere): dry run first, then elicit once with the plan (§9.7)
      const confirmMode = ctx.bundle.environment.writes.confirm;
      const confirmWrites = ctx.bundle.environment.writes.enabled && confirmMode !== 'none';
      if (mode === 'execute' && confirmWrites) {
        const dry = await this.runOnce(executor, ctx, code, 'dry_run', inputs, null, signal, true);
        if (dry.status !== 'ok') return { result: dry.result };
        if (dry.planned.length) {
          const listed = dry.planned.slice(0, 20).map((p) => `- ${p.method} ${p.path} (${p.tool})`).join('\n');
          const synthetic: ToolDef = { ...ctx.bundle.build.tools.find((t) => t.name === dry.planned[0]!.tool)!, name: 'run_script', title: `run a script with ${dry.planned.length} write(s)` };
          const planHash = sha256Hex(JSON.stringify(dry.planned.map((p) => `${p.tool}|${p.argsHash}`)));
          const out = confirmer ? await confirmer.confirm({ tool: synthetic, args: { code_hash: sha256Hex(code), plan: planHash }, argsHash: planHash, message: `Allow ${ctx.client.name ?? 'this agent'} to run a script that makes ${dry.planned.length} change(s) in ${envLabel(ctx)}?\n${listed}` }) : ({ status: 'unsupported' } as const);
          if (out.status === 'pending') return { result: { content: [] }, inputRequired: out.result };
          if (out.status !== 'approved') {
            const where = envLabel(ctx);
            if (out.status === 'unsupported' && confirmMode === 'elicit') {
              // elicit: the dry run already ran; return its plan (nothing was executed) for the user to review
              const planned = dry.planned.map((p) => ({ tool: p.tool, method: p.method, path: p.path, arguments: p.arguments }));
              const r = await this.finishRejected(ctx, code, 'execute', 'confirm_declined', `Not executed: this client cannot ask the user to confirm writes in ${where}. The dry run planned ${planned.length} change(s), none made:\n${listed}\nShow them to the user; they can approve the script from a client with MCP elicitation support.`, 'confirmation_unsupported');
              return { result: { ...r, _meta: { ...(r._meta ?? {}), [META_PLANNED_CHANGES]: planned } } };
            }
            const r = await this.finishRejected(ctx, code, 'execute', 'confirm_declined', out.status === 'unsupported' ? `This client cannot ask the user to confirm writes in ${where}; the script was not run.` : 'The user declined the planned changes.', out.status === 'unsupported' ? 'confirmation_unsupported' : 'confirmation_declined');
            return { result: r };
          }
          const plan = new Set(dry.planned.map((p) => `${p.tool}|${p.argsHash}`));
          return { result: (await this.runOnce(executor, { ...ctx, approvedPlan: plan }, code, 'execute', inputs, null, signal)).result };
        }
      }
      return { result: (await this.runOnce(executor, ctx, code, mode, inputs, null, signal)).result };
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

  private async runOnce(executor: Executor, ctx0: RunContext, code: string, mode: 'dry_run' | 'execute', inputs: Record<string, unknown>, _x: null, signal: AbortSignal | undefined, planOnly = false): Promise<{ status: ScriptStatus; result: McpToolResult; planned: PlannedChange[] }> {
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
    const finish = async (status: ScriptStatus, body: { value?: unknown; error?: Record<string, unknown>; stats?: Record<string, unknown>; stdout?: string; truncated?: boolean; preview?: unknown; valueBytes?: number }): Promise<{ status: ScriptStatus; result: McpToolResult; planned: PlannedChange[] }> => {
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
        .updateTable('script_runs')
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
      return { status, planned, result: { content: [{ type: 'text', text: text.length > 8192 ? `${text.slice(0, 8150)}… (truncated preview)` : text }], structuredContent: structured, ...(isError ? { isError: true } : {}), _meta: meta } };
    };
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
    const sem = new Semaphore(lim.maxConcurrentCalls);

    const host = {
      call: async (fn: string, kwargs: Record<string, unknown>): Promise<HostCallResult> => {
        if (calls >= lim.maxToolCalls) return { ok: false, error: { code: 'limit_exceeded', message: `${lim.maxToolCalls} tool calls` } };
        calls++;
        return sem.run(async () => {
          if (fn.startsWith('ops.')) {
            const op = opFor(ctx, fn);
            if (!op || !(SCRIPT_OPS as readonly string[]).includes(op)) return { ok: false, error: { code: 'unknown_tool', message: `Tool not found or not permitted: ${fn}` } };
            const r = await this.d.ops.call(ctx, op, kwargs);
            return { ok: true, value: r.value };
          }
          const t = byFn.get(fn);
          if (!t) {
            blocked++;
            return { ok: false, error: { code: 'unknown_tool', message: `Tool not found or not permitted: ${fn}` } };
          }
          const map = pyArgMap(t);
          const argsIn: Record<string, unknown> = {};
          for (const [k, val] of Object.entries(kwargs)) argsIn[map[k] ?? k] = val;
          const out = await this.d.pipeline.invoke(ctx, t.name, argsIn, { planned, ...(signal ? { signal } : {}) });
          if (!out.ok) {
            blocked += out.decision.startsWith('denied_') ? 1 : 0;
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
    return finish(res.status as ScriptStatus, { value: res.value, ...(res.error ? { error: { ...res.error } } : {}), stats: { wallMs: res.stats.wallMs, suspensions: res.stats.suspensions, toolCalls: calls }, stdout: res.stdout, truncated: res.truncated === true, preview: res.preview, valueBytes: res.valueBytes });
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
