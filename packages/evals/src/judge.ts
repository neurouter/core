import { JUDGE_PASS_SCORE, type Assertion } from '@neurouter/shared';
import { JUDGE_MARKER, JUDGE_PROMPT_VERSION, JUDGE_SYSTEM, markerMessage } from './prompts.js';
import { parseJsonText, textOf, type LlmClient } from './llm/types.js';
import type { AttemptRecord, EvalTask, JudgeResult } from './types.js';

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

export function needsJudge(task: EvalTask): boolean {
  return task.assertions.some((a) => a.type === 'judge');
}

/** One judge call per attempt (§15.5): rubric + criteria + final answer + a compact call list. */
export async function judgeAttempt(opts: { llm: LlmClient; model: string; task: EvalTask; record: AttemptRecord; signal?: AbortSignal }): Promise<JudgeResult> {
  const criteria = opts.task.assertions.filter((a): a is Extract<Assertion, { type: 'judge' }> => a.type === 'judge').map((a) => a.criterion);
  const input = {
    prompt: opts.task.prompt,
    rubric: opts.task.rubric,
    criteria,
    finalAnswer: opts.record.finalAnswer.slice(0, 8000),
    calls: opts.record.calls.slice(0, 60).map((c) => ({ tool: c.tool, args: truncateJson(c.arguments, 300), status: c.status })),
  };
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 2000,
      system: JUDGE_SYSTEM,
      messages: [{ role: 'user', content: markerMessage(JUDGE_MARKER, JUDGE_PROMPT_VERSION, input, 'Grade the agent against the rubric and criteria.') }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: JUDGE_SCHEMA } },
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  return normalizeJudge(parseJsonText(textOf(res)));
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
