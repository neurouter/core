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

/** Defaults when an environment does not set limits (§6.2 example values). */
export const DEFAULT_RATE_LIMIT: RateLimitConfig = { perMinute: 600, burst: 120 };
export const DEFAULT_TOOL_RATE_LIMIT: RateLimitConfig = { perMinute: 300, burst: 60 };
export const OPS_RATE_LIMIT: RateLimitConfig = { perMinute: 60, burst: 60 };

/**
 * Per-call checks (§9.6 step 7; COPY Hub limiter): principal bucket and principal×tool bucket,
 * keyed by environment + credential. All must pass; the first failure is reported with a retry-after.
 */
export class RateLimiter {
  constructor(private readonly store: RateLimitStore) {}

  checksFor(p: { environmentId: string; credentialKey: string; tool: string; principalLimit: RateLimitConfig | null; toolLimit: RateLimitConfig | null }): LimitCheck[] {
    return [
      { scope: 'principal', key: `p:${p.environmentId}:${p.credentialKey}`, ...(p.principalLimit ?? DEFAULT_RATE_LIMIT) },
      { scope: 'principal_tool', key: `pt:${p.environmentId}:${p.credentialKey}:${p.tool}`, ...(p.toolLimit ?? DEFAULT_TOOL_RATE_LIMIT) },
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
