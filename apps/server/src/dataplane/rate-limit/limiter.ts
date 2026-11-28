import { DEFAULT_LIMITS, OPS_RATE_LIMIT } from '@neurouter/shared';
import type { RateLimitStore } from '../../kernel/coordination/types.js';
import { perMinute } from './token-bucket.js';

/** `principal` (limits.rateLimit), `principal_tool` (limits.toolRateLimit), `ops` (60/min per credential). */
export type LimitScope = 'principal' | 'principal_tool' | 'ops';

export interface LimitCheck {
  scope: LimitScope;
  key: string;
  perMinute: number;
  burst: number;
}

export interface RateLimitConfig {
  perMinute: number;
  burst: number;
}

/** `left`: the tightest bucket after this call (calls left before the limit, its capacity), when the store reports it. */
export type LimitResult = { allowed: true; left?: { calls: number; capacity: number } } | { allowed: false; scope: LimitScope; retryAfterMs: number };

/**
 * Defaults when an environment does not set limits: the shared `DEFAULT_LIMITS` (one source of truth with the
 * console and neurouter.yaml docs, 0.3.5). Ops tools use the shared `OPS_RATE_LIMIT`.
 */

/**
 * Per-call checks (§9.6 step 7; COPY Hub limiter): principal bucket and principal×tool bucket,
 * keyed by environment + credential. All must pass; the first failure is reported with a retry-after.
 */
export class RateLimiter {
  constructor(private readonly store: RateLimitStore) {}

  checksFor(p: { environmentId: string; credentialKey: string; tool: string; principalLimit: RateLimitConfig | null; toolLimit: RateLimitConfig | null }): LimitCheck[] {
    return [
      { scope: 'principal', key: `p:${p.environmentId}:${p.credentialKey}`, ...(p.principalLimit ?? DEFAULT_LIMITS.rateLimit) },
      { scope: 'principal_tool', key: `pt:${p.environmentId}:${p.credentialKey}:${p.tool}`, ...(p.toolLimit ?? DEFAULT_LIMITS.toolRateLimit) },
    ];
  }

  opsCheck(credentialKey: string): LimitCheck {
    return { scope: 'ops', key: `ops:${credentialKey}`, ...OPS_RATE_LIMIT };
  }

  async take(checks: readonly LimitCheck[]): Promise<LimitResult> {
    let left: { calls: number; capacity: number } | undefined;
    for (const c of checks) {
      const cfg = perMinute(c.perMinute, c.burst);
      const r = await this.store.take(c.key, { capacity: cfg.capacity, refillPerMs: cfg.refillPerMs });
      if (!r.allowed) return { allowed: false, scope: c.scope, retryAfterMs: r.retryAfterMs };
      if (r.remaining !== undefined && (!left || r.remaining / cfg.capacity < left.calls / left.capacity)) left = { calls: Math.max(0, r.remaining), capacity: cfg.capacity };
    }
    return left ? { allowed: true, left } : { allowed: true };
  }
}
