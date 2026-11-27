import { createHash, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, unlinkSync } from 'node:fs';
import net from 'node:net';
import { encodeFrame, FrameDecoder, FrameError, MAX_CALL_RESULT_BYTES, parseFrame, ToExecutorFrame, type RunFrame } from './frames.js';
import type { MontyRunner } from './monty-runner.js';
import { silentLogger } from './logger.js';
import { PROTOCOL_VERSION, type ExecLogger, type HostCallResult, type RunResult } from './types.js';
import { EXECUTOR_VERSION } from './version.js';

export interface ExecutorServerOptions {
  runner: MontyRunner;
  /** Shared secret the server must present in `hello`. */
  token: string;
  logger?: ExecLogger;
}

export type ListenAddress = { socketPath: string } | { host: string; port: number };

interface RunState {
  capability: string;
  ac: AbortController;
  nextCallId: number;
  pending: Map<number, (r: HostCallResult) => void>;
  /** call_result_part frames received so far, per call (M2). */
  parts: Map<number, { chunks: string[]; bytes: number; next: number }>;
}

function tokenEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb) && a.length === b.length;
}

/**
 * The executor side of the frame protocol (§10.6): authenticates the server with `hello`, then runs
 * scripts multiplexed by `runId`, forwarding each host call as a `call` frame.
 */
export class ExecutorServer {
  private server: net.Server | null = null;
  private readonly sockets = new Set<net.Socket>();
  private readonly log: ExecLogger;

  constructor(private readonly opts: ExecutorServerOptions) {
    this.log = opts.logger ?? silentLogger;
  }

  async listen(addr: ListenAddress): Promise<string> {
    const server = net.createServer((sock) => this.onConnection(sock));
    this.server = server;
    if ('socketPath' in addr) {
      if (existsSync(addr.socketPath)) unlinkSync(addr.socketPath);
      await new Promise<void>((res, rej) => {
        server.once('error', rej);
        server.listen(addr.socketPath, () => res());
      });
      chmodSync(addr.socketPath, 0o600);
      return addr.socketPath;
    }
    await new Promise<void>((res, rej) => {
      server.once('error', rej);
      server.listen(addr.port, addr.host, () => res());
    });
    const a = server.address();
    return typeof a === 'object' && a ? `${a.address}:${a.port}` : String(a);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((res) => (this.server ? this.server.close(() => res()) : res()));
  }

  private onConnection(sock: net.Socket): void {
    this.sockets.add(sock);
    const decoder = new FrameDecoder();
    const runs = new Map<string, RunState>();
    let authed = false;
    const send = (frame: object) => {
      if (sock.destroyed) return;
      sock.write(encodeFrame(frame));
    };
    const fail = (message: string) => {
      this.log.warn({ message }, 'closing executor connection');
      try {
        send({ type: 'error', message });
      } catch {
        /* ignore */
      }
      sock.destroy();
    };
    const helloTimer = setTimeout(() => !authed && fail('hello timeout'), 10_000);

    sock.on('data', (chunk: Buffer) => {
      let raws: unknown[];
      try {
        raws = decoder.push(chunk);
      } catch (err) {
        return fail(err instanceof Error ? err.message : 'protocol error');
      }
      for (const raw of raws) {
        let frame: ToExecutorFrame;
        try {
          frame = parseFrame(ToExecutorFrame, raw);
        } catch (err) {
          return fail(err instanceof FrameError ? err.message : 'invalid frame');
        }
        if (!authed) {
          if (frame.type !== 'hello' || !tokenEquals(frame.token, this.opts.token)) return fail('unauthorized');
          authed = true;
          clearTimeout(helloTimer);
          send({
            type: 'hello_ack',
            protocol: PROTOCOL_VERSION,
            executorVersion: EXECUTOR_VERSION,
            montyVersion: this.opts.runner.montyVersion,
            montyBinarySha256: this.opts.runner.binarySha256,
            poolMax: this.opts.runner.poolMax,
            features: ['call_result_parts'],
          });
          continue;
        }
        switch (frame.type) {
          case 'hello':
            return fail('duplicate hello');
          case 'ping':
            send({ type: 'pong', ...(frame.t !== undefined ? { t: frame.t } : {}) });
            break;
          case 'pong':
            break;
          case 'run':
            if (runs.has(frame.runId)) return fail(`duplicate runId ${frame.runId}`);
            this.startRun(frame, runs, send);
            break;
          case 'call_result': {
            const run = runs.get(frame.runId);
            const resolve = run?.pending.get(frame.callId);
            if (!run || !resolve) break; // late answer for a finished/cancelled run
            run.pending.delete(frame.callId);
            resolve(frame.ok ? { ok: true, value: frame.value } : { ok: false, error: frame.error });
            break;
          }
          case 'call_result_part': {
            // M2: a result over one frame, joined here (at most MAX_CALL_RESULT_BYTES per call)
            const run = runs.get(frame.runId);
            const resolve = run?.pending.get(frame.callId);
            if (!run || !resolve) break;
            const acc = run.parts.get(frame.callId) ?? { chunks: [], bytes: 0, next: 0 };
            const done = (r: HostCallResult) => {
              run.parts.delete(frame.callId);
              run.pending.delete(frame.callId);
              resolve(r);
            };
            if (frame.seq !== acc.next) {
              done({ ok: false, error: { code: 'response_too_large', message: 'the tool result arrived out of order' } });
              break;
            }
            acc.chunks.push(frame.part);
            acc.bytes += Buffer.byteLength(frame.part);
            acc.next++;
            if (acc.bytes > MAX_CALL_RESULT_BYTES) {
              done({ ok: false, error: { code: 'response_too_large', message: `the tool result is over the ${MAX_CALL_RESULT_BYTES}-byte limit for one call inside a script; ask for less (a smaller page size, fields or a filter)` } });
              break;
            }
            run.parts.set(frame.callId, acc);
            if (!frame.last) break;
            const joined = ((): { ok?: unknown; value?: unknown; error?: unknown } | null => {
              try {
                const v: unknown = JSON.parse(acc.chunks.join(''));
                return v && typeof v === 'object' ? (v as { ok?: unknown; value?: unknown; error?: unknown }) : null;
              } catch {
                return null;
              }
            })();
            const err = joined && joined.ok === false && joined.error && typeof joined.error === 'object' ? (joined.error as { code?: unknown; message?: unknown }) : null;
            if (joined && joined.ok === true) done({ ok: true, value: joined.value });
            else if (err) done({ ok: false, error: { code: String(err.code ?? 'tool_error').slice(0, 200), message: String(err.message ?? '').slice(0, 64 * 1024) } });
            else done({ ok: false, error: { code: 'response_too_large', message: 'the tool result could not be joined (malformed parts)' } });
            break;
          }
          case 'cancel':
            runs.get(frame.runId)?.ac.abort(frame.reason);
            break;
        }
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      clearTimeout(helloTimer);
      this.sockets.delete(sock);
      for (const run of runs.values()) {
        run.ac.abort('server disconnected');
        for (const resolve of run.pending.values()) resolve({ ok: false, error: { code: 'executor_disconnected', message: 'server disconnected' } });
      }
      runs.clear();
    });
  }

  private startRun(frame: RunFrame, runs: Map<string, RunState>, send: (f: object) => void): void {
    const state: RunState = { capability: frame.capability, ac: new AbortController(), nextCallId: 1, pending: new Map(), parts: new Map() };
    runs.set(frame.runId, state);
    const bridge = {
      call: (fn: string, kwargs: Record<string, unknown>) =>
        new Promise<HostCallResult>((resolve) => {
          if (state.ac.signal.aborted) return resolve({ ok: false, error: { code: 'cancelled', message: 'run cancelled' } });
          const callId = state.nextCallId++;
          state.pending.set(callId, resolve);
          try {
            send({ type: 'call', runId: frame.runId, capability: state.capability, callId, fn, kwargs });
          } catch (err) {
            state.pending.delete(callId);
            resolve({ ok: false, error: { code: 'invalid_args', message: err instanceof Error ? err.message : 'call too large' } });
          }
        }),
    };
    const { type: _t, ...req } = frame;
    const t0 = Date.now();
    void this.opts.runner
      .run(req, bridge, state.ac.signal)
      .then((result: RunResult) => {
        runs.delete(frame.runId);
        this.log.debug({ runId: frame.runId, status: result.status, ms: Date.now() - t0, toolCalls: result.stats.toolCalls }, 'run finished');
        try {
          send({ type: 'done', runId: frame.runId, ...result });
        } catch {
          send({ type: 'done', runId: frame.runId, ...result, value: undefined, truncated: true, preview: '' });
        }
      })
      .catch((err: unknown) => {
        runs.delete(frame.runId);
        this.log.error({ runId: frame.runId, err }, 'run failed unexpectedly');
        send({ type: 'done', runId: frame.runId, status: 'crashed', valueBytes: 0, error: { type: 'executor_error', message: String(err) }, stats: { wallMs: Date.now() - t0, suspensions: 0, toolCalls: 0 }, stdout: '' });
      });
  }
}
