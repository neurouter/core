import net from 'node:net';
import { encodeFrame, FrameDecoder, parseFrame, ToServerFrame, type CallFrame, type HelloAckFrame } from './frames.js';
import { silentLogger } from './logger.js';
import { PROTOCOL_VERSION, type ExecLogger, type Executor, type ExecutorHealth, type HostBridge, type RunRequest, type RunResult } from './types.js';

export type ExecutorAddress = { socketPath: string } | { host: string; port: number };

export interface SocketExecutorOptions {
  address: ExecutorAddress;
  token: string;
  /** How long `run()`/`health()` keep retrying to connect (default 5000 ms). */
  connectTimeoutMs?: number;
  pingIntervalMs?: number;
  logger?: ExecLogger;
  /** Expected monty binary sha256; a mismatching `hello_ack` closes the connection. */
  expectedMontySha256?: string;
}

interface PendingRun {
  req: RunRequest;
  host: HostBridge;
  allowed: Set<string>;
  resolve: (r: RunResult) => void;
  t0: number;
}

/** Parses `unix:///path.sock` or `tcp://host:port` (`NEUROUTER_EXECUTOR_URL`). */
export function parseExecutorUrl(url: string): ExecutorAddress {
  if (url.startsWith('unix://')) return { socketPath: url.slice('unix://'.length) };
  const m = /^tcp:\/\/([^:/]+):(\d+)\/?$/.exec(url);
  if (m) return { host: m[1]!, port: Number(m[2]) };
  throw new Error(`invalid executor URL ${url} (expected unix:///path.sock or tcp://host:port)`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Server-side client of the executor (§10.6). One connection, multiplexed by `runId`; executor frames
 * are untrusted: every frame is schema-checked and each `call` must match its run's capability and
 * allowed function list. A lost connection fails in-flight runs with status `crashed`; the next call
 * reconnects.
 */
export class SocketExecutor implements Executor {
  readonly kind = 'socket' as const;
  private sock: net.Socket | null = null;
  private connecting: Promise<void> | null = null;
  private ack: HelloAckFrame | null = null;
  private readonly runs = new Map<string, PendingRun>();
  private pingTimer: NodeJS.Timeout | null = null;
  private missedPongs = 0;
  private closed = false;
  private lastError: string | null = null;
  private readonly log: ExecLogger;

  constructor(private readonly opts: SocketExecutorOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  get connected(): boolean {
    return !!this.sock && !!this.ack && !this.sock.destroyed;
  }

  get helloAck(): HelloAckFrame | null {
    return this.ack;
  }

  /** Connects (retrying until `timeoutMs`). */
  async connect(timeoutMs = this.opts.connectTimeoutMs ?? 5000): Promise<void> {
    if (this.closed) throw new Error('executor client closed');
    if (this.connected) return;
    this.connecting ??= this.connectLoop(timeoutMs).finally(() => (this.connecting = null));
    return this.connecting;
  }

  private async connectLoop(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let delay = 50;
    for (;;) {
      try {
        await this.connectOnce();
        return;
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        if (this.closed || Date.now() + delay > deadline) throw new Error(`executor unavailable: ${this.lastError}`, { cause: err });
        await sleep(delay);
        delay = Math.min(delay * 2, 500);
      }
    }
  }

  private connectOnce(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const addr = this.opts.address;
      const sock = 'socketPath' in addr ? net.createConnection(addr.socketPath) : net.createConnection(addr.port, addr.host);
      const decoder = new FrameDecoder();
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          sock.destroy();
          reject(err);
        } else resolve();
      };
      const timer = setTimeout(() => settle(new Error('hello timeout')), 5000);
      sock.once('connect', () => {
        sock.write(encodeFrame({ type: 'hello', protocol: PROTOCOL_VERSION, token: this.opts.token }));
      });
      sock.on('data', (chunk: Buffer) => {
        let raws: unknown[];
        try {
          raws = decoder.push(chunk);
        } catch (err) {
          return this.protocolError(sock, err);
        }
        for (const raw of raws) {
          let frame: ToServerFrame;
          try {
            frame = parseFrame(ToServerFrame, raw);
          } catch (err) {
            if (!settled) return settle(err as Error);
            return this.protocolError(sock, err);
          }
          if (!settled) {
            if (frame.type === 'error') return settle(new Error(`executor refused: ${frame.message}`));
            if (frame.type !== 'hello_ack') return settle(new Error(`unexpected ${frame.type} before hello_ack`));
            if (this.opts.expectedMontySha256 && frame.montyBinarySha256 !== this.opts.expectedMontySha256) {
              return settle(new Error('executor monty binary checksum mismatch'));
            }
            this.ack = frame;
            this.sock = sock;
            this.startPings(sock);
            this.lastError = null;
            settle();
            continue;
          }
          this.onFrame(sock, frame);
        }
      });
      sock.on('error', (err) => {
        this.lastError = err.message;
        settle(err);
      });
      sock.on('close', () => {
        settle(new Error('connection closed'));
        if (this.sock === sock) this.onDisconnect('executor connection lost');
      });
    });
  }

  private startPings(sock: net.Socket): void {
    this.missedPongs = 0;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (this.missedPongs >= 3) {
        this.log.warn({}, 'executor missed 3 pongs; resetting connection');
        sock.destroy();
        return;
      }
      this.missedPongs++;
      this.write({ type: 'ping', t: Date.now() });
    }, this.opts.pingIntervalMs ?? 10_000);
    this.pingTimer.unref();
  }

  private protocolError(sock: net.Socket, err: unknown): void {
    this.log.warn({ err }, 'executor protocol error');
    const msg = err instanceof Error ? err.message : 'protocol error';
    this.failAll('executor_protocol_error', msg);
    sock.destroy();
  }

  private onDisconnect(reason: string): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.sock = null;
    this.ack = null;
    this.failAll('executor_disconnected', reason);
  }

  private failAll(type: string, message: string): void {
    for (const [runId, run] of this.runs) {
      this.runs.delete(runId);
      run.resolve({ status: 'crashed', valueBytes: 0, error: { type, message }, stats: { wallMs: Date.now() - run.t0, suspensions: 0, toolCalls: 0 }, stdout: '' });
    }
  }

  private write(frame: object): boolean {
    if (!this.sock || this.sock.destroyed) return false;
    this.sock.write(encodeFrame(frame));
    return true;
  }

  private onFrame(sock: net.Socket, frame: ToServerFrame): void {
    switch (frame.type) {
      case 'pong':
        this.missedPongs = 0;
        return;
      case 'ping':
        this.write({ type: 'pong', ...(frame.t !== undefined ? { t: frame.t } : {}) });
        return;
      case 'print':
        return; // stdout is delivered with `done`
      case 'error':
        this.log.warn({ message: frame.message }, 'executor reported an error');
        return;
      case 'hello_ack':
        return this.protocolError(sock, new Error('duplicate hello_ack'));
      case 'call':
        void this.onCall(frame);
        return;
      case 'done': {
        const run = this.runs.get(frame.runId);
        if (!run) return;
        this.runs.delete(frame.runId);
        const { type: _t, runId: _r, ...result } = frame;
        run.resolve(result as RunResult);
        return;
      }
    }
  }

  private async onCall(frame: CallFrame): Promise<void> {
    const run = this.runs.get(frame.runId);
    const reject = (code: string, message: string) => this.write({ type: 'call_result', runId: frame.runId, callId: frame.callId, ok: false, error: { code, message } });
    // defense in depth: the executor only exposes allowed functions, but its frames are untrusted
    if (!run || frame.capability !== run.req.capability) {
      this.log.warn({ runId: frame.runId, fn: frame.fn }, 'executor call rejected: unknown run or capability mismatch');
      return void reject('not_permitted', 'run capability mismatch');
    }
    if (!run.allowed.has(frame.fn)) {
      this.log.warn({ runId: frame.runId, fn: frame.fn }, 'executor call rejected: function not allowed');
      return void reject('unknown_tool', 'Tool not found or not permitted');
    }
    let result;
    try {
      result = await run.host.call(frame.fn, frame.kwargs);
    } catch (err) {
      result = { ok: false as const, error: { code: 'internal', message: err instanceof Error ? err.message : String(err) } };
    }
    if (!this.runs.has(frame.runId)) return;
    try {
      this.write({ type: 'call_result', runId: frame.runId, callId: frame.callId, ...result });
    } catch {
      reject('response_too_large', 'tool result exceeds the executor frame limit');
    }
  }

  async health(): Promise<ExecutorHealth> {
    try {
      await this.connect(1000);
    } catch (err) {
      return { ok: false, montyVersion: 'unknown', poolSize: 0, busy: this.runs.size, detail: err instanceof Error ? err.message : String(err) };
    }
    return { ok: true, montyVersion: this.ack?.montyVersion ?? 'unknown', poolSize: this.ack?.poolMax ?? 0, busy: this.runs.size };
  }

  async run(req: RunRequest, host: HostBridge, signal: AbortSignal): Promise<RunResult> {
    const t0 = Date.now();
    const crashed = (type: string, message: string): RunResult => ({ status: 'crashed', valueBytes: 0, error: { type, message }, stats: { wallMs: Date.now() - t0, suspensions: 0, toolCalls: 0 }, stdout: '' });
    if (signal.aborted) return { ...crashed('cancelled', 'cancelled'), status: 'cancelled' };
    try {
      await this.connect();
    } catch (err) {
      return crashed('executor_unavailable', err instanceof Error ? err.message : String(err));
    }
    if (this.runs.has(req.runId)) return crashed('executor_error', `duplicate runId ${req.runId}`);
    const allowed = new Set<string>();
    for (const [ns, spec] of Object.entries(req.modules)) for (const fn of spec.functions) allowed.add(`${ns}.${fn}`);
    return new Promise<RunResult>((resolve) => {
      let fallback: NodeJS.Timeout | null = null;
      const onAbort = () => {
        this.write({ type: 'cancel', runId: req.runId, reason: String(signal.reason ?? 'cancelled') });
        // the executor answers `done` (cancelled) after killing the worker; don't wait forever
        fallback = setTimeout(() => {
          if (!this.runs.delete(req.runId)) return;
          resolve({ ...crashed('cancelled', 'cancelled (executor did not confirm)'), status: 'cancelled' });
        }, 5000);
      };
      this.runs.set(req.runId, {
        req,
        host,
        allowed,
        t0,
        resolve: (r) => {
          signal.removeEventListener('abort', onAbort);
          if (fallback) clearTimeout(fallback);
          resolve(r);
        },
      });
      signal.addEventListener('abort', onAbort, { once: true });
      try {
        if (!this.write({ type: 'run', ...req })) throw new Error('not connected');
      } catch (err) {
        this.runs.delete(req.runId);
        signal.removeEventListener('abort', onAbort);
        resolve(crashed('executor_error', err instanceof Error ? err.message : String(err)));
      }
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.failAll('executor_unavailable', 'executor client closed');
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.sock?.destroy();
    this.sock = null;
  }
}
