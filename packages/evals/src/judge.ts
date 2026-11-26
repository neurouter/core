import { JUDGE_PASS_SCORE, type Assertion } from '@neurouter/shared';
import { EQUIV_MARKER, EQUIV_PROMPT_VERSION, EQUIV_SYSTEM, JUDGE_CHOICE_RUBRIC, JUDGE_MARKER, JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, markerMessage } from './prompts.js';
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

/** Tool results the agent saw (text, cut), for `choice` and ground-truth judging. */
function observedResults(rec: AttemptRecord, max = 6, chars = 1500): Array<{ tool: string; result: string }> {
  return rec.transcript
    .filter((t): t is Extract<AttemptRecord['transcript'][number], { kind: 'tool_result' }> => t.kind === 'tool_result' && !t.name.startsWith('neurouter_') && t.name !== 'search_tools')
    .slice(0, max)
    .map((t) => ({ tool: t.name, result: t.text.length > chars ? `${t.text.slice(0, chars)}…` : t.text }));
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
  const choice = js.some((a) => a.kind === 'choice');
  const wantsGt = js.some((a) => a.groundTruth) && opts.groundTruth;
  const input = {
    prompt: opts.task.prompt,
    rubric: opts.task.rubric,
    criteria,
    finalAnswer: opts.record.finalAnswer.slice(0, 8000),
    calls: opts.record.calls.slice(0, 60).map((c) => ({ tool: c.tool, args: truncateJson(c.arguments, 300), status: c.status })),
    ...(choice ? { results: observedResults(opts.record) } : {}),
    ...(wantsGt ? { groundTruth: groundTruthPreview(opts.groundTruth!, 4000) } : {}),
  };
  const content = markerMessage(JUDGE_MARKER, JUDGE_PROMPT_VERSION, input, 'Grade the agent against the rubric and criteria.');
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 2000,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  if (opts.usage) addJudgeUsage(opts.usage, res.usage, content.length);
  return normalizeJudge(parseJsonText(textOf(res)));
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
  return { score, verdict, reasons };
}

function truncateJson(v: unknown, max: number): string {
  const s = JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
