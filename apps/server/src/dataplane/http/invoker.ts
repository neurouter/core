import type { FetchLike } from '../../kernel/lib/net/safe-fetch.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type { BuiltRequest } from './request-builder.js';

export interface UpstreamResponse {
  status: number;
  /** Parsed JSON, `{ text }` for non-JSON bodies, or null for empty bodies. */
  body: unknown;
  bytes: number;
  /** Only Link, Retry-After and X-RateLimit-* survive (§9.9). */
  headers: Record<string, string>;
  latencyMs: number;
}

export class InvokeError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'transport' | 'response_too_large' | 'circuit_open' | 'cancelled' | 'blocked',
  ) {
    super(message);
  }
}

/** In-process mock upstream (§16): same request shape as HTTP, no network. */
export interface MockUpstream {
  handle(req: { environmentId: string; namespace: string; method: string; path: string; query: Record<string, string | string[]>; headers: Record<string, string>; body: unknown; mockModel: unknown }): Promise<{ status: number; headers?: Record<string, string>; body: unknown }>;
}

const KEEP_HEADERS = /^(link|retry-after|x-ratelimit-.*)$/i;
const TEXT_MAX = 64 * 1024;

async function readCapped(res: Response, max: number): Promise<{ buf: Buffer; over: boolean }> {
  if (!res.body) return { buf: Buffer.alloc(0), over: false };
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => {});
      return { buf: Buffer.alloc(0), over: true };
    }
    chunks.push(Buffer.from(value));
  }
  return { buf: Buffer.concat(chunks), over: false };
}

export function parseBody(buf: Buffer, contentType: string | null): unknown {
  if (!buf.length) return null;
  const text = buf.toString('utf8');
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(text)) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      // fall through to text
    }
  }
  return { text: text.slice(0, TEXT_MAX) };
}

/**
 * Upstream HTTP invoker (§9.6 step 11): SSRF-guarded fetch (safe-fetch: pinned DNS, deny-CIDRs,
 * re-validated redirects), per-call timeout, response size cap, and a circuit breaker per
 * environment (COPY Hub upstream/circuit-breaker).
 */
export class HttpInvoker {
  private readonly breakers = new Map<string, CircuitBreaker>();

  constructor(
    private readonly fetchFor: (allowHttp: boolean) => FetchLike,
    private readonly now: () => number = Date.now,
    private readonly onCircuit?: (environmentId: string, open: boolean) => void,
  ) {}

  breaker(environmentId: string): CircuitBreaker {
    let b = this.breakers.get(environmentId);
    if (!b) {
      b = new CircuitBreaker({ now: this.now });
      this.breakers.set(environmentId, b);
    }
    return b;
  }

  async invoke(environmentId: string, req: BuiltRequest, opts: { timeoutMs: number; maxBytes: number; signal?: AbortSignal; allowHttp: boolean; traceHeaders?: Record<string, string> }): Promise<UpstreamResponse> {
    const breaker = this.breaker(environmentId);
    if (!breaker.tryAcquire()) throw new InvokeError('upstream circuit open', 'circuit_open');
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('timeout')), opts.timeoutMs);
    const onAbort = () => ac.abort(new Error('cancelled'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const started = this.now();
    try {
      const res = await this.fetchFor(opts.allowHttp)(req.url, { method: req.method, headers: { ...req.headers, ...(opts.traceHeaders ?? {}) }, ...(req.body !== undefined ? { body: req.body } : {}), signal: ac.signal, redirect: 'manual' });
      const { buf, over } = await readCapped(res, opts.maxBytes);
      if (over) throw new InvokeError(`response larger than ${opts.maxBytes} bytes`, 'response_too_large');
      const headers: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (KEEP_HEADERS.test(k)) headers[k.toLowerCase()] = v;
      });
      if (res.status >= 500) breaker.onFailure();
      else breaker.onSuccess();
      this.reportCircuit(environmentId, breaker);
      return { status: res.status, body: parseBody(buf, res.headers.get('content-type')), bytes: buf.length, headers, latencyMs: this.now() - started };
    } catch (err) {
      if (err instanceof InvokeError) throw err;
      breaker.onFailure();
      this.reportCircuit(environmentId, breaker);
      if (opts.signal?.aborted) throw new InvokeError('cancelled', 'cancelled');
      if (ac.signal.aborted) throw new InvokeError(`no response within ${opts.timeoutMs} ms`, 'timeout');
      const msg = (err as Error).message ?? String(err);
      throw new InvokeError(msg, /blocked|forbidden address|not allowed/i.test(msg) ? 'blocked' : 'transport');
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }

  private reportCircuit(envId: string, b: CircuitBreaker): void {
    this.onCircuit?.(envId, b.state === 'open');
  }
}
