import * as z from 'zod';

/**
 * Eval assertion DSL (backend §15.3), checked deterministically by `packages/evals/src/check.ts`
 * (`judge` assertions are scored by the LLM judge). Shared by the console (task editor) and evals.
 */
const ArgsRecord = z.record(z.string(), z.unknown());
/**
 * Stable identity of the tool a `called`/`not_called` assertion or reference call is about: the
 * compiler's `ToolDef.key` (`operationId:<id>`, `"<METHOD> <path>"`, `graphql:<Root>.<field>`). Before a
 * run it is resolved to the build's current tool name, so overlays that rename tools keep frozen
 * suites working; `tool` (the display name at generation time) is the fallback.
 */
const ToolKey = z.string().min(1).optional();

export const Assertion = z.discriminatedUnion('type', [
  z.object({ type: z.literal('called'), tool: z.string().min(1), toolKey: ToolKey, args: ArgsRecord.optional(), argsMatch: z.enum(['subset', 'exact']).optional(), minTimes: z.number().int().min(1).optional() }),
  z.object({ type: z.literal('not_called'), tool: z.string().min(1), toolKey: ToolKey }),
  z.object({ type: z.literal('no_writes') }),
  /** MCP tool calls by the agent (a `run_script` counts 1). */
  z.object({ type: z.literal('max_calls'), n: z.number().int().min(0) }),
  z.object({
    type: z.literal('state'),
    resource: z.string().min(1),
    scope: z.record(z.string(), z.string()).optional(),
    where: ArgsRecord,
    expect: z.union([z.literal('exists'), z.literal('absent'), z.object({ count: z.number().int().min(0) })]),
  }),
  z.object({ type: z.literal('answer_contains'), anyOf: z.array(z.string().min(1)).min(1), caseInsensitive: z.boolean().optional() }),
  z.object({ type: z.literal('answer_matches'), regex: z.string().min(1) }),
  /** `neurouter_report_unmet_need` called, or the final answer declines and no write happened. */
  z.object({ type: z.literal('unmet_need_reported_or_declined') }),
  /** begin_task before the first API call and end_task at the end (scored as F, not pass/fail). */
  z.object({ type: z.literal('framing') }),
  z.object({ type: z.literal('judge'), criterion: z.string().min(1) }),
]);
export type Assertion = z.infer<typeof Assertion>;
export type AssertionType = Assertion['type'];
export const ASSERTION_TYPES = ['called', 'not_called', 'no_writes', 'max_calls', 'state', 'answer_contains', 'answer_matches', 'unmet_need_reported_or_declined', 'framing', 'judge'] as const satisfies readonly AssertionType[];

/** A reference call of a generated task (`reference_calls`). */
export const ReferenceCall = z.object({ tool: z.string().min(1), toolKey: ToolKey, arguments: ArgsRecord });
export type ReferenceCall = z.infer<typeof ReferenceCall>;

/** Score weights (A35). `correctness` only counts when the correctness suite ran (weights renormalize). */
export const READINESS_WEIGHTS = { success: 0.45, quality: 0.2, impossible: 0.1, efficiency: 0.1, stability: 0.1, framing: 0.05, correctness: 0.1 } as const;
/** A judge verdict passes at score ≥ 0.7. */
export const JUDGE_PASS_SCORE = 0.7;
