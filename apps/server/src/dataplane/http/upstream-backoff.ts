/**
 * Upstream backoff (0.3.3): when an upstream answers 429 or 503, how long it asks the caller to wait — `Retry-After`
 * (seconds or an HTTP date), else `X-RateLimit-Remaining: 0` with `X-RateLimit-Reset` (epoch seconds, as GitHub
 * sends it, or seconds from now). Null when the response gives no hint (the caller does not guess).
 */
export function upstreamRetryAfterMs(status: number, headers: Record<string, string>, now: number): number | null {
  if (status !== 429 && status !== 503) return null;
  const ra = headers['retry-after']?.trim();
  if (ra) {
    if (/^\d+(\.\d+)?$/.test(ra)) return Math.max(0, Math.round(Number(ra) * 1000));
    const at = Date.parse(ra);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const remaining = headers['x-ratelimit-remaining'];
  const reset = headers['x-ratelimit-reset']?.trim();
  if (remaining !== undefined && Number(remaining) <= 0 && reset && /^\d+(\.\d+)?$/.test(reset)) {
    const v = Number(reset);
    // epoch seconds (GitHub) vs seconds from now (IETF RateLimit drafts, many APIs)
    return Math.max(0, Math.round(v > 1_000_000_000 ? v * 1000 - now : v * 1000));
  }
  return null;
}

/** Retry policy of one upstream call: reads only (the pipeline passes none for writes, which are never retried). */
export interface UpstreamRetry {
  maxRetries: number;
  /** Longest single wait (ms); a longer Retry-After is surfaced instead. */
  maxWaitMs: number;
  /** No wait may end after this epoch ms (a script's wall time). */
  deadline?: number;
}

/** Defaults: 2 retries, each wait ≤ 10 s. */
export const UPSTREAM_RETRY: Omit<UpstreamRetry, 'deadline'> = { maxRetries: 2, maxWaitMs: 10_000 };

/** A FIFO counting semaphore (per-environment upstream concurrency cap). */
export class Gate {
  private active = 0;
  private readonly queue: Array<() => void> = [];
  constructor(public max: number) {}
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const go = () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.queue.indexOf(go);
          if (i >= 0) this.queue.splice(i, 1);
          reject(new Error('cancelled'));
        };
        this.queue.push(go);
        signal?.addEventListener('abort', onAbort, { once: true });
      });
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.queue.shift()?.();
    };
  }
}
