import type { Assertion, EvalCategory, EvalConfidence, FailureCause, ReadinessBand, ReadinessComponentKey, ReferenceCall } from '@neurouter/shared';

export type { Assertion, ReferenceCall };
export type EvalMode = 'tool' | 'code';

/** A suite task (backend §15.1–15.3; `eval_tasks` row minus ids). */
export interface EvalTask {
  key: string;
  category: EvalCategory;
  prompt: string;
  rubric: string;
  assertions: Assertion[];
  referenceCalls: ReferenceCall[];
  seedState?: Record<string, unknown> | null;
  tags: string[];
  enabled: boolean;
}

/** Calibration of one task: its own reference solution run through its assertions in the mock. */
export interface TaskCalibration {
  key: string;
  /** `passed`: the reference passes; `rejected`: it does not (task not run); `flagged`: a model run disagrees (human review). */
  status: 'passed' | 'rejected' | 'flagged';
  reasons: string[];
  /** Ground-truth preview (truncated JSON of the reference outcomes). */
  groundTruth?: string;
}

/** Calibration gate result, stored with the suite (§ calibration). */
export interface SuiteCalibration {
  at: string;
  mockDataVersion: number;
  passed: number;
  rejected: number;
  flagged: number;
  /** `--calibrate-with <model>`: the model that ran one tool-mode pass. */
  model?: string | null;
  tasks: TaskCalibration[];
}

/**
 * Portable suite file for git and CI (§15.2 step 5). Version 2 (0.2.2): outcome-based assertions
 * (`answer_contains.from`, required-only `called.args`, derived soft budgets), a mock data version
 * and the calibration result. Version 1 files (0.2.1) load as mock data version 1; `migrateSuite`
 * converts them.
 */
export interface SuiteFile {
  version: 1 | 2;
  server: string;
  generatedFrom: { buildHash?: string | null; model?: string | null; promptVersion?: string | null; seed?: number | null } | null;
  /** Mock data version the suite's prompts and ground truth refer to (1 = 0.2.1 data; default 1 for version-1 files, else 2). */
  mockDataVersion?: number;
  calibration?: SuiteCalibration | null;
  /** Tasks per tag/resource cluster (generation). */
  coverage?: Record<string, number>;
  /** `migrateSuite`: what changed, per task key. */
  migration?: { from: string; at: string; notes: Record<string, string[]> } | null;
  tasks: EvalTask[];
}

/**
 * One call observed in the Neurouter audit log for the attempt's task (`via: 'eval'` or `script`
 * for calls inside run_script). The server supplies these; the checker reads only these, so tool
 * mode and code mode are checked the same way.
 */
export interface ObservedCall {
  tool: string;
  arguments: Record<string, unknown>;
  /** Audit status (`ok`, `tool_error`, `invalid_args`, `blocked`, …). */
  status: string;
  /** Audit decision (`allowed`, `dry_run`, `denied_read_only`, …). */
  decision: string;
  via: string;
  write: boolean;
  scriptRunId?: string | null;
  ts?: number;
}

/** A tools/call the agent itself sent over MCP. */
export interface AgentCall {
  name: string;
  arguments: Record<string, unknown>;
  isError: boolean;
  latencyMs: number;
}

export type EndReason = 'end_turn' | 'max_turns' | 'max_tool_calls' | 'over_budget' | 'timeout' | 'refusal' | 'max_tokens' | 'error' | 'cancelled';

export type TranscriptItem =
  | { kind: 'user'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool_call'; id: string; name: string; arguments: unknown }
  | { kind: 'tool_result'; id: string; name: string; isError: boolean; text: string }
  | { kind: 'error'; text: string };

/** Output of the agent loop (`runAttempt`). */
export interface AttemptRun {
  finalAnswer: string;
  agentCalls: AgentCall[];
  /** The agent's MCP tool calls: run_script counts 1, ops (`neurouter_*`) tools excluded. Efficiency and `max_calls` also exclude search_tools (see `workCalls`). */
  toolCallsByAgent: number;
  scripts: number;
  turns: number;
  /** Input tokens not read from a provider cache (Anthropic cache writes included). */
  inputTokens: number;
  /** Output tokens (reasoning/thinking included). */
  outputTokens: number;
  /** Input tokens read from a provider cache (OpenAI cached_tokens, Anthropic cache_read_input_tokens, Gemini total_cached_tokens). */
  cacheReadTokens: number;
  /** Anthropic cache_creation_input_tokens (already part of inputTokens; reported for cost). */
  cacheWriteTokens: number;
  latencyMs: number;
  servedByModel: string | null;
  fallbackUsed: boolean;
  stopReason: string | null;
  endReason: EndReason;
  error: string | null;
  transcript: TranscriptItem[];
  /** `_meta["dev.neurouter/task-id"]` seen on tool results (the Neurouter task the attempt ran in). */
  neurouterTaskId: string | null;
  /** Whether the server offered begin/end task framing (`neurouter_begin_task` listed; false on contract 2). Absent on records before 0.2.2 (= true). */
  framingAvailable?: boolean;
  /** JSON size of the tools/list the agent got (sent with every turn). */
  toolsListBytes?: number;
}

/** AttemptRun + the audit-log view of the calls: what the checker consumes. */
export interface AttemptRecord extends AttemptRun {
  calls: ObservedCall[];
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
  /** answer_contains: how the expected value was found (`judge`: the equivalence judge ruled it stated). */
  matchedBy?: 'literal' | 'normalized' | 'judge';
  /** max_calls: over the soft budget (efficiency) without failing. */
  overBudget?: boolean;
  /** answer_contains: the expected values came from the ground truth (not a literal hint). */
  groundTruth?: boolean;
  /** called / not_called / max_calls: failed as written, passed by an equivalence rule (B9 path, ambiguous waiver). */
  waived?: string;
}

/** LLM usage of judge calls (rubric judge + answer-equivalence judge). */
export interface JudgeUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

export interface JudgeResult {
  score: number;
  verdict: 'pass' | 'fail';
  reasons: string[];
  /** Ambiguous tasks: how the agent handled the ambiguity (a clarifying question, an explicit assumption, neither). */
  path?: 'asked' | 'assumed' | 'neither';
}

/** Every judge call behind a verdict (borderline verdicts are voted: up to 3 calls, majority). */
export interface JudgeVotes {
  rubric?: JudgeResult[];
  /** answer-equivalence judge: one map (assertion index → ruling) per call */
  equivalence?: Array<Record<number, { equivalent: boolean; reason: string }>>;
}

export interface CheckResult {
  passed: boolean;
  results: AssertionResult[];
  judgeVotes?: JudgeVotes;
  /** null when the task has no `framing` assertion. */
  framingPassed: boolean | null;
  judge: JudgeResult | null;
  failureCause: FailureCause | null;
  /** Upstream API calls (see budget.ts) and the task's budget (null without a max_calls assertion). */
  upstreamCalls: number;
  callBudget: number | null;
  overBudget: boolean;
}

/** One `(task, model, mode, attempt)` result (`eval_task_runs` row). */
export interface TaskRunResult {
  key: string;
  taskKey: string;
  category: EvalCategory;
  model: string;
  mode: EvalMode;
  attempt: number;
  passed: boolean;
  framingPassed: boolean | null;
  assertionResults: AssertionResult[];
  judge: JudgeResult | null;
  failureCause: FailureCause | null;
  /** Expected tool of the failed assertion, or the wrongly called tool (suggestion clustering). */
  primaryTool: string | null;
  /** Calls counted for efficiency: the agent's non-ops calls minus search_tools (same rule as max_calls, see `workCalls`). */
  toolCalls: number;
  scripts: number;
  /** Uncached input (see AttemptRun.inputTokens). */
  inputTokens: number;
  outputTokens: number;
  /** Cached input read (0 on results stored before 0.2.1). */
  cacheReadTokens: number;
  /** Cache writes, part of inputTokens (Anthropic). */
  cacheWriteTokens: number;
  latencyMs: number;
  servedByModel: string | null;
  fallbackUsed: boolean;
  neurouterTaskId: string | null;
  referenceCallCount: number;
  endReason: EndReason;
  error: string | null;
  transcript: TranscriptItem[];
  calls: ObservedCall[];
  /** Upstream API calls (0.2.2; older results: absent). */
  upstreamCalls?: number;
  callBudget?: number | null;
  /** Passed (or failed) while over the soft call budget. */
  overBudget?: boolean;
  /** Judge LLM usage for this attempt. */
  judgeUsage?: JudgeUsage | null;
  /** All judge calls behind the verdicts (voting on borderline ones). */
  judgeVotes?: JudgeVotes | null;
  toolsListBytes?: number;
}

export interface ReadinessComponent {
  key: ReadinessComponentKey;
  label: string;
  weight: number;
  /** 0..1 */
  score: number;
  detail: string;
  fixCount: number;
}

export interface CellScore {
  model: string;
  mode: EvalMode;
  score: number;
  components: ReadinessComponent[];
  successRate: number;
  /** success per category (0..1), categories without tasks omitted. */
  categorySuccess: Partial<Record<EvalCategory, number>>;
  /** Mean tokens per attempt: `attemptTokens` = uncached input + cached input + output (see score.ts). */
  avgTokens: number;
  /** Mean cached input tokens per attempt (part of avgTokens). */
  avgCachedTokens: number;
  avgCalls: number;
  avgLatencyMs: number;
  /** "Tokens per multi-step task": mean `attemptTokens` over the multi-step attempts (recommendation text, reports). */
  avgTokensMulti: number | null;
  flakyTasks: number;
  attempts: number;
  excludedFallback: number;
  /** Attempts the model provider refused (policy filter): excluded from scoring. */
  excludedRefusals?: number;
  /** Counted attempts over their soft call budget. */
  overBudget?: number;
  /** Mean tools/list size the agent got (bytes; resent with every turn). */
  avgToolsListBytes?: number | null;
  best: boolean;
}

export interface ReadinessScore {
  headline: number;
  band: ReadinessBand;
  recommendedMode: EvalMode | null;
  recommendationText: string;
  confidence: EvalConfidence;
  modeScores: Partial<Record<EvalMode, number>>;
  cells: CellScore[];
  /** Components of the headline cell. */
  breakdown: ReadinessComponent[];
  /** The run stopped early (`--max-run-tokens`): scores cover only the attempts that ran. */
  incomplete?: { reason: string; attemptsRun: number; attemptsPlanned: number } | null;
}

/* ------------------------------------------------------------------ generator I/O */

/** A visible API tool as given to the generator (and to the stub agent through tools/list). */
export interface GenTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  write: boolean;
  /** `ns.fn` (code mode). */
  pyName?: string;
  /** Known-good arguments (spec/overlay examples or derived from mock samples). */
  exampleArguments?: Record<string, unknown> | null;
  /** Stable tool identity (`ToolDef.key`), stamped on generated assertions so renames don't break the suite. */
  key?: string;
  /** Group for sampling large APIs (first tag). */
  group?: string;
  /** Pinned in the overlay (topic weighting). */
  pinned?: boolean;
  /** HTTP path template (links the tool to mock sample resources). */
  path?: string;
  /** HTTP method (equivalent-tool detection). */
  method?: string;
}

export interface GeneratorCategoryInput {
  category: EvalTask['category'];
  count: number;
  server: { name: string; slug: string; description?: string | null };
  /** Tools with full schemas (all of them for small APIs; a budgeted, relevant subset for large ones). */
  tools: GenTool[];
  /** The other visible tools, names only (large APIs): they exist, but the tasks should use `tools`. */
  otherTools?: Array<{ name: string; title?: string; write?: boolean }>;
  /** Mock resources → up to 3 sample entities each (seeded, so prompts can reference existing ids). */
  samples: Record<string, Array<Record<string, unknown>>>;
  instructions?: string | null;
  seed: number;
  /** Validation errors of the previous attempt (regeneration round). */
  previousErrors?: string[];
  /** One topic (tag/resource cluster) per task to write, sampled by importance (topic balance). */
  topics?: string[];
  /** Prompts already accepted (avoid near-duplicates). */
  existingPrompts?: string[];
}

/** Wire format of one generated task (`GeneratedTasks.tasks[]`, snake_case as in §15.2). */
export interface GeneratedTask {
  key: string;
  category: EvalTask['category'];
  prompt: string;
  rubric: string;
  assertions: Assertion[];
  reference_calls: Array<ReferenceCall & { required_args?: string[]; alternatives?: Array<string | { tool: string }> }>;
  seed_state?: Record<string, unknown> | null;
  tags?: string[];
  topic?: string;
}
