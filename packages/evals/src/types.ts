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

/** Portable suite file for git and CI (§15.2 step 5). */
export interface SuiteFile {
  version: 1;
  server: string;
  generatedFrom: { buildHash?: string | null; model?: string | null; promptVersion?: string | null; seed?: number | null } | null;
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
  /** MCP tool calls counted for efficiency/max_calls: run_script counts 1, ops (`neurouter_*`) tools excluded. */
  toolCallsByAgent: number;
  scripts: number;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  latencyMs: number;
  servedByModel: string | null;
  fallbackUsed: boolean;
  stopReason: string | null;
  endReason: EndReason;
  error: string | null;
  transcript: TranscriptItem[];
  /** `_meta["dev.neurouter/task-id"]` seen on tool results (the Neurouter task the attempt ran in). */
  neurouterTaskId: string | null;
}

/** AttemptRun + the audit-log view of the calls: what the checker consumes. */
export interface AttemptRecord extends AttemptRun {
  calls: ObservedCall[];
}

export interface AssertionResult {
  assertion: Assertion;
  passed: boolean;
  detail: string;
}

export interface JudgeResult {
  score: number;
  verdict: 'pass' | 'fail';
  reasons: string[];
}

export interface CheckResult {
  passed: boolean;
  results: AssertionResult[];
  /** null when the task has no `framing` assertion. */
  framingPassed: boolean | null;
  judge: JudgeResult | null;
  failureCause: FailureCause | null;
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
  toolCalls: number;
  scripts: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
  servedByModel: string | null;
  fallbackUsed: boolean;
  neurouterTaskId: string | null;
  referenceCallCount: number;
  endReason: EndReason;
  error: string | null;
  transcript: TranscriptItem[];
  calls: ObservedCall[];
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
  avgTokens: number;
  avgCalls: number;
  avgLatencyMs: number;
  /** avg tokens on multi tasks (for the recommendation text). */
  avgTokensMulti: number | null;
  flakyTasks: number;
  attempts: number;
  excludedFallback: number;
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
}

export interface GeneratorCategoryInput {
  category: EvalTask['category'];
  count: number;
  server: { name: string; slug: string; description?: string | null };
  tools: GenTool[];
  /** Mock resources → up to 3 sample entities each (seeded, so prompts can reference existing ids). */
  samples: Record<string, Array<Record<string, unknown>>>;
  instructions?: string | null;
  seed: number;
  /** Validation errors of the previous attempt (regeneration round). */
  previousErrors?: string[];
}

/** Wire format of one generated task (`GeneratedTasks.tasks[]`, snake_case as in §15.2). */
export interface GeneratedTask {
  key: string;
  category: EvalTask['category'];
  prompt: string;
  rubric: string;
  assertions: Assertion[];
  reference_calls: ReferenceCall[];
  seed_state?: Record<string, unknown> | null;
  tags?: string[];
}
