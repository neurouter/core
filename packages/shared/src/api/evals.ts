import * as z from 'zod';
import { Assertion, ReferenceCall } from '../domain/assertions.js';
import {
  CallMode, EvalCategory, EvalConfidence, EvalRunStatus, EvalSuiteStatus, EvalTrigger, FailureCause, SuggestionKind, SuggestionStatus,
} from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Items, JobAccepted, Page, QueryBool, SlugRef, queryArray, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';
import { OverlayDraft, OverlayPublishResult } from './overlays.js';
import { ReadinessComponent, ReadinessScore, ReadinessSummary } from './readiness.js';

/* ------------------------------------------------------------------ suites (§14.11, §15.1) */

export const CategoryCounts = z.object({ single: z.number().int().min(0).max(50), multi: z.number().int().min(0).max(50), ambiguous: z.number().int().min(0).max(50), impossible: z.number().int().min(0).max(50) });
export type CategoryCounts = z.infer<typeof CategoryCounts>;
/** Generator defaults (8/8/4/4) and the quick preset (4/4/2/2). */
export const DEFAULT_SUITE_COUNTS: CategoryCounts = { single: 8, multi: 8, ambiguous: 4, impossible: 4 };
export const QUICK_SUITE_COUNTS: CategoryCounts = { single: 4, multi: 4, ambiguous: 2, impossible: 2 };

export const EvalSuiteRow = z.object({
  id: Id,
  serverId: Id,
  version: z.number().int().min(1),
  status: EvalSuiteStatus,
  taskCount: z.number().int(),
  byCategory: CategoryCounts,
  generatedFromBuild: z.object({ id: Id, hash: z.string() }).nullable(),
  generator: z
    .object({
      model: z.string(),
      promptVersion: z.string(),
      seed: z.number().int().nullable(),
      /** Generator LLM usage (0.2.1+): calls and tokens (input = uncached, cached read, output) against the budget. */
      usage: z.object({ calls: z.number().int(), inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int(), totalTokens: z.number().int(), budgetTokens: z.number().int() }).optional(),
      /** Why generated tasks were rejected or categories came out short (0.2.1+). */
      diagnostics: z.array(z.object({ category: EvalCategory, key: z.string().nullable(), message: z.string() })).optional(),
    })
    .nullable(),
  createdAt: IsoDateTime,
  frozenAt: IsoDateTime.nullable(),
});
export type EvalSuiteRow = z.infer<typeof EvalSuiteRow>;

/**
 * Per-attempt limit overrides (0.3.3) for a suite or a task: the task's override wins over the suite's, the suite's over
 * the run defaults (25 turns, 60 agent tool calls, 200,000 tokens incl. cached input, 5 minutes of wall time).
 */
export const EvalLimits = z
  .object({
    maxTurns: z.number().int().min(1).max(500),
    maxToolCalls: z.number().int().min(1).max(5000),
    /** Uncached input + cached input + output tokens of the attempt. */
    maxTotalTokens: z.number().int().min(1000).max(50_000_000),
    wallMs: z.number().int().min(1000).max(3_600_000),
  })
  .partial()
  .strict();
export type EvalLimits = z.infer<typeof EvalLimits>;

export const EvalTaskRow = z.object({
  id: Id,
  key: z.string(),
  category: EvalCategory,
  prompt: z.string(),
  rubric: z.string(),
  assertions: z.array(Assertion),
  referenceCalls: z.array(ReferenceCall),
  seedState: z.record(z.string(), z.unknown()).nullable(),
  /** Per-attempt limit overrides of this task (0.3.3). */
  limits: EvalLimits.nullable().optional(),
  tags: z.array(z.string()),
  enabled: z.boolean(),
  source: z.enum(['generated', 'manual']),
});
export type EvalTaskRow = z.infer<typeof EvalTaskRow>;

export const EvalSuiteDetail = EvalSuiteRow.extend({ tasks: z.array(EvalTaskRow), diagnostics: z.array(z.string()) });
export type EvalSuiteDetail = z.infer<typeof EvalSuiteDetail>;

export const SuiteGenerate = z.object({
  counts: CategoryCounts.optional(),
  model: z.string().min(1).optional(),
  seed: z.number().int().optional(),
  instructions: z.string().max(2000).optional(),
  /** Token budget for the whole generation (default 400,000). */
  maxGeneratorTokens: z.number().int().min(4000).max(10_000_000).optional(),
});
export type SuiteGenerate = z.infer<typeof SuiteGenerate>;

export const EvalTaskCreate = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/),
  category: EvalCategory,
  prompt: z.string().min(1).max(4000),
  rubric: z.string().max(4000).default(''),
  assertions: z.array(Assertion).default([]),
  referenceCalls: z.array(ReferenceCall).default([]),
  seedState: z.record(z.string(), z.unknown()).optional(),
  /** Per-attempt limit overrides of this task (0.3.3). */
  limits: EvalLimits.optional(),
  tags: z.array(z.string()).default([]),
});
export type EvalTaskCreate = z.infer<typeof EvalTaskCreate>;

export const EvalTaskPatch = z.object({ prompt: z.string().min(1).max(4000).optional(), rubric: z.string().max(4000).optional(), assertions: z.array(Assertion).optional(), referenceCalls: z.array(ReferenceCall).optional(), enabled: z.boolean().optional() });
export type EvalTaskPatch = z.infer<typeof EvalTaskPatch>;

/** Suite export/import format for git and CI (§15.2). */
export const SuiteFile = z.object({
  /** 2 (0.2.2): outcome-based assertions, mock data version, calibration; 1: 0.2.1 files (mock data version 1). */
  version: z.union([z.literal(1), z.literal(2)]),
  server: z.string(),
  generatedFrom: z.object({ buildHash: z.string().nullable(), model: z.string().nullable(), promptVersion: z.string().nullable() }).partial().nullable().optional(),
  mockDataVersion: z.number().int().min(1).max(2).optional(),
  calibration: z.unknown().optional(),
  coverage: z.record(z.string(), z.number()).optional(),
  migration: z.unknown().optional(),
  /** Per-attempt limit overrides for every task of the suite (0.3.3); a task's own `limits` win. */
  limits: EvalLimits.optional(),
  tasks: z.array(EvalTaskCreate.extend({ enabled: z.boolean().default(true) })),
});
export type SuiteFile = z.infer<typeof SuiteFile>;

/* ------------------------------------------------------------------ runs */

/**
 * Tokens: `inputTokens` = input not read from a provider cache (Anthropic cache writes included),
 * `cacheReadTokens` = input read from the cache, `cacheWriteTokens` = Anthropic cache writes (part of
 * inputTokens). Total tokens of an attempt = inputTokens + cacheReadTokens + outputTokens.
 */
export const TokenUsage = z.object({ inputTokens: z.number().int(), outputTokens: z.number().int(), cacheReadTokens: z.number().int().optional(), cacheWriteTokens: z.number().int().optional() });
export type TokenUsage = z.infer<typeof TokenUsage>;

export const EvalRunRow = z.object({
  id: Id,
  server: SlugRef,
  suite: z.object({ id: Id, version: z.number().int() }),
  environment: SlugRef,
  build: z.object({ id: Id, hash: z.string() }),
  overlayRev: z.number().int().nullable(),
  /** Temporary build from the draft or a suggestion patch. */
  temporaryBuild: z.boolean(),
  models: z.array(z.string()),
  modes: z.array(CallMode),
  repeats: z.number().int(),
  status: EvalRunStatus,
  progress: z.object({ done: z.number().int(), total: z.number().int() }),
  headline: z.number().int().min(0).max(100).nullable(),
  recommendedMode: CallMode.nullable(),
  confidence: EvalConfidence.nullable(),
  trigger: EvalTrigger,
  baseRunId: Id.nullable(),
  error: z.string().nullable(),
  createdAt: IsoDateTime,
  startedAt: IsoDateTime.nullable(),
  endedAt: IsoDateTime.nullable(),
  /** Tokens per model. */
  usage: z.record(z.string(), TokenUsage),
});
export type EvalRunRow = z.infer<typeof EvalRunRow>;

export const MatrixCell = z.object({
  model: z.string(),
  mode: CallMode,
  successRate: z.number().min(0).max(1),
  score: z.number().int().min(0).max(100),
  /** Mean tokens per attempt: uncached input + cached input + output. */
  avgTokens: z.number(),
  /** Mean cached input tokens per attempt (part of avgTokens). */
  avgCachedTokens: z.number().optional(),
  /** Mean tokens per multi-step attempt (null without multi-step tasks). */
  avgTokensMulti: z.number().nullable().optional(),
  avgCalls: z.number(),
  avgLatencyMs: z.number(),
  flakyTasks: z.number().int(),
  /** Attempts excluded because a server-side fallback served them. */
  excludedAttempts: z.number().int(),
  best: z.boolean(),
});
export type MatrixCell = z.infer<typeof MatrixCell>;

export const TaskResultCell = z.object({
  model: z.string(),
  mode: CallMode,
  passes: z.number().int(),
  attempts: z.number().int(),
  flaky: z.boolean(),
  failureCause: FailureCause.nullable(),
  avgTokens: z.number(),
  avgCalls: z.number(),
  /** Task runs of this cell (for the transcript link). */
  taskRunIds: z.array(Id),
  /**
   * Each attempt with its trace: the Neurouter task the attempt's calls were recorded under.
   * `recorded` links to it; `none` when the agent made no tool call (no task); `expired` when the
   * task was removed by retention.
   */
  runs: z.array(z.object({ id: Id, attempt: z.number().int(), passed: z.boolean(), taskId: Id.nullable(), trace: z.enum(['recorded', 'none', 'expired']) })),
});
export const TaskResultRow = z.object({ taskId: Id, key: z.string(), category: EvalCategory, prompt: z.string(), cells: z.array(TaskResultCell) });
export type TaskResultRow = z.infer<typeof TaskResultRow>;

export const EvalRunDetail = EvalRunRow.extend({
  score: ReadinessScore.nullable(),
  matrix: z.array(MatrixCell),
  tasks: z.array(TaskResultRow),
  suggestionsCount: z.number().int(),
  /** Correctness suite results when it ran (§15.1). */
  correctness: z.object({ passed: z.number().int(), total: z.number().int() }).nullable(),
});
export type EvalRunDetail = z.infer<typeof EvalRunDetail>;

export const EvalRunCreate = z.object({
  serverId: Id,
  suiteId: Id.optional(),
  /** Default: the server's mock (or a dev) environment. Prod refused (422). */
  environmentId: Id.optional(),
  models: z.array(z.string().min(1)).min(1).max(4).optional(),
  modes: z.array(CallMode).min(1).optional(),
  repeats: z.number().int().min(1).max(5).optional(),
  buildId: Id.optional(),
  /** `quick` = generate or reuse a 12-task suite (4/4/2/2), primary model, tool + code, repeats 1, mock env. */
  preset: z.literal('quick').optional(),
  /** `all`, `failed_in:<runId>` or a list of task keys. */
  taskSet: z.union([z.literal('all'), z.string().regex(/^failed_in:.+$/), z.array(z.string()).min(1)]).optional(),
  overlay: z.union([z.object({ revisionId: Id }), z.object({ draft: z.literal(true) })]).optional(),
});
export type EvalRunCreate = z.infer<typeof EvalRunCreate>;

export const EvalRunListQuery = CursorQuery.extend({ serverId: queryOptional(Id), status: queryArray(EvalRunStatus), trigger: queryOptional(EvalTrigger) });
export type EvalRunListQuery = z.infer<typeof EvalRunListQuery>;

export const RunTasksQuery = CursorQuery.extend({ model: queryOptional(z.string()), mode: queryOptional(CallMode), passed: queryOptional(QueryBool), category: queryOptional(EvalCategory) });

export const TranscriptItem = z.discriminatedUnion('type', [
  z.object({ type: z.literal('user'), text: z.string() }),
  z.object({ type: z.literal('assistant'), text: z.string() }),
  z.object({ type: z.literal('tool_call'), id: z.string(), tool: z.string(), arguments: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), tool: z.string(), isError: z.boolean(), content: z.string(), truncated: z.boolean().optional() }),
  z.object({ type: z.literal('note'), text: z.string() }),
]);
export type TranscriptItem = z.infer<typeof TranscriptItem>;

export const AssertionResult = z.object({ assertion: Assertion, passed: z.boolean(), detail: z.string(), matchedBy: z.enum(['literal', 'normalized', 'judge']).optional(), overBudget: z.boolean().optional() });
export type AssertionResult = z.infer<typeof AssertionResult>;

export const JudgeResult = z.object({ score: z.number().min(0).max(1), verdict: z.enum(['pass', 'fail']), reasons: z.array(z.string()).max(3) });
export type JudgeResult = z.infer<typeof JudgeResult>;

export const TaskRunDetail = z.object({
  id: Id,
  runId: Id,
  task: EvalTaskRow,
  model: z.string(),
  mode: CallMode,
  attempt: z.number().int(),
  passed: z.boolean(),
  assertionResults: z.array(AssertionResult),
  judge: JudgeResult.nullable(),
  failureCause: FailureCause.nullable(),
  toolCalls: z.number().int(),
  scripts: z.number().int(),
  tokens: TokenUsage,
  latencyMs: z.number().int(),
  servedByModel: z.string().nullable(),
  fallbackUsed: z.boolean(),
  neurouterTaskId: Id.nullable(),
  finalAnswer: z.string().nullable(),
  transcript: z.array(TranscriptItem),
  createdAt: IsoDateTime,
});
export type TaskRunDetail = z.infer<typeof TaskRunDetail>;

export const RunComparison = z.object({
  base: EvalRunRow,
  head: EvalRunRow,
  scoreDelta: z.number().int().nullable(),
  components: z.array(z.object({ key: ReadinessComponent.shape.key, label: z.string(), base: z.number().nullable(), head: z.number().nullable() })),
  matrix: z.array(z.object({ model: z.string(), mode: CallMode, base: MatrixCell.nullable(), head: MatrixCell.nullable() })),
  /** Pass counts like `0/3` per task key. */
  tasks: z.array(z.object({ taskKey: z.string(), category: EvalCategory.nullable(), base: z.string().nullable(), head: z.string().nullable() })),
  tokensDelta: z.number().nullable(),
  callsDelta: z.number().nullable(),
});
export type RunComparison = z.infer<typeof RunComparison>;

/* ------------------------------------------------------------------ suggestions (§15.7) */

export const SuggestionRow = z.object({
  id: Id,
  runId: Id,
  serverId: Id,
  cause: FailureCause,
  kind: SuggestionKind,
  tools: z.array(z.string()),
  affectedTaskKeys: z.array(z.string()),
  /** YAML overlay fragment. */
  overlayPatch: z.string(),
  /** RFC 6902 JSON Patch against the original spec (as JSON text), for "Copy spec patch". */
  specPatch: z.string().nullable(),
  rationale: z.string(),
  predictedDelta: z.number().int(),
  status: SuggestionStatus,
  verifyRunId: Id.nullable(),
  verifiedDelta: z.number().int().nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type SuggestionRow = z.infer<typeof SuggestionRow>;

export const SuggestionDetail = SuggestionRow.extend({ verifyRun: EvalRunRow.nullable(), affectedTasks: z.array(TaskResultRow) });
export type SuggestionDetail = z.infer<typeof SuggestionDetail>;

export const SuggestionApply = z.object({ mode: z.enum(['draft', 'publish']).default('draft'), message: z.string().min(1).max(500).optional() });
export const SuggestionApplyResult = z.object({ suggestion: SuggestionRow, draft: OverlayDraft.optional(), publish: OverlayPublishResult.optional() });
export type SuggestionApplyResult = z.infer<typeof SuggestionApplyResult>;

export const SuggestionSearchQuery = CursorQuery.extend({ serverId: queryOptional(Id), toolName: queryOptional(z.string().max(64)), status: queryArray(SuggestionStatus) });

const ServerIdParams = z.object({ id: Id });

export const evalEndpoints = {
  suites: endpoint({
    method: 'GET', path: '/api/servers/:id/eval-suites', kind: 'json', access: ['evals:read'],
    summary: 'Eval suite versions of a server', params: ServerIdParams, response: Items(EvalSuiteRow),
  }),
  generateSuite: endpoint({
    method: 'POST', path: '/api/servers/:id/eval-suites', kind: 'json', status: 202, access: ['evals:run'],
    summary: 'Generate a draft suite with the LLM (job result: EvalSuiteRow; 412 llm_key_missing)', params: ServerIdParams, body: SuiteGenerate, response: JobAccepted,
  }),
  suite: endpoint({
    method: 'GET', path: '/api/eval-suites/:id', kind: 'json', access: ['evals:read'],
    summary: 'Suite with its tasks', params: IdParams, response: EvalSuiteDetail,
  }),
  updateTask: endpoint({
    method: 'PATCH', path: '/api/eval-tasks/:id', kind: 'json', access: ['evals:run'],
    summary: 'Edit or disable a task (409 suite frozen)', params: IdParams, body: EvalTaskPatch, response: EvalTaskRow,
  }),
  createTask: endpoint({
    method: 'POST', path: '/api/eval-suites/:id/tasks', kind: 'json', status: 201, access: ['evals:run'],
    summary: 'Add a manual task (409 suite frozen)', params: IdParams, body: EvalTaskCreate, response: EvalTaskRow,
  }),
  freezeSuite: endpoint({
    method: 'POST', path: '/api/eval-suites/:id/freeze', kind: 'json', access: ['evals:run'],
    summary: 'Freeze a suite (the regression set)', params: IdParams, response: EvalSuiteRow,
  }),
  runs: endpoint({
    method: 'GET', path: '/api/eval-runs', kind: 'json', access: ['evals:read'],
    summary: 'Eval runs (newest first)', query: EvalRunListQuery, response: Page(EvalRunRow),
  }),
  createRun: endpoint({
    method: 'POST', path: '/api/eval-runs', kind: 'json', status: 202, access: ['evals:run'],
    summary: 'Start an eval run (412 llm_key_missing; 422 prod environment; 409 job_running)', body: EvalRunCreate, response: EvalRunRow,
  }),
  compare: endpoint({
    method: 'GET', path: '/api/eval-runs/compare', kind: 'json', access: ['evals:read'],
    summary: 'Compare two runs of the same server (422 different servers)', query: z.object({ base: Id, head: Id }), response: RunComparison,
  }),
  run: endpoint({
    method: 'GET', path: '/api/eval-runs/:id', kind: 'json', access: ['evals:read'],
    summary: 'Run with score, matrix and task results', params: IdParams, response: EvalRunDetail,
  }),
  runTasks: endpoint({
    method: 'GET', path: '/api/eval-runs/:id/tasks', kind: 'json', access: ['evals:read'],
    summary: 'Task results of a run, filtered', params: IdParams, query: RunTasksQuery, response: Page(TaskResultRow),
  }),
  taskRun: endpoint({
    method: 'GET', path: '/api/eval-runs/:id/task-runs/:taskRunId', kind: 'json', access: ['evals:read'],
    summary: 'One attempt with assertions, judge and transcript', params: z.object({ id: Id, taskRunId: Id }), response: TaskRunDetail,
  }),
  cancelRun: endpoint({
    method: 'POST', path: '/api/eval-runs/:id/cancel', kind: 'json', access: ['evals:run'],
    summary: 'Cancel a queued or running run', params: IdParams, response: EvalRunRow,
  }),
} as const;

export const readinessEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/servers/:id/readiness', kind: 'json', access: ['evals:read'],
    summary: 'Latest readiness (preliminary = lint-only when no run exists)', params: ServerIdParams, response: ReadinessSummary,
  }),
} as const;

export const suggestionEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/eval-runs/:id/suggestions', kind: 'json', access: ['evals:read'],
    summary: 'Fix suggestions of a run', params: IdParams, response: Items(SuggestionRow),
  }),
  search: endpoint({
    method: 'GET', path: '/api/suggestions', kind: 'json', access: ['evals:read'],
    summary: 'Suggestions by server, tool and status', query: SuggestionSearchQuery, response: Page(SuggestionRow),
  }),
  get: endpoint({
    method: 'GET', path: '/api/suggestions/:id', kind: 'json', access: ['evals:read'],
    summary: 'Suggestion with its verify run and affected tasks', params: IdParams, response: SuggestionDetail,
  }),
  verify: endpoint({
    method: 'POST', path: '/api/suggestions/:id/verify', kind: 'json', status: 202, access: ['evals:run'],
    summary: 'Run the affected tasks on a temporary build (published overlay + patch); 412', params: IdParams, response: SuggestionRow,
  }),
  apply: endpoint({
    method: 'POST', path: '/api/suggestions/:id/apply', kind: 'json', access: ['overlays:write'],
    summary: 'Write the patch into the overlay draft, or publish it (409 draft_conflict)', params: IdParams, body: SuggestionApply, response: SuggestionApplyResult,
  }),
  dismiss: endpoint({
    method: 'POST', path: '/api/suggestions/:id/dismiss', kind: 'json', access: ['evals:run'],
    summary: 'Dismiss a suggestion', params: IdParams, response: SuggestionRow,
  }),
} as const;
