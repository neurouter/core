import { READINESS_WEIGHTS, readinessBand, type EvalCategory, type EvalConfidence, type LintReport, type ReadinessBand, type ReadinessComponentKey } from '@neurouter/shared';
import type { CellScore, EvalMode, EvalTask, ReadinessComponent, ReadinessScore, TaskRunResult } from './types.js';

export interface ScoreInput {
  /** Enabled suite tasks (T). */
  tasks: EvalTask[];
  results: TaskRunResult[];
  /** Models in request order; the first is the primary model (headline). */
  models: string[];
  modes: EvalMode[];
  /** Build lint score 0..100 (component Q). */
  lintScore: number;
  /** API-correctness pass rate 0..1, only when that suite ran. */
  correctness?: number | null;
}

const LABELS: Record<ReadinessComponentKey, string> = {
  success: 'Task success',
  impossible: 'Impossible-task handling',
  efficiency: 'Efficiency',
  framing: 'Framing compliance',
  quality: 'Tool quality',
  stability: 'Stability',
  correctness: 'API correctness',
};

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Tokens of one attempt, the same way for every provider: every input token the model read (uncached
 * + cached, i.e. the full prompt each turn, summed over turns) plus every output token (reasoning
 * included). Provider caching changes the bill, not this count: OpenAI caches long tool lists
 * automatically, Anthropic only with cache_control, so counting uncached input alone made models
 * incomparable. Cached input is reported separately (`cacheReadTokens`, `avgCachedTokens`).
 * "Tokens per multi-step task" (`avgTokensMulti`) is the mean of this over the multi-step attempts.
 */
export function attemptTokens(r: Pick<TaskRunResult, 'inputTokens' | 'outputTokens'> & { cacheReadTokens?: number }): number {
  return r.inputTokens + (r.cacheReadTokens ?? 0) + r.outputTokens;
}

/** Calls an attempt is charged for in efficiency: upstream API calls (0.2.2), else the agent's work calls (older results). */
export function chargedCalls(r: Pick<TaskRunResult, 'toolCalls'> & { upstreamCalls?: number }): number {
  return r.upstreamCalls ?? r.toolCalls;
}

/**
 * One `(model, mode)` cell per §15.6. Fallback-served attempts and provider refusals (the model
 * provider's policy filter declined the prompt) are excluded from the model's score and counted.
 * Over-budget attempts count as successes; efficiency charges their calls.
 */
export function scoreCell(input: ScoreInput, model: string, mode: EvalMode): CellScore {
  const all = input.results.filter((r) => r.model === model && r.mode === mode);
  const refusals = all.filter((r) => r.failureCause === 'provider_refusal' && !r.fallbackUsed).length;
  const counted = all.filter((r) => !r.fallbackUsed && r.failureCause !== 'provider_refusal');
  const byTask = new Map<string, TaskRunResult[]>();
  for (const r of counted) byTask.set(r.taskKey, [...(byTask.get(r.taskKey) ?? []), r]);
  const tasks = input.tasks.filter((t) => t.enabled !== false);
  const p = new Map<string, number>();
  let flaky = 0;
  for (const t of tasks) {
    const rs = byTask.get(t.key) ?? [];
    if (!rs.length) continue;
    const passes = rs.filter((r) => r.passed).length;
    p.set(t.key, passes / rs.length);
    if (passes > 0 && passes < rs.length) flaky++;
  }
  const measured = tasks.filter((t) => p.has(t.key));
  const pOf = (cats: EvalCategory[]) => measured.filter((t) => cats.includes(t.category)).map((t) => p.get(t.key)!);
  const refCalls = new Map(tasks.map((t) => [t.key, t.referenceCalls.length]));
  const passed = counted.filter((r) => r.passed);
  const framingAttempts = counted.filter((r) => r.framingPassed !== null);

  const comps: Array<{ key: ReadinessComponentKey; score: number; detail: string }> = [];
  const possible = pOf(['single', 'multi', 'ambiguous']);
  if (possible.length) comps.push({ key: 'success', score: mean(possible), detail: `${pct(mean(possible))} mean pass rate over ${possible.length} tasks` });
  const imp = pOf(['impossible']);
  if (imp.length) comps.push({ key: 'impossible', score: mean(imp), detail: `${pct(mean(imp))} of impossible tasks handled` });
  if (counted.length) {
    const eff = passed.map((r) => Math.min(1, ((refCalls.get(r.taskKey) ?? r.referenceCallCount) + 1) / (chargedCalls(r) + 1)));
    const over = passed.filter((r) => r.overBudget).length;
    comps.push({ key: 'efficiency', score: mean(eff), detail: passed.length ? `${mean(passed.map(chargedCalls)).toFixed(1)} upstream calls per passed attempt${over ? `; ${over} passed over budget` : ''}` : 'no passed attempts' });
    if (framingAttempts.length) {
      const f = framingAttempts.filter((r) => r.framingPassed).length / framingAttempts.length;
      comps.push({ key: 'framing', score: f, detail: `${pct(f)} of attempts framed with begin/end_task` });
    }
  }
  comps.push({ key: 'quality', score: clamp01(input.lintScore / 100), detail: `lint score ${Math.round(input.lintScore)}` });
  if (measured.length) comps.push({ key: 'stability', score: 1 - flaky / measured.length, detail: `${flaky} flaky of ${measured.length} tasks` });
  if (input.correctness !== undefined && input.correctness !== null) comps.push({ key: 'correctness', score: clamp01(input.correctness), detail: `${pct(input.correctness)} of correctness checks passed` });

  const wsum = comps.reduce((a, c) => a + READINESS_WEIGHTS[c.key], 0);
  const score = wsum ? Math.round((100 * comps.reduce((a, c) => a + READINESS_WEIGHTS[c.key] * c.score, 0)) / wsum) : 0;
  const components: ReadinessComponent[] = comps.map((c) => ({ key: c.key, label: LABELS[c.key], weight: READINESS_WEIGHTS[c.key], score: c.score, detail: c.detail, fixCount: 0 }));
  const categorySuccess: Partial<Record<EvalCategory, number>> = {};
  for (const cat of ['single', 'multi', 'ambiguous', 'impossible'] as const) {
    const xs = pOf([cat]);
    if (xs.length) categorySuccess[cat] = mean(xs);
  }
  const multiKeys = new Set(tasks.filter((t) => t.category === 'multi').map((t) => t.key));
  const multi = counted.filter((r) => multiKeys.has(r.taskKey));
  return {
    model,
    mode,
    score,
    components,
    successRate: counted.length ? passed.length / counted.length : 0,
    categorySuccess,
    avgTokens: mean(counted.map(attemptTokens)),
    avgCachedTokens: mean(counted.map((r) => r.cacheReadTokens ?? 0)),
    avgCalls: mean(counted.map(chargedCalls)),
    avgLatencyMs: mean(counted.map((r) => r.latencyMs)),
    avgTokensMulti: multi.length ? mean(multi.map(attemptTokens)) : null,
    flakyTasks: flaky,
    attempts: counted.length,
    excludedFallback: all.filter((r) => r.fallbackUsed).length,
    excludedRefusals: refusals,
    overBudget: counted.filter((r) => r.overBudget).length,
    avgToolsListBytes: counted.some((r) => r.toolsListBytes !== undefined) ? mean(counted.filter((r) => r.toolsListBytes !== undefined).map((r) => r.toolsListBytes!)) : null,
    best: false,
  };
}

/** Full readiness score: cells, headline (best mode of the primary model), recommended mode, confidence. */
export function scoreRun(input: ScoreInput): ReadinessScore {
  const cells: CellScore[] = [];
  for (const m of input.models) for (const mode of input.modes) if (input.results.some((r) => r.model === m && r.mode === mode)) cells.push(scoreCell(input, m, mode));
  const primary = input.models[0];
  const prim = cells.filter((c) => c.model === primary);
  for (const model of input.models) {
    const mc = cells.filter((c) => c.model === model);
    const top = mc.reduce<CellScore | null>((b, c) => (!b || c.score > b.score ? c : b), null);
    if (top) top.best = true;
  }
  const { mode: recommendedMode, text } = recommend(prim);
  const head = prim.find((c) => c.mode === recommendedMode) ?? prim.reduce<CellScore | null>((b, c) => (!b || c.score > b.score ? c : b), null);
  const headline = head ? Math.max(...prim.map((c) => c.score)) : 0;
  const total = input.results.length;
  const excluded = input.results.filter((r) => r.fallbackUsed).length;
  const confidence: EvalConfidence = total && excluded / total > 0.2 ? 'degraded' : 'measured';
  const modeScores: Partial<Record<EvalMode, number>> = {};
  for (const c of prim) modeScores[c.mode] = c.score;
  const best = prim.find((c) => c.score === headline) ?? head;
  return { headline, band: readinessBand(headline), recommendedMode, recommendationText: text, confidence, modeScores, cells, breakdown: best?.components ?? [] };
}

/** Success within this many points counts as "about the same" for the cost rule. */
export const RECOMMEND_SUCCESS_TOLERANCE = 10;
/** A mode costing at least this many times the other's tokens per multi-step task is "much more expensive". */
export const RECOMMEND_COST_RATIO = 2;

/**
 * Recommended mode (§15.6, cost-aware in 0.2.2): the higher cell; when the difference is < 3 points,
 * `tool` unless code mode's success on multi tasks is ≥ 10 points higher. Then the cost rule: when the
 * pick needs ≥ 2× the other mode's tokens per multi-step task (a large tools/list is resent with every
 * turn: bytes × turns, not the tool count) while the other mode's success is within 10 points, the
 * cheaper mode is recommended.
 */
export function recommend(primaryCells: CellScore[]): { mode: EvalMode | null; text: string } {
  const tool = primaryCells.find((c) => c.mode === 'tool');
  const code = primaryCells.find((c) => c.mode === 'code');
  if (!tool && !code) return { mode: null, text: 'No measured cells.' };
  if (!tool || !code) {
    const only = (tool ?? code)!;
    return { mode: only.mode, text: `${only.mode} mode (the only mode measured): ${only.score}/100.` };
  }
  let mode: EvalMode;
  if (Math.abs(tool.score - code.score) < 3) {
    const tm = tool.categorySuccess.multi ?? 0;
    const cm = code.categorySuccess.multi ?? 0;
    mode = Math.round(cm * 100) - Math.round(tm * 100) >= 10 ? 'code' : 'tool';
  } else mode = code.score > tool.score ? 'code' : 'tool';
  const tokensOf = (c: CellScore) => c.avgTokensMulti ?? c.avgTokens;
  const successOf = (c: CellScore) => c.categorySuccess.multi ?? c.successRate;
  let costNote = '';
  {
    const pick = mode === 'code' ? code : tool;
    const alt = mode === 'code' ? tool : code;
    const ratio = tokensOf(alt) > 0 ? tokensOf(pick) / tokensOf(alt) : 1;
    const gap = Math.round((successOf(pick) - successOf(alt)) * 100);
    if (ratio >= RECOMMEND_COST_RATIO && gap <= RECOMMEND_SUCCESS_TOLERANCE) {
      mode = alt.mode;
      const kb = pick.avgToolsListBytes ? `; its tools/list is ${Math.round(pick.avgToolsListBytes / 1024)} KB, resent every turn` : '';
      costNote = `; ${pick.mode} mode is within ${gap} pts but costs ${ratio.toFixed(1)}× the tokens${kb}`;
    }
  }
  const rec = mode === 'code' ? code : tool;
  const other = mode === 'code' ? tool : code;
  const ds = Math.round((successOf(rec) - successOf(other)) * 100);
  const rt = tokensOf(rec);
  const ot = tokensOf(other);
  const dt = ot > 0 ? Math.round(((ot - rt) / ot) * 100) : 0;
  const sign = (n: number) => (n >= 0 ? `+${n}` : `−${Math.abs(n)}`);
  const tokens = dt >= 0 ? `−${dt}% tokens` : `+${Math.abs(dt)}% tokens`;
  // category rates are means of per-task pass rates (floats): 14/24 can come out as 0.58333…34 in one
  // cell and 0.58333…33 in the other, so compare with a tolerance far below one attempt's share
  const single = greater(other.categorySuccess.single ?? 0, rec.categorySuccess.single ?? 0) ? `; ${other.mode} mode is better for single lookups` : '';
  return { mode, text: `${mode} mode: ${sign(ds)} pts success, ${tokens} on multi-step tasks${single}${costNote}` };
}

export interface PreliminaryScore {
  score: number;
  band: ReadinessBand;
  confidence: 'preliminary';
}

/** Preliminary score before any eval run: the lint score alone. */
export function preliminaryScore(lint: Pick<LintReport, 'score'> | number): PreliminaryScore {
  const score = Math.round(typeof lint === 'number' ? lint : lint.score);
  return { score, band: readinessBand(score), confidence: 'preliminary' };
}

/** Rates closer than this are equal (one attempt in a suite moves a rate by ≥ 1/10,000 long before this). */
export const RATE_EPSILON = 1e-9;
/** `a > b` for rates, with `RATE_EPSILON` tolerance. */
export function greater(a: number, b: number): boolean {
  return a - b > RATE_EPSILON;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
