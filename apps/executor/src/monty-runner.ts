import type * as MontyModule from '@pydantic/monty';
import type { ExternalModule, Monty, MontySession, Snapshot } from '@pydantic/monty';
import { jsonBytes, toJson, truncateUtf8 } from './convert.js';
import { montyVersion, resolveMontyBinary, verifyMontyBinary } from './monty-info.js';
import {
  DEFAULT_LIMITS,
  HOST_ERROR_TYPES,
  MAX_STDOUT_BYTES,
  PREVIEW_BYTES,
  type ExecLogger,
  type ExecutorHealth,
  type HostBridge,
  type HostCallResult,
  type RunError,
  type RunRequest,
  type RunResult,
  type RunStatus,
  type ToolCallError,
} from './types.js';

/**
 * `@pydantic/monty` (its native addon and the OpenTelemetry API it imports) is loaded by
 * `MontyRunner.create`, not when this package is imported: the server process imports
 * `@neurouter/executor` for the socket client and the spawner, but only the executor runs Monty.
 */
let montyModule: typeof MontyModule | undefined;
const loadMonty = async (): Promise<typeof MontyModule> => (montyModule ??= await import('@pydantic/monty'));
const M = (): typeof MontyModule => {
  if (!montyModule) throw new Error('@pydantic/monty is not loaded (MontyRunner.create loads it)');
  return montyModule;
};

export interface MontyRunnerOptions {
  /** Explicit worker binary (default: `MONTY_BINARY_PATH`, then the platform package). */
  binaryPath?: string;
  /** Expected sha256 of the binary; checked at create. */
  binarySha256?: string;
  /** Max concurrent scripts (Monty `maxProcesses`). */
  poolMax: number;
  /** Monty `preWarm`. */
  prewarm: number;
  /** Seconds to wait for a free worker (default 5). */
  checkoutTimeoutSec?: number;
  /** Default: `cpu` on Linux, `wall` elsewhere (Monty's CPU clock is Linux-only). */
  executionClock?: 'wall' | 'cpu';
  /** Per-turn wall backstop (Monty `requestTimeout`, default 35 s). */
  requestTimeoutSec?: number;
  logger?: ExecLogger;
}

/** Helpers implemented inside the executor (no host round trip). */
const BUILTIN_OPS_STUBS = `from typing import Any
def parallel(calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:
    """Run several tool calls concurrently; returns [{"ok": True, "value": ...} | {"ok": False, "error": {...}}] in input order."""
    ...
def days_since(iso: str) -> float:
    """Days between the run's start time and an ISO-8601 timestamp."""
    ...
def now() -> str:
    """The run's start time (ISO-8601, fixed for the whole run)."""
    ...
`;
const BUILTIN_OPS = new Set(['parallel', 'days_since', 'now']);
/** Also callable without the `ops.` prefix (composite scripts in overlays use them bare). */
const BARE_GLOBALS = new Set(['days_since']);
const LIMIT_EXCEPTIONS = new Set(['TimeoutError', 'MemoryError', 'RecursionError']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCRIPT_NAME = 'script.py';

class Aborted extends Error {}

const noopLogger: ExecLogger = { debug() {}, info() {}, warn() {}, error() {} };

/** Runs scripts in a pool of crash-isolated Monty worker subprocesses, one fresh worker per run. */
export class MontyRunner {
  private active = 0;
  private closed = false;

  private constructor(
    private readonly pool: Monty,
    readonly poolMax: number,
    readonly binaryPath: string,
    readonly binarySha256: string,
    private readonly log: ExecLogger,
  ) {}

  static async create(opts: MontyRunnerOptions): Promise<MontyRunner> {
    const binaryPath = resolveMontyBinary(opts.binaryPath);
    const sha = verifyMontyBinary(binaryPath, opts.binarySha256 ?? process.env.MONTY_BINARY_SHA256);
    const poolMax = Math.max(1, opts.poolMax);
    const prewarm = Math.max(0, Math.min(opts.prewarm, poolMax));
    const clock = opts.executionClock ?? (process.platform === 'linux' ? 'cpu' : 'wall');
    const pool = await (await loadMonty()).Monty.create({
      binaryPath,
      executionClock: clock,
      minProcesses: prewarm,
      preWarm: prewarm,
      maxProcesses: poolMax,
      checkoutTimeout: opts.checkoutTimeoutSec ?? 5,
      requestTimeout: opts.requestTimeoutSec ?? 35,
      feedDurationLimitGrace: 1,
      turnDurationLimitGrace: 1,
      // one session per worker: discard after every run (plan L2/L6)
      maxCheckoutsPerWorker: 1,
    });
    const log = opts.logger ?? noopLogger;
    log.info({ binaryPath, sha256: sha, poolMax, prewarm, clock, montyVersion: montyVersion() }, 'monty pool started');
    return new MontyRunner(pool, poolMax, binaryPath, sha, log);
  }

  get busy(): number {
    return this.active;
  }

  get montyVersion(): string {
    return montyVersion();
  }

  health(): ExecutorHealth {
    return { ok: !this.closed, montyVersion: montyVersion(), poolSize: this.poolMax, busy: this.active, ...(this.closed ? { detail: 'closed' } : {}) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.pool.close().catch(() => {});
  }

  async run(req: RunRequest, host: HostBridge, signal: AbortSignal): Promise<RunResult> {
    const t0 = performance.now();
    const limits = { ...DEFAULT_LIMITS, ...req.limits };
    const lineOffset = req.lineOffset ?? 0;
    const colOffset = req.colOffset ?? 0;
    const stats = { wallMs: 0, suspensions: 0, toolCalls: 0 };
    let stdout = '';
    let stdoutBytes = 0;
    let limitTripped: string | null = null;
    let wallExpired = false;
    let session: MontySession | null = null;
    let killed = false;
    let workerPid: number | undefined;

    const finish = (status: RunStatus, extra: Partial<RunResult> = {}): RunResult => {
      stats.wallMs = Math.round(performance.now() - t0);
      return { status, valueBytes: 0, stats, stdout, ...extra };
    };
    if (this.closed) return finish('crashed', { error: { type: 'executor_unavailable', message: 'executor is shutting down' } });

    // abort plumbing: caller signal + executor wall deadline
    let rejectAbort!: (e: Error) => void;
    const aborted = new Promise<never>((_, rej) => (rejectAbort = rej));
    aborted.catch(() => {});
    const onAbort = () => rejectAbort(new Aborted('aborted'));
    if (signal.aborted) return finish('cancelled', { error: { type: 'cancelled', message: String(signal.reason ?? 'cancelled') } });
    signal.addEventListener('abort', onAbort, { once: true });
    const wallTimer = setTimeout(() => {
      wallExpired = true;
      rejectAbort(new Aborted('wall'));
    }, limits.wallTimeSec * 1000);
    const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, aborted]);

    const allowed = new Set<string>();
    const externalModules: Record<string, ExternalModule> = {};
    const refuse = () => {
      throw new Error('host functions are answered by the executor drive loop');
    };
    const modules = { ...req.modules };
    if (!modules.ops) modules.ops = { functions: [], stubs: '' };
    for (const [ns, spec] of Object.entries(modules)) {
      const attrs: Record<string, unknown> = {};
      const fns = ns === 'ops' ? [...new Set([...spec.functions, ...BUILTIN_OPS])] : spec.functions;
      for (const fn of fns) {
        attrs[fn] = refuse;
        if (!(ns === 'ops' && BUILTIN_OPS.has(fn))) allowed.add(`${ns}.${fn}`);
      }
      const stubs = ns === 'ops' ? `${BUILTIN_OPS_STUBS}\n${spec.stubs}` : spec.stubs;
      externalModules[ns] = new (M().ExternalModule)(attrs, { stubs });
    }
    const inputs = req.inputs ?? {};
    const globalStubs = ['from typing import Any', 'def days_since(iso: str) -> float: ...', ...Object.keys(inputs).filter((k) => IDENT.test(k)).map((k) => `${k}: Any`)].join('\n') + '\n' + (req.typeStubs ? `${req.typeStubs}\n` : '');
    const frozenNow = new Date(req.osPolicy.datetime);
    const nowMs = Number.isNaN(frozenNow.getTime()) ? Date.now() : frozenNow.getTime();
    const prelude = req.prelude ?? `import ${Object.keys(modules).join(', ')}`;
    const notHandled = M().NOT_HANDLED;
    const denyOs = () => notHandled;

    const callHost = async (fn: string, kwargs: Record<string, unknown>): Promise<HostCallResult> => {
      stats.toolCalls++;
      if (stats.toolCalls > limits.maxToolCalls) {
        limitTripped = `limit_exceeded: ${limits.maxToolCalls} tool calls`;
        return { ok: false, error: { code: 'limit_exceeded', message: `${limits.maxToolCalls} tool calls` } };
      }
      try {
        const r = await race(host.call(fn, kwargs));
        if (!r.ok && r.error.code === 'limit_exceeded') limitTripped = `limit_exceeded: ${r.error.message}`;
        return r;
      } catch (err) {
        if (err instanceof Aborted) throw err;
        return { ok: false, error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } };
      }
    };
    const toPyError = (e: ToolCallError) => {
      if (e.pyType && (HOST_ERROR_TYPES as readonly string[]).includes(e.pyType)) {
        const err = new Error(e.message);
        err.name = e.pyType;
        return err;
      }
      return new Error(`${e.code}: ${e.message}${e.errorId ? ` (error_id=${e.errorId})` : ''}`);
    };

    const parallel = async (calls: unknown): Promise<unknown[]> => {
      if (!Array.isArray(calls)) throw new TypeError('ops.parallel expects a list of (tool_name, kwargs) tuples');
      const items = calls.map((c) => {
        if (!Array.isArray(c) || c.length !== 2 || typeof c[0] !== 'string') return null;
        const kw = toJson(c[1]);
        if (kw === null || typeof kw !== 'object' || Array.isArray(kw)) return null;
        return { fn: c[0], kwargs: kw as Record<string, unknown> };
      });
      const results: unknown[] = new Array(items.length);
      let next = 0;
      const worker = async () => {
        while (next < items.length) {
          const i = next++;
          const item = items[i];
          if (!item) {
            results[i] = { ok: false, error: { code: 'invalid_args', message: 'each item must be a (tool_name, kwargs) tuple', error_id: null } };
            continue;
          }
          if (!allowed.has(item.fn)) {
            results[i] = { ok: false, error: { code: 'unknown_tool', message: 'Tool not found or not permitted', error_id: null } };
            continue;
          }
          const r = await callHost(item.fn, item.kwargs);
          results[i] = r.ok ? { ok: true, value: r.value } : { ok: false, error: { code: r.error.code, message: r.error.message, error_id: r.error.errorId ?? null } };
        }
      };
      await Promise.all(Array.from({ length: Math.min(limits.maxConcurrentCalls, items.length) }, worker));
      return results;
    };

    const builtin = async (name: string, args: unknown[], kwargs: Record<string, unknown>): Promise<unknown> => {
      switch (name) {
        case 'parallel':
          return parallel(args[0] ?? kwargs.calls);
        case 'days_since': {
          const iso = args[0] ?? kwargs.iso;
          const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
          if (Number.isNaN(t)) throw new TypeError('days_since expects an ISO-8601 string');
          return (nowMs - t) / 86_400_000;
        }
        case 'now':
          return new Date(nowMs).toISOString();
      }
      throw new TypeError(`unknown helper ${name}`);
    };

    this.active++;
    try {
      session = await race(
        this.pool.checkout({
          scriptName: SCRIPT_NAME,
          limits: {
            maxFeedDurationSecs: limits.cpuTimeSec,
            maxMemory: Math.round(limits.maxMemoryMb * 1024 * 1024),
            maxRecursionDepth: limits.maxRecursionDepth ?? 200,
            maxSuspensions: limits.maxToolCalls + 50 + 10 * Object.keys(modules).length,
            maxTotalSleepSecs: 0,
          },
          typeCheck: req.typeCheck ?? true,
          typeCheckFormat: 'json',
          typeCheckStubs: globalStubs,
          externalModules,
          osPolicy: { datetime: new Date(nowMs), timezone: 'utc', sleep: 'zero', randomStart: { seed: req.osPolicy.seed }, processTime: 'zero' },
        }),
      );
      const s = session;
      // the pid is not readable while a turn is in flight, so remember it now (cancel/wall kill)
      workerPid = s.workerPid;
      // feed 1: the prelude binds the namespaces (imports resolve only from externalModules)
      let snap: Snapshot = await race(s.feedStart(prelude, { os: denyOs }));
      while (!(snap instanceof M().MontyComplete)) snap = await race(snap.resumeAuto());
      // feed 2: the wrapped user code
      snap = await race(
        s.feedStart(req.code, {
          inputs,
          os: denyOs,
          printCallback: (_stream, text) => {
            if (stdoutBytes >= MAX_STDOUT_BYTES) return;
            const chunk = truncateUtf8(text, MAX_STDOUT_BYTES - stdoutBytes);
            stdout += chunk;
            stdoutBytes += Buffer.byteLength(chunk, 'utf8');
          },
        }),
      );
      while (!(snap instanceof M().MontyComplete)) {
        stats.suspensions++;
        if (snap instanceof M().FunctionSnapshot) {
          const name = snap.functionName;
          if (snap.isOsFunction) {
            snap = await race(snap.resumeNotHandled());
            continue;
          }
          const dot = name.indexOf('.');
          const bare = dot < 0 && BARE_GLOBALS.has(name) ? name : null;
          const opsHelper = name.startsWith('ops.') && BUILTIN_OPS.has(name.slice(4)) ? name.slice(4) : null;
          if (bare || opsHelper) {
            const call = snap;
            let value: unknown;
            try {
              value = await builtin((bare ?? opsHelper)!, call.args, call.kwargs);
            } catch (err) {
              if (err instanceof Aborted) throw err;
              snap = await race(call.resumeError(err));
              continue;
            }
            snap = await race(call.resume(value));
            continue;
          }
          if (allowed.has(name)) {
            if (snap.args.length > 0) {
              snap = await race(snap.resumeError(new TypeError(`${name}() takes keyword arguments only: use keyword arguments, e.g. ${name}(name=value)`)));
              continue;
            }
            const call = snap;
            const r = await callHost(name, toJson(call.kwargs) as Record<string, unknown>);
            snap = await race(r.ok ? call.resume(r.value) : call.resumeError(toPyError(r.error)));
            continue;
          }
          // import machinery or a name we do not provide: Monty's default answer (AttributeError/NameError)
          snap = await race(snap.resumeAuto());
          continue;
        }
        if (snap instanceof M().NameLookupSnapshot && BARE_GLOBALS.has(snap.variableName)) {
          snap = await race(snap.resume(snap.variableName));
          continue;
        }
        snap = await race(snap.resumeAuto());
      }
      const value = toJson(snap.output);
      const valueBytes = jsonBytes(value);
      if (valueBytes > limits.maxResultBytes) {
        return finish('ok', { valueBytes, truncated: true, preview: truncateUtf8(JSON.stringify(value), PREVIEW_BYTES) });
      }
      return finish('ok', { value, valueBytes });
    } catch (err) {
      if (err instanceof Aborted) {
        if (session) {
          killWorker(workerPid);
          killed = true;
        }
        return wallExpired
          ? finish('limit_exceeded', { error: { type: 'TimeoutError', message: `wall time limit of ${limits.wallTimeSec}s exceeded` } })
          : finish('cancelled', { error: { type: 'cancelled', message: String(signal.reason ?? 'cancelled') } });
      }
      const mapped = mapError(err, lineOffset, limitTripped, limits.cpuTimeSec, colOffset);
      if (mapped.status === 'crashed') this.log.warn({ runId: req.runId, err: mapped.error }, 'monty worker crashed');
      return finish(mapped.status, { error: mapped.error });
    } finally {
      clearTimeout(wallTimer);
      signal.removeEventListener('abort', onAbort);
      this.active--;
      if (session) {
        // a killed worker's close can wait for the turn to unwind; never hold the result for it
        const closing = session.close().catch(() => {});
        if (!killed) await closing;
      }
    }
  }
}

function killWorker(pid: number | undefined): void {
  if (pid) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

interface TypingDiagnostic {
  code?: string;
  message?: string;
  severity?: string;
  location?: { row?: number; column?: number };
}

const mapCol = (col: number | undefined, offset: number): number | undefined => (col === undefined ? undefined : Math.max(1, col - offset));
const mapLine = (line: number | undefined, offset: number): number | undefined => (line === undefined ? undefined : Math.max(1, line - offset));

/** The prelude is feed 0 and the user's (wrapped) code feed 1: frames of the prelude are not the script's. */
const PRELUDE_FILE = '<python-input-0>';
const USER_FILE = '<python-input-1>';

function cleanTraceback(text: string, offset: number): string {
  // drop the prelude's frames (`File "<python-input-0>", line N, in f` + its source and marker lines)
  const lines = text.split('\n');
  const kept: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.includes(`File "${PRELUDE_FILE}"`)) {
      while (i + 1 < lines.length && /^\s{4,}/.test(lines[i + 1]!)) i++;
      continue;
    }
    kept.push(lines[i]!);
  }
  return kept.join('\n').replace(/<python-input-\d+>/g, SCRIPT_NAME).replace(/line (\d+)/g, (_m, n: string) => `line ${mapLine(Number(n), offset)}`);
}

/** Maps a Monty exception to a run status and a user-facing error with user line numbers. */
export function mapError(err: unknown, offset: number, limitTripped: string | null, cpuSec: number, colOffset = 0): { status: RunStatus; error: RunError } {
  // a Monty error implies Monty is loaded; without it nothing below can match
  const { MontyTypingError, MontySyntaxError, MontyRuntimeError, MontyCrashedError } = montyModule ?? ({} as Partial<typeof MontyModule>);
  if (MontyTypingError && err instanceof MontyTypingError) {
    let diags: TypingDiagnostic[] = [];
    try {
      diags = JSON.parse(err.display()) as TypingDiagnostic[];
    } catch {
      /* non-JSON rendering */
    }
    const errors = diags.filter((d) => d.severity !== 'warning' && d.severity !== 'info');
    const first = errors[0] ?? diags[0];
    const syntax = errors.some((d) => d.code === 'invalid-syntax');
    const lines = errors.map((d) => `line ${mapLine(d.location?.row, offset)}, col ${mapCol(d.location?.column, colOffset) ?? '?'}: ${d.message ?? ''} [${d.code ?? 'type'}]`);
    return {
      status: syntax ? 'syntax_error' : 'type_error',
      error: {
        type: syntax ? 'SyntaxError' : 'TypeError',
        message: first?.message ?? err.message,
        ...(first?.location?.row !== undefined ? { line: mapLine(first.location.row, offset)! } : {}),
        ...(first?.location?.column !== undefined ? { col: mapCol(first.location.column, colOffset)! } : {}),
        traceback: lines.join('\n') || err.display(),
      },
    };
  }
  if (MontySyntaxError && err instanceof MontySyntaxError) {
    const tb = err.display('traceback');
    const m = /line (\d+)/.exec(tb);
    return { status: 'syntax_error', error: { type: 'SyntaxError', message: err.display('msg'), ...(m ? { line: mapLine(Number(m[1]), offset)! } : {}), traceback: cleanTraceback(tb, offset) } };
  }
  if (MontyRuntimeError && err instanceof MontyRuntimeError) {
    const { typeName } = err.exception;
    const frames = err.traceback();
    // an error raised inside a prelude function (contract-2 tool wrappers) is reported at the user's calling line
    const user = frames.filter((f) => f.filename === USER_FILE);
    const last = user[user.length - 1] ?? frames.filter((f) => f.filename !== PRELUDE_FILE).pop() ?? frames[frames.length - 1];
    const status: RunStatus = LIMIT_EXCEPTIONS.has(typeName) || limitTripped ? 'limit_exceeded' : 'script_error';
    return {
      status,
      error: {
        type: typeName,
        message: err.display('msg'),
        ...(last ? { line: mapLine(last.line, offset)!, col: mapCol(last.column, colOffset)! } : {}),
        traceback: cleanTraceback(err.display('traceback'), offset),
      },
    };
  }
  if (MontyCrashedError && err instanceof MontyCrashedError) {
    if (err.timedOut) return { status: 'limit_exceeded', error: { type: 'TimeoutError', message: `time limit exceeded (${cpuSec}s execution budget)` } };
    return { status: 'crashed', error: { type: 'crashed', message: err.message + (err.exitStatus ? ` (${err.exitStatus})` : '') } };
  }
  if (err instanceof Error && err.name === 'TimeoutError') return { status: 'crashed', error: { type: 'executor_busy', message: 'no Monty worker became available in time' } };
  return { status: 'crashed', error: { type: 'executor_error', message: err instanceof Error ? err.message : String(err) } };
}
