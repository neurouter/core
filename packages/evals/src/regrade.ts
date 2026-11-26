/**
 * Offline re-grade: re-scores recorded attempts (`eval --transcripts` files) with the current grader
 * without running agents again. The final answer, the agent's calls and the audit calls are in the
 * transcript; arguments the audit log redacted are recovered from the agent's own tool calls where
 * possible (tool mode; code-mode inner calls stay redacted). Rubric-judge verdicts recorded with the
 * attempt are reused unless the task's judge criteria changed; new judging and answer-equivalence
 * calls are made only within a token budget.
 */
import { gradeAttempt } from './run.js';
import { emptyJudgeUsage, judgeTokens } from './judge.js';
import type { GroundTruth } from './groundtruth.js';
import type { LlmClient } from './llm/types.js';
import type { AgentCall, AttemptRecord, EvalTask, JudgeResult, JudgeUsage, ObservedCall, TaskRunResult, TranscriptItem } from './types.js';

/** One entry of a transcripts file (a TaskRunResult plus the prompt). */
export type TranscriptEntry = Partial<TaskRunResult> & Pick<TaskRunResult, 'taskKey' | 'passed' | 'transcript' | 'calls' | 'model' | 'mode' | 'attempt'> & { prompt?: string | null };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const redacted = (v: unknown): boolean => (isObj(v) && typeof v.$redacted === 'string') || (Array.isArray(v) ? v.some(redacted) : isObj(v) && Object.values(v).some(redacted));

/** The agent's direct API calls from a transcript (call_tool unwrapped), in order. */
function agentApiCalls(items: TranscriptItem[]): Array<{ tool: string; arguments: Record<string, unknown> }> {
  const out: Array<{ tool: string; arguments: Record<string, unknown> }> = [];
  for (const it of items) {
    if (it.kind !== 'tool_call') continue;
    const args = (isObj(it.arguments) ? it.arguments : {}) as Record<string, unknown>;
    if (it.name === 'call_tool' && typeof args.name === 'string') out.push({ tool: args.name, arguments: (isObj(args.arguments) ? args.arguments : {}) as Record<string, unknown> });
    else if (!it.name.startsWith('neurouter_') && it.name !== 'search_tools' && it.name !== 'run_script') out.push({ tool: it.name, arguments: args });
  }
  return out;
}

/** Fills redacted values of audit calls from the agent's own calls to the same tool (same order). */
export function unredactCalls(calls: ObservedCall[], items: TranscriptItem[]): ObservedCall[] {
  const agent = agentApiCalls(items);
  const used = new Set<number>();
  return calls.map((c) => {
    if (!redacted(c.arguments) || c.via === 'script') return c;
    const i = agent.findIndex((a, j) => !used.has(j) && a.tool === c.tool);
    if (i < 0) return c;
    used.add(i);
    const merged: Record<string, unknown> = { ...c.arguments };
    for (const [k, v] of Object.entries(merged)) if (redacted(v) && k in agent[i]!.arguments) merged[k] = agent[i]!.arguments[k];
    return { ...c, arguments: merged };
  });
}

/** Rebuilds the attempt record the checker reads from a transcripts-file entry. */
export function recordFromTranscript(e: TranscriptEntry): AttemptRecord {
  const items = e.transcript ?? [];
  const agentCalls: AgentCall[] = [];
  const results = new Map(items.filter((i): i is Extract<TranscriptItem, { kind: 'tool_result' }> => i.kind === 'tool_result').map((i) => [i.id, i]));
  for (const it of items) if (it.kind === 'tool_call') agentCalls.push({ name: it.name, arguments: (isObj(it.arguments) ? it.arguments : {}) as Record<string, unknown>, isError: results.get(it.id)?.isError ?? false, latencyMs: 0 });
  const answers = items.filter((i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant');
  const lastCall = items.map((i) => i.kind).lastIndexOf('tool_call');
  const finalTexts = items.slice(lastCall + 1).filter((i): i is Extract<TranscriptItem, { kind: 'assistant' }> => i.kind === 'assistant');
  return {
    finalAnswer: (finalTexts.length ? finalTexts : answers.slice(-1)).map((a) => a.text).join('\n'),
    agentCalls,
    toolCallsByAgent: agentCalls.filter((c) => !c.name.startsWith('neurouter_')).length,
    scripts: e.scripts ?? agentCalls.filter((c) => c.name === 'run_script').length,
    turns: 0,
    inputTokens: e.inputTokens ?? 0,
    outputTokens: e.outputTokens ?? 0,
    cacheReadTokens: e.cacheReadTokens ?? 0,
    cacheWriteTokens: e.cacheWriteTokens ?? 0,
    latencyMs: e.latencyMs ?? 0,
    servedByModel: e.servedByModel ?? null,
    fallbackUsed: e.fallbackUsed ?? false,
    stopReason: null,
    endReason: e.endReason ?? 'end_turn',
    error: e.error ?? null,
    transcript: items,
    neurouterTaskId: e.neurouterTaskId ?? null,
    framingAvailable: agentCalls.some((c) => c.name === 'neurouter_begin_task') || e.framingPassed !== null,
    calls: unredactCalls(e.calls ?? [], items),
  };
}

export interface RegradeRow {
  taskKey: string;
  model: string;
  mode: string;
  attempt: number;
  oldPassed: boolean;
  newPassed: boolean;
  /** Not scored (provider refusal) in the new grader. */
  excluded: boolean;
  failureCause: string | null;
  overBudget: boolean;
  matchedByJudge: boolean;
  /** Failed assertion details (new grader). */
  failed: string[];
  /** Judge verdict could not be made (budget exhausted). */
  unjudged: boolean;
}

export interface RegradeOptions {
  /** The migrated suite's tasks (by key) as resolved for the build the transcripts ran on. */
  tasks: Map<string, EvalTask>;
  groundTruth: (task: EvalTask) => Promise<GroundTruth | null>;
  llm?: LlmClient | null;
  judgeModel?: string;
  /** Hard cap on judge tokens for the whole re-grade (default 300,000). */
  maxJudgeTokens?: number;
}

/** Re-grades recorded attempts; returns per-attempt rows and the judge usage. */
export async function regradeTranscripts(entries: TranscriptEntry[], o: RegradeOptions): Promise<{ rows: RegradeRow[]; judgeUsage: JudgeUsage; skippedTasks: string[] }> {
  const usage = emptyJudgeUsage();
  const cap = o.maxJudgeTokens ?? 300_000;
  const rows: RegradeRow[] = [];
  const skipped = new Set<string>();
  const gtCache = new Map<string, GroundTruth | null>();
  for (const e of entries) {
    const task = o.tasks.get(e.taskKey);
    if (!task || task.enabled === false) {
      skipped.add(e.taskKey);
      continue;
    }
    if (!gtCache.has(task.key)) gtCache.set(task.key, await o.groundTruth(task));
    const gt = gtCache.get(task.key) ?? null;
    const rec = recordFromTranscript(e);
    // reuse the recorded rubric verdict, except for a new choice criterion, and for failed verdicts of
    // criteria that now get the ground truth (the recorded judge never saw the API's results)
    const js = task.assertions.filter((a) => a.type === 'judge');
    const newCriteria = js.some((a) => a.kind === 'choice') || (e.judge?.verdict === 'fail' && js.some((a) => a.groundTruth));
    const reuse: JudgeResult | null = !newCriteria && e.judge ? e.judge : null;
    const budgetLeft = judgeTokens(usage) < cap;
    const { check, judgeUsage } = await gradeAttempt(task, rec, { llm: budgetLeft ? (o.llm ?? null) : null, ...(o.judgeModel ? { judgeModel: o.judgeModel } : {}), groundTruth: gt, judge: reuse });
    for (const k of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens'] as const) usage[k] += judgeUsage[k];
    const unjudged = check.results.some((r) => r.assertion.type === 'judge' && r.detail === 'not judged');
    rows.push({
      taskKey: e.taskKey,
      model: e.model,
      mode: e.mode,
      attempt: e.attempt,
      oldPassed: e.passed,
      newPassed: check.passed,
      excluded: check.failureCause === 'provider_refusal',
      failureCause: check.failureCause,
      overBudget: check.overBudget,
      matchedByJudge: check.results.some((r) => r.matchedBy === 'judge'),
      failed: check.results.filter((r) => !r.passed && r.assertion.type !== 'framing').map((r) => `${r.assertion.type}: ${r.detail}`),
      unjudged,
    });
  }
  return { rows, judgeUsage: usage, skippedTasks: [...skipped] };
}

/** Pass rates of a re-grade (old over all attempts of the retained tasks; new without provider refusals). */
export function regradeSummary(rows: RegradeRow[]): { attempts: number; oldPassRate: number; newPassRate: number; excluded: number; flipsUp: number; flipsDown: number; overBudget: number; matchedByJudge: number } {
  const counted = rows.filter((r) => !r.excluded);
  return {
    attempts: rows.length,
    oldPassRate: rows.length ? rows.filter((r) => r.oldPassed).length / rows.length : 0,
    newPassRate: counted.length ? counted.filter((r) => r.newPassed).length / counted.length : 0,
    excluded: rows.length - counted.length,
    flipsUp: rows.filter((r) => !r.oldPassed && r.newPassed).length,
    flipsDown: rows.filter((r) => r.oldPassed && !r.newPassed && !r.excluded).length,
    overBudget: counted.filter((r) => r.overBudget).length,
    matchedByJudge: counted.filter((r) => r.matchedByJudge).length,
  };
}
