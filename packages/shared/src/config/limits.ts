import * as z from 'zod';

/**
 * Per-environment limits (backend §6.2, §10.5) and their defaults. Shared so the server, the
 * neurouter.yaml validator and the console's LimitsForm agree.
 */
export const RateLimit = z.object({ perMinute: z.number().int().min(1).max(1_000_000), burst: z.number().int().min(1).max(1_000_000) });
export type RateLimit = z.infer<typeof RateLimit>;

export const CodeLimits = z.object({
  maxToolCalls: z.number().int().min(1).max(10_000),
  wallTimeSec: z.number().min(1).max(600),
  cpuTimeSec: z.number().min(0.1).max(600),
  maxMemoryMb: z.number().int().min(8).max(4096),
  maxConcurrentCalls: z.number().int().min(1).max(64),
  maxResultBytes: z.number().int().min(1024).max(64 * 1024 * 1024),
});
export type CodeLimits = z.infer<typeof CodeLimits>;

export const Limits = z.object({
  rateLimit: RateLimit,
  toolRateLimit: RateLimit,
  timeoutMs: z.number().int().min(100).max(300_000),
  maxResponseBytes: z.number().int().min(1024).max(64 * 1024 * 1024),
  code: CodeLimits,
});
export type Limits = z.infer<typeof Limits>;

/** Partial limits as written in neurouter.yaml / sent by the console; merged over the defaults. */
export const LimitsInput = z.object({
  rateLimit: RateLimit.optional(),
  toolRateLimit: RateLimit.optional(),
  timeoutMs: Limits.shape.timeoutMs.optional(),
  maxResponseBytes: Limits.shape.maxResponseBytes.optional(),
  code: CodeLimits.partial().optional(),
});
export type LimitsInput = z.infer<typeof LimitsInput>;

/** Code-mode defaults (§10.5): 200 calls, 30 s wall, 10 s CPU, 64 MiB, 8 concurrent calls, 1 MiB result. */
export const DEFAULT_CODE_LIMITS: CodeLimits = { maxToolCalls: 200, wallTimeSec: 30, cpuTimeSec: 10, maxMemoryMb: 64, maxConcurrentCalls: 8, maxResultBytes: 1_048_576 };

/** Environment defaults. Rate limits are per principal (and per principal × tool). */
export const DEFAULT_LIMITS: Limits = {
  rateLimit: { perMinute: 300, burst: 60 },
  toolRateLimit: { perMinute: 120, burst: 30 },
  timeoutMs: 15_000,
  maxResponseBytes: 2_097_152,
  code: DEFAULT_CODE_LIMITS,
};

/** Fixed code-mode limits that are not configurable per environment (§10.5). */
export const CODE_FIXED_LIMITS = { maxSourceBytes: 16_384, maxLines: 400, maxNesting: 12, maxRecursionDepth: 200, maxPrintBytes: 16_384, maxConcurrentRunsPerPrincipal: 2 } as const;

/** Ops tools rate limit (per credential, separate bucket; §11.1). */
export const OPS_RATE_LIMIT: RateLimit = { perMinute: 60, burst: 60 };

export function mergeLimits(input: LimitsInput | null | undefined, base: Limits = DEFAULT_LIMITS): Limits {
  return {
    rateLimit: input?.rateLimit ?? base.rateLimit,
    toolRateLimit: input?.toolRateLimit ?? base.toolRateLimit,
    timeoutMs: input?.timeoutMs ?? base.timeoutMs,
    maxResponseBytes: input?.maxResponseBytes ?? base.maxResponseBytes,
    code: { ...base.code, ...(input?.code ?? {}) },
  };
}
