import type { LimitCheck, LimitResult, RateLimiter } from './limiter.js';

/**
 * Pacing inside run_script (0.3.3, R1): an inner call that hits the gateway rate limiter waits for a token instead of
 * failing at once, because a script cannot sleep and retry by itself. Each wait is bounded by the script's remaining
 * wall time (less a margin to finish) and by a max wait per call (`limits.code.rateLimitWaitSec`, default 30 s; 0
 * turns pacing off). When the wait cannot fit, the call fails as before: `rate_limited` with `retry_after_ms`.
 */
export interface PaceBudget {
  /** Epoch ms after which no wait may end (script start + wall time − margin). */
  deadline: number;
  /** Longest wait of one call (ms). */
  maxWaitMs: number;
  /** Totals for the script's stats. */
  waitedMs: number;
  waits: number;
}

/** Room kept at the end of the script's wall time for it to use the answer and return. */
export const PACE_MARGIN_MS = 250;
export const DEFAULT_RATE_LIMIT_WAIT_SEC = 30;

export function newPaceBudget(o: { now: number; wallMs: number; maxWaitMs: number }): PaceBudget {
  return { deadline: o.now + o.wallMs - PACE_MARGIN_MS, maxWaitMs: Math.max(0, o.maxWaitMs), waitedMs: 0, waits: 0 };
}

export type PacedResult =
  | (Extract<LimitResult, { allowed: true }> & { waitedMs: number })
  | (Extract<LimitResult, { allowed: false }> & { waitedMs: number; pacing?: { reason: 'wall_time' | 'max_wait' | 'cancelled'; roomMs: number } });

/** Abortable sleep (the script's cancel or wall-time signal ends it). */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * `limiter.take(checks)`, and with a budget (inner script calls) a wait for the token while it fits. Without a budget
 * (agent calls) a denial is returned at once, as before.
 */
export async function takePaced(
  limiter: Pick<RateLimiter, 'take'>,
  checks: readonly LimitCheck[],
  o: { budget: PaceBudget | null | undefined; now: () => number; sleep: (ms: number, signal?: AbortSignal) => Promise<void>; signal?: AbortSignal },
): Promise<PacedResult> {
  let waited = 0;
  for (;;) {
    const r = await limiter.take(checks);
    if (r.allowed) return { ...r, waitedMs: waited };
    const b = o.budget;
    if (!b) return { ...r, waitedMs: waited };
    const room = Math.min(b.deadline - o.now(), b.maxWaitMs - waited);
    const reason = b.maxWaitMs - waited <= b.deadline - o.now() ? 'max_wait' : 'wall_time';
    if (o.signal?.aborted) return { ...r, waitedMs: waited, pacing: { reason: 'cancelled', roomMs: Math.max(0, room) } };
    if (!Number.isFinite(r.retryAfterMs) || r.retryAfterMs > room) return { ...r, waitedMs: waited, pacing: { reason, roomMs: Math.max(0, room) } };
    try {
      await o.sleep(r.retryAfterMs, o.signal);
    } catch {
      return { ...r, waitedMs: waited, pacing: { reason: 'cancelled', roomMs: Math.max(0, room) } };
    }
    waited += r.retryAfterMs;
    b.waitedMs += r.retryAfterMs;
    b.waits++;
  }
}
