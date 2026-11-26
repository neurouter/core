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

/** An equivalent tool a `called` assertion (or reference call) also accepts (`anyOf`). */
export const ToolAlternative = z.object({ tool: z.string().min(1), toolKey: ToolKey });
export type ToolAlternative = z.infer<typeof ToolAlternative>;

/**
 * Ground-truth path (`ref[0].data.name`, `ref[1].data.data[*].id`): a value of the task's reference
 * outcome, computed at run time by executing the reference calls against the attempt's mock seed.
 */
const GroundTruthPath = z.string().regex(/^ref\[\d+\]/, 'a ground-truth path starts with ref[<n>]');
/** How an expected value is compared with the answer (default: inferred from the value and the field). */
export const AnswerKind = z.enum(['text', 'id', 'boolean', 'number', 'money', 'date']);
export type AnswerKind = z.infer<typeof AnswerKind>;

export const Assertion = z.discriminatedUnion('type', [
  /**
   * `args` are the arguments the PROMPT requires (subset match, normalized types; paging arguments
   * are never compared). Values may be `{"$from": "<ground-truth path>"}`. `anyOf` lists equivalent
   * tools that satisfy the assertion as well. `incidental` records generated values that are not checked.
   */
  z.object({
    type: z.literal('called'),
    tool: z.string().min(1),
    toolKey: ToolKey,
    args: ArgsRecord.optional(),
    argsMatch: z.enum(['subset', 'exact']).optional(),
    minTimes: z.number().int().min(1).optional(),
    anyOf: z.array(ToolAlternative).optional(),
    incidental: ArgsRecord.optional(),
  }),
  z.object({ type: z.literal('not_called'), tool: z.string().min(1), toolKey: ToolKey }),
  z.object({ type: z.literal('no_writes') }),
  /**
   * Call budget: upstream API calls (inner script calls included; search_tools, run_script itself,
   * ops and framing calls excluded). Soft by default: an attempt over `n` still passes and is
   * reported as over budget (efficiency); beyond `max(10, 4n)` it fails (runaway). `hard` (and
   * `n: 0`, "do not call the API") fails at `n + 1`.
   */
  z.object({ type: z.literal('max_calls'), n: z.number().int().min(0), hard: z.boolean().optional() }),
  z.object({
    type: z.literal('state'),
    resource: z.string().min(1),
    scope: z.record(z.string(), z.string()).optional(),
    where: ArgsRecord,
    expect: z.union([z.literal('exists'), z.literal('absent'), z.object({ count: z.number().int().min(0) })]),
  }),
  /**
   * The answer states an expected value. `from` names ground-truth paths (preferred; `anyOf` is then
   * only a hint for reports and offline use); `match: all` needs every resolved value (lists),
   * `any` one of them. Comparison is normalized (case, punctuation, booleans, numbers, minor units,
   * dates, ids); when it fails, the judge may rule the answer equivalent (`matched_by: judge`).
   */
  z.object({
    type: z.literal('answer_contains'),
    anyOf: z.array(z.string().min(1)).min(1).optional(),
    from: z.union([GroundTruthPath, z.array(GroundTruthPath).min(1)]).optional(),
    match: z.enum(['any', 'all']).optional(),
    kind: AnswerKind.optional(),
    caseInsensitive: z.boolean().optional(),
    /** false: literal substring match only (no normalization, no judge fallback). */
    normalize: z.boolean().optional(),
  }),
  z.object({ type: z.literal('answer_matches'), regex: z.string().min(1) }),
  /** `neurouter_report_unmet_need` called, or the final answer declines and no write happened. */
  z.object({ type: z.literal('unmet_need_reported_or_declined') }),
  /** begin_task before the first API call and end_task at the end (contract 1 only; n/a on contract 2). */
  z.object({ type: z.literal('framing') }),
  /**
   * LLM judge. `groundTruth`: the judge also gets the task's ground-truth values. `kind: choice`
   * (ambiguous "use your judgment" tasks): passes when the agent stated its choice and its results
   * are consistent with that choice, whatever the choice.
   */
  z.object({ type: z.literal('judge'), criterion: z.string().min(1), groundTruth: z.boolean().optional(), kind: z.enum(['rubric', 'choice']).optional() }),
]);
export type Assertion = z.infer<typeof Assertion>;
export type AssertionType = Assertion['type'];
export const ASSERTION_TYPES = ['called', 'not_called', 'no_writes', 'max_calls', 'state', 'answer_contains', 'answer_matches', 'unmet_need_reported_or_declined', 'framing', 'judge'] as const satisfies readonly AssertionType[];

/**
 * A reference call of a task (`reference_calls`). `arguments` values may be `{"$from": "ref[0]…"}`
 * (an earlier reference's result). `required`: the argument names the prompt requires (the rest are
 * incidental); `alternatives`: equivalent tools.
 */
export const ReferenceCall = z.object({ tool: z.string().min(1), toolKey: ToolKey, arguments: ArgsRecord, required: z.array(z.string()).optional(), alternatives: z.array(ToolAlternative).optional() });
export type ReferenceCall = z.infer<typeof ReferenceCall>;

/** Score weights (A35). `correctness` only counts when the correctness suite ran (weights renormalize). */
export const READINESS_WEIGHTS = { success: 0.45, quality: 0.2, impossible: 0.1, efficiency: 0.1, stability: 0.1, framing: 0.05, correctness: 0.1 } as const;
/** A judge verdict passes at score ≥ 0.7. */
export const JUDGE_PASS_SCORE = 0.7;
