/**
 * Executor contract (backend spec §10.6). The server implements `HostBridge` (every host call runs the
 * full policy pipeline); an `Executor` runs one wrapped script per `run()` in a fresh Monty worker.
 */

export type RunStatus = 'ok' | 'script_error' | 'syntax_error' | 'type_error' | 'limit_exceeded' | 'crashed' | 'cancelled';

export interface ModuleSpec {
  /** Function names exposed as `<ns>.<fn>` (keyword-only host functions). */
  functions: string[];
  /** `.pyi` source for the namespace (type checking). */
  stubs: string;
}

export interface RunLimits {
  /** Monty `maxFeedDurationSecs` (CPU clock on Linux, wall elsewhere). Default 10. */
  cpuTimeSec: number;
  /** Executor-side wall deadline for the whole run (the server enforces its own as well). Default 30. */
  wallTimeSec: number;
  /** Monty `maxMemory` in MiB. Default 64. */
  maxMemoryMb: number;
  /** Host calls per run (backstop; the server counts too). Default 200. */
  maxToolCalls: number;
  /** Concurrency for `ops.parallel`. Default 8. */
  maxConcurrentCalls: number;
  /** Serialized result cap; larger results return a preview. Default 1 MiB. */
  maxResultBytes: number;
  /** Monty `maxRecursionDepth`. Default 200. */
  maxRecursionDepth?: number;
}

export interface RunOsPolicy {
  /** Frozen clock for `datetime.now()` and `ops.now()` (ISO-8601). */
  datetime: string;
  /** `random.seed()` value. */
  seed: string | number;
}

export interface RunRequest {
  runId: string;
  /** Run capability (`rc_…`), minted by the server; never enters the VM. */
  capability: string;
  /** Wrapped user code (see the server's `wrapScript`). */
  code: string;
  /** Lines added before the user's first line by the wrapper (reported lines are mapped back). */
  lineOffset?: number;
  /** Columns added by the wrapper's indentation (reported columns are mapped back). */
  colOffset?: number;
  /** First feed; defaults to `import <every namespace>, ops`. Its frames never count as the script's (errors report the user's line). */
  prelude?: string;
  /**
   * Extra type-check declarations for the user code (appended to the global stubs): a prelude that rebinds names
   * (contract 2 binds each namespace to Python objects with `.page()`/`.pages()`) declares their types here.
   */
  typeStubs?: string;
  /** Allowed namespaces and functions. `ops` may list server-side ops functions (log_decision, …). */
  modules: Record<string, ModuleSpec>;
  /** Values bound as globals. */
  inputs: Record<string, unknown>;
  limits: RunLimits;
  osPolicy: RunOsPolicy;
  /** Type-check against the stubs before running (default true). */
  typeCheck?: boolean;
}

export interface ToolCallError {
  code: string;
  message: string;
  errorId?: string;
  /**
   * Python exception type to raise (contract 2: `LookupError` for not_found, `ValueError` for invalid_args, …);
   * the message is then raised as is (the host's error object as JSON). Absent: `RuntimeError("<code>: <message>")`.
   */
  pyType?: string;
}

/** Exception types a host error may raise as (built-in Python exceptions only). */
export const HOST_ERROR_TYPES = ['LookupError', 'ValueError', 'PermissionError', 'TimeoutError', 'AttributeError', 'RuntimeError'] as const;

export type HostCallResult = { ok: true; value: unknown } | { ok: false; error: ToolCallError };

export interface HostBridge {
  /** `fn` is `"<ns>.<fn>"`; kwargs are plain JSON values. Must not throw (return `{ ok: false }`). */
  call(fn: string, kwargs: Record<string, unknown>): Promise<HostCallResult>;
}

export interface RunError {
  type: string;
  message: string;
  line?: number;
  col?: number;
  traceback?: string;
}

export interface RunStats {
  wallMs: number;
  suspensions: number;
  toolCalls: number;
}

export interface RunResult {
  status: RunStatus;
  /** JSON value (Python dicts → objects, tuples/sets → arrays). Absent when truncated or failed. */
  value?: unknown;
  /** Serialized JSON size of the full value. */
  valueBytes: number;
  /** True when `valueBytes > limits.maxResultBytes`: `value` is omitted and `preview` holds the first 8 KiB. */
  truncated?: boolean;
  preview?: string;
  error?: RunError;
  stats: RunStats;
  /** Captured `print()` output (≤ 16 KiB). */
  stdout: string;
}

export interface ExecutorHealth {
  ok: boolean;
  montyVersion: string;
  poolSize: number;
  busy: number;
  detail?: string;
}

export interface Executor {
  readonly kind: 'socket' | 'local';
  health(): Promise<ExecutorHealth>;
  run(req: RunRequest, host: HostBridge, signal: AbortSignal): Promise<RunResult>;
  close(): Promise<void>;
}

/** Minimal logger (pino-compatible signature). */
export interface ExecLogger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const DEFAULT_LIMITS: RunLimits = {
  cpuTimeSec: 10,
  wallTimeSec: 30,
  maxMemoryMb: 64,
  maxToolCalls: 200,
  maxConcurrentCalls: 8,
  maxResultBytes: 1024 * 1024,
  maxRecursionDepth: 200,
};

export const MAX_STDOUT_BYTES = 16 * 1024;
export const PREVIEW_BYTES = 8 * 1024;
export const PROTOCOL_VERSION = 1;
