import { JUDGE_PASS_SCORE, type Assertion } from '@neurouter/shared';
import { DECLINE_MARKER, DECLINE_PROMPT_VERSION, DECLINE_SYSTEM, EQUIV_MARKER, EQUIV_PROMPT_VERSION, EQUIV_SYSTEM, JUDGE_AMBIGUOUS_RUBRIC, JUDGE_CHOICE_RUBRIC, JUDGE_MARKER, JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, markerMessage } from './prompts.js';
import { groundTruthPreview, type GroundTruth } from './groundtruth.js';
import { parseJsonText, textOf, type LlmClient, type LlmUsage } from './llm/types.js';
import type { AttemptRecord, EvalTask, JudgeResult, JudgeUsage } from './types.js';

export const JUDGE_SCHEMA = {
  type: 'object',
  properties: {
    score: { type: 'number' },
    verdict: { type: 'string', enum: ['pass', 'fail'] },
    reasons: { type: 'array', items: { type: 'string' } },
  },
  required: ['score', 'verdict', 'reasons'],
  additionalProperties: false,
} as const;

/** Ambiguous tasks: the verdict plus how the agent handled the ambiguity. */
export const JUDGE_AMBIGUOUS_SCHEMA = {
  type: 'object',
  properties: { ...JUDGE_SCHEMA.properties, path: { type: 'string', enum: ['asked', 'assumed', 'neither'] } },
  required: [...JUDGE_SCHEMA.required, 'path'],
  additionalProperties: false,
} as const;

export const DECLINE_SCHEMA = {
  type: 'object',
  properties: { declined: { type: 'boolean' }, reason: { type: 'string' } },
  required: ['declined', 'reason'],
  additionalProperties: false,
} as const;

export const EQUIV_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'object', properties: { index: { type: 'integer' }, equivalent: { type: 'boolean' }, reason: { type: 'string' } }, required: ['index', 'equivalent', 'reason'], additionalProperties: false },
    },
  },
  required: ['items'],
  additionalProperties: false,
} as const;

export function needsJudge(task: EvalTask): boolean {
  return task.assertions.some((a) => a.type === 'judge');
}

export function emptyJudgeUsage(): JudgeUsage {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
}

/** Adds one judge call's provider usage (or an estimate when the provider reports none). */
export function addJudgeUsage(u: JudgeUsage, got: LlmUsage | undefined, promptChars: number): void {
  u.calls++;
  u.inputTokens += got?.input_tokens ?? Math.ceil(promptChars / 4);
  u.outputTokens += got?.output_tokens ?? 0;
  u.cacheReadTokens += got?.cache_read_input_tokens ?? 0;
}

export function judgeTokens(u: JudgeUsage | null | undefined): number {
  return u ? u.inputTokens + u.outputTokens + u.cacheReadTokens : 0;
}

/**
 * Token budget for the tool results given to the judge (≈ 4 characters per token). Every result fits whole when they
 * fit together; otherwise the budget is shared (small results whole, the large ones cut to an equal share), so an
 * answer that reports items from deep in a result can be verified (B8: a 1,500-char cut hid `topup_14` at char 1,756).
 */
export const JUDGE_RESULTS_TOKENS = 4_000;
/**
 * Ambiguous tasks: the verdict turns on the question or the stated assumption; results only show the agent acted
 * consistently with it, so they get a smaller share (voting asks such a verdict at least twice).
 */
export const JUDGE_AMBIGUOUS_RESULTS_TOKENS = 1_500;
/** Token budget for the ground-truth preview given to the judge. */
export const JUDGE_GROUND_TRUTH_TOKENS = 2_000;
const CHARS_PER_TOKEN = 4;

/** Tool results the agent saw (API calls, call_tool, run_script; not search or ops), within `tokens`. */
export function observedResults(rec: Pick<AttemptRecord, 'transcript'>, tokens = JUDGE_RESULTS_TOKENS): Array<{ tool: string; result: string }> {
  const all = rec.transcript
    .filter((t): t is Extract<AttemptRecord['transcript'][number], { kind: 'tool_result' }> => t.kind === 'tool_result' && !t.name.startsWith('neurouter_') && t.name !== 'search_tools')
    .slice(0, 40)
    .map((t) => ({ tool: t.name, result: t.text }));
  const budget = tokens * CHARS_PER_TOKEN;
  // water-filling: the largest share s with sum(min(len, s)) <= budget
  const lens = all.map((r) => r.result.length);
  if (lens.reduce((a, b) => a + b, 0) <= budget) return all;
  const sorted = [...lens].sort((a, b) => a - b);
  let left = budget;
  let share = 0;
  for (let i = 0; i < sorted.length; i++) {
    const even = Math.floor(left / (sorted.length - i));
    if (sorted[i]! <= even) left -= sorted[i]!;
    else {
      share = even;
      break;
    }
  }
  return all.map((r) => (r.result.length > share ? { tool: r.tool, result: `${r.result.slice(0, Math.max(0, share - 60))}… (cut: ${r.result.length} chars in all)` } : r));
}

/**
 * One judge call per attempt (§15.5): rubric + criteria + final answer + a compact call list. With
 * `groundTruth` (criteria marked `groundTruth`) the judge also gets the task's expected values; for
 * `kind: choice` criteria it gets the standard "stated choice, consistent results" rubric and the
 * tool results the agent saw. Usage is added to `usage`.
 */
export async function judgeAttempt(opts: { llm: LlmClient; model: string; task: EvalTask; record: AttemptRecord; groundTruth?: GroundTruth | null; usage?: JudgeUsage; signal?: AbortSignal }): Promise<JudgeResult> {
  const js = opts.task.assertions.filter((a): a is Extract<Assertion, { type: 'judge' }> => a.type === 'judge');
  const criteria = js.map((a) => (a.kind === 'choice' ? `${a.criterion}\n${JUDGE_CHOICE_RUBRIC}` : a.criterion));
  const ambiguous = isAmbiguousJudged(opts.task);
  if (ambiguous) criteria.push(JUDGE_AMBIGUOUS_RUBRIC);
  const input = {
    prompt: opts.task.prompt,
    rubric: opts.task.rubric,
    criteria,
    finalAnswer: opts.record.finalAnswer.slice(0, 8000),
    calls: opts.record.calls.slice(0, 60).map((c) => ({ tool: c.tool, args: truncateJson(c.arguments, 300), status: c.status, ...(c.write ? { write: c.decision === 'dry_run' ? 'dry_run' : 'yes' } : {}) })),
    // the results the agent saw, so facts in the answer can be verified (B8: whole, within a token budget)
    results: observedResults(opts.record, ambiguous ? JUDGE_AMBIGUOUS_RESULTS_TOKENS : JUDGE_RESULTS_TOKENS),
    ...(opts.groundTruth?.refs.length ? { groundTruth: groundTruthPreview(opts.groundTruth, JUDGE_GROUND_TRUTH_TOKENS * CHARS_PER_TOKEN) } : {}),
  };
  const content = markerMessage(JUDGE_MARKER, JUDGE_PROMPT_VERSION, input, 'Grade the agent against the rubric and criteria.');
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 2000,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: ambiguous ? JUDGE_AMBIGUOUS_SCHEMA : JUDGE_SCHEMA } },
      deterministic: true,
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  if (opts.usage) addJudgeUsage(opts.usage, res.usage, content.length);
  return normalizeJudge(parseJsonText(textOf(res)));
}

/** A verdict within this distance of the pass threshold is borderline (voted). */
export const JUDGE_BORDERLINE = 0.2;
/** At most this many calls per voted verdict; voting stops as soon as two agree. */
export const JUDGE_MAX_VOTES = 3;

/** Borderline: the score is within ±`JUDGE_BORDERLINE` of the pass threshold, or the task is an ambiguous one. */
export function judgeBorderline(task: Pick<EvalTask, 'category' | 'assertions'>, j: JudgeResult): boolean {
  return isAmbiguousJudged(task) || Math.abs(j.score - JUDGE_PASS_SCORE) <= JUDGE_BORDERLINE + 1e-9;
}

/**
 * The rubric judge with voting: one call; a borderline verdict (`judgeBorderline`) is asked again, up to 3 calls,
 * stopping as soon as two agree; the result is the first vote of the majority verdict. Every vote is returned.
 */
export async function judgeAttemptVoted(opts: Parameters<typeof judgeAttempt>[0]): Promise<{ result: JudgeResult; votes: JudgeResult[] }> {
  const votes: JudgeResult[] = [await judgeAttempt(opts)];
  if (!judgeBorderline(opts.task, votes[0]!)) return { result: votes[0]!, votes };
  while (votes.length < JUDGE_MAX_VOTES) {
    votes.push(await judgeAttempt(opts));
    const pass = votes.filter((v) => v.verdict === 'pass').length;
    const fail = votes.length - pass;
    if (pass >= 2 || fail >= 2) break;
  }
  const pass = votes.filter((v) => v.verdict === 'pass').length;
  const win = pass * 2 > votes.length ? 'pass' : 'fail';
  return { result: votes.find((v) => v.verdict === win)!, votes };
}

/**
 * The equivalence judge with voting (its rulings are yes/no, so every call is voted): up to 3 calls, stopping when
 * each item has two agreeing rulings; per item, the majority ruling (and its first reason).
 */
export async function judgeEquivalenceVoted(opts: Parameters<typeof judgeEquivalence>[0]): Promise<{ result: Record<number, { equivalent: boolean; reason: string }>; votes: Array<Record<number, { equivalent: boolean; reason: string }>> }> {
  const votes: Array<Record<number, { equivalent: boolean; reason: string }>> = [];
  const settled = () => opts.items.every((it) => {
    const r = votes.map((v) => v[it.index]).filter((x): x is { equivalent: boolean; reason: string } => Boolean(x));
    return r.filter((x) => x.equivalent).length >= 2 || r.filter((x) => !x.equivalent).length >= 2;
  });
  while (votes.length < JUDGE_MAX_VOTES) {
    votes.push(await judgeEquivalence(opts));
    if (votes.length >= 2 && settled()) break;
  }
  const result: Record<number, { equivalent: boolean; reason: string }> = {};
  for (const it of opts.items) {
    const r = votes.map((v) => v[it.index]).filter((x): x is { equivalent: boolean; reason: string } => Boolean(x));
    if (!r.length) continue;
    const yes = r.filter((x) => x.equivalent).length;
    const win = yes * 2 > r.length;
    result[it.index] = r.find((x) => x.equivalent === win)!;
  }
  return { result, votes };
}

/** An ambiguous task judged by a rubric criterion (not `kind: choice`): asking or an explicit assumption both pass. */
export function isAmbiguousJudged(task: Pick<EvalTask, 'category' | 'assertions'>): boolean {
  return task.category === 'ambiguous' && task.assertions.some((a) => a.type === 'judge' && a.kind !== 'choice');
}

/**
 * Decline judge (impossible tasks, B1): the deterministic decline patterns missed and nothing was written; did the
 * answer decline or explain that the request cannot be done, without claiming to have done it?
 */
export async function judgeDecline(opts: { llm: LlmClient; model: string; task: Pick<EvalTask, 'prompt' | 'rubric'>; answer: string; usage?: JudgeUsage; signal?: AbortSignal }): Promise<{ declined: boolean; reason: string }> {
  const input = { prompt: opts.task.prompt, rubric: opts.task.rubric, answer: opts.answer.slice(0, 4000) };
  const content = markerMessage(DECLINE_MARKER, DECLINE_PROMPT_VERSION, input, 'Does the answer decline, or explain that this cannot be done, without claiming to have done it?');
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 500,
      system: DECLINE_SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: DECLINE_SCHEMA } },
      deterministic: true,
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  if (opts.usage) addJudgeUsage(opts.usage, res.usage, content.length);
  const raw = (parseJsonText(textOf(res)) ?? {}) as { declined?: unknown; reason?: unknown };
  return { declined: raw.declined === true, reason: String(raw.reason ?? '').slice(0, 200) };
}

export interface EquivalenceItem {
  index: number;
  expected: unknown[];
  field: string | null;
}

/**
 * Answer-equivalence judge (normalized matching failed): given the expected values from the ground
 * truth, does the answer state them in another form? One call per attempt for all failed checks.
 */
export async function judgeEquivalence(opts: { llm: LlmClient; model: string; task: Pick<EvalTask, 'prompt'>; answer: string; items: EquivalenceItem[]; usage?: JudgeUsage; signal?: AbortSignal }): Promise<Record<number, { equivalent: boolean; reason: string }>> {
  if (!opts.items.length || !opts.answer.trim()) return {};
  const input = { prompt: opts.task.prompt, answer: opts.answer.slice(0, 8000), items: opts.items.map((i) => ({ index: i.index, field: i.field, expected: i.expected })) };
  const content = markerMessage(EQUIV_MARKER, EQUIV_PROMPT_VERSION, input, 'For each item, decide whether the answer states the expected value(s).');
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 1500,
      system: EQUIV_SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: EQUIV_SCHEMA } },
      deterministic: true,
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  if (opts.usage) addJudgeUsage(opts.usage, res.usage, content.length);
  const raw = parseJsonText(textOf(res)) as { items?: Array<{ index?: unknown; equivalent?: unknown; reason?: unknown }> };
  const out: Record<number, { equivalent: boolean; reason: string }> = {};
  const valid = new Set(opts.items.map((i) => i.index));
  for (const it of Array.isArray(raw.items) ? raw.items : []) {
    const idx = Number(it.index);
    if (valid.has(idx)) out[idx] = { equivalent: it.equivalent === true, reason: String(it.reason ?? '').slice(0, 200) };
  }
  return out;
}

export function normalizeJudge(raw: unknown): JudgeResult {
  const o = (raw ?? {}) as Record<string, unknown>;
  const score = Math.max(0, Math.min(1, Number(o.score) || 0));
  const verdict = o.verdict === 'pass' && score >= JUDGE_PASS_SCORE ? 'pass' : 'fail';
  const reasons = Array.isArray(o.reasons) ? o.reasons.map(String).slice(0, 3) : [];
  const path = o.path === 'asked' || o.path === 'assumed' || o.path === 'neither' ? o.path : undefined;
  return { score, verdict, reasons, ...(path ? { path } : {}) };
}

function truncateJson(v: unknown, max: number): string {
  const s = JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
