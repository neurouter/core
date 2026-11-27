import { attemptTokens } from './score.js';
import type { Suggestion } from './suggest.js';
import type { JudgeUsage, ReadinessScore, SuiteCalibration, TaskRunResult } from './types.js';

/** CLI/CI report (`EvalReport` ≈ EvalRunDetail + suggestions, §15.8). */
export interface EvalReport {
  version: 1;
  server: { slug: string; name: string };
  /** `contract`: the agent contract the eval server served (1 or 2). `judgeModel`: the model that judged the attempts. */
  run: { id: string | null; models: string[]; modes: string[]; repeats: number; environment: string; buildHash: string | null; provider: string; startedAt: string; endedAt: string; contract?: 1 | 2 | null; judgeModel?: string | null };
  score: ReadinessScore;
  /** Per (model, mode, category): counted attempts (no provider refusals), passes, success, tokens per attempt. */
  categories: CategoryRow[];
  tasks: Array<{ key: string; category: string; prompt: string; cells: Array<{ model: string; mode: string; passes: number; attempts: number; failureCause: string | null; overBudget: number; refusals: number; matchedByJudge: number }> }>;
  topFailures: Array<{ taskKey: string; model: string; mode: string; cause: string | null; detail: string }>;
  suggestions: Suggestion[];
  /** Per model: uncached input, output, cached input read and cache writes (part of input); see `attemptTokens`. */
  usage: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }>;
  /** Suite generation in this run (`eval --generate`): generator model and LLM usage. */
  generator?: { model: string; usage: { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; totalTokens: number; budgetTokens: number }; tasks: number; diagnostics: number; coverage?: Record<string, number> };
  /** Judge LLM usage of the run (rubric + answer-equivalence judge), per judge model. */
  judgeUsage: Record<string, JudgeUsage>;
  /** Attempts the model provider refused (policy filter): excluded from scoring. */
  providerRefusals: number;
  /** The run stopped at `--max-run-tokens`. */
  incomplete?: { reason: string; attemptsRun: number; attemptsPlanned: number } | null;
  /** Calibration gate of the suite (rejected tasks were not run). */
  calibration?: Pick<SuiteCalibration, 'mockDataVersion' | 'passed' | 'rejected' | 'flagged' | 'model'> & { tasks: SuiteCalibration['tasks'] };
}

export interface CategoryRow {
  model: string;
  mode: string;
  category: string;
  attempts: number;
  passes: number;
  successRate: number;
  tokensPerAttempt: number;
}

const CATEGORY_ORDER = ['single', 'multi', 'ambiguous', 'impossible'];

/** Success and cost per category of every (model, mode) cell; provider refusals and fallback-served attempts excluded. */
export function categoryRows(results: TaskRunResult[]): CategoryRow[] {
  const m = new Map<string, CategoryRow & { tokens: number }>();
  for (const r of results) {
    if (r.failureCause === 'provider_refusal' || r.fallbackUsed) continue;
    const k = `${r.model}|${r.mode}|${r.category}`;
    const c = m.get(k) ?? { model: r.model, mode: r.mode, category: r.category, attempts: 0, passes: 0, successRate: 0, tokensPerAttempt: 0, tokens: 0 };
    c.attempts++;
    if (r.passed) c.passes++;
    c.tokens += attemptTokens(r);
    m.set(k, c);
  }
  const rank = (c: string) => (CATEGORY_ORDER.indexOf(c) + 1 || 9);
  return [...m.values()]
    .map(({ tokens, ...c }) => ({ ...c, successRate: c.attempts ? c.passes / c.attempts : 0, tokensPerAttempt: c.attempts ? Math.round(tokens / c.attempts) : 0 }))
    .sort((a, b) => a.model.localeCompare(b.model) || a.mode.localeCompare(b.mode) || rank(a.category) - rank(b.category));
}

export function buildReport(
  input: Omit<EvalReport, 'version' | 'tasks' | 'topFailures' | 'usage' | 'generator' | 'judgeUsage' | 'providerRefusals' | 'incomplete' | 'calibration' | 'categories'> & {
    generator?: EvalReport['generator'];
    incomplete?: EvalReport['incomplete'];
    calibration?: EvalReport['calibration'];
    judgeModel?: string;
  } & { results: TaskRunResult[]; prompts: Record<string, { category: string; prompt: string }> },
): EvalReport {
  const byTask = new Map<string, TaskRunResult[]>();
  for (const r of input.results) byTask.set(r.taskKey, [...(byTask.get(r.taskKey) ?? []), r]);
  const tasks = [...byTask.entries()].map(([key, rs]) => {
    const cells = new Map<string, EvalReport['tasks'][number]['cells'][number]>();
    for (const r of rs) {
      const k = `${r.model}|${r.mode}`;
      const c = cells.get(k) ?? { model: r.model, mode: r.mode, passes: 0, attempts: 0, failureCause: null, overBudget: 0, refusals: 0, matchedByJudge: 0 };
      if (r.failureCause === 'provider_refusal') c.refusals++;
      else c.attempts++;
      if (r.passed) c.passes++;
      else if (r.failureCause !== 'provider_refusal') c.failureCause ??= r.failureCause;
      if (r.overBudget) c.overBudget++;
      if (r.assertionResults.some((a) => a.matchedBy === 'judge')) c.matchedByJudge++;
      cells.set(k, c);
    }
    return { key, category: input.prompts[key]?.category ?? rs[0]!.category, prompt: input.prompts[key]?.prompt ?? '', cells: [...cells.values()] };
  });
  const topFailures = input.results
    .filter((r) => !r.passed && r.failureCause !== 'provider_refusal')
    .slice(0, 10)
    .map((r) => ({ taskKey: r.taskKey, model: r.model, mode: r.mode, cause: r.failureCause, detail: r.assertionResults.filter((a) => !a.passed).map((a) => a.detail).join('; ') || r.error || '' }));
  const usage: EvalReport['usage'] = {};
  for (const r of input.results) {
    const u = (usage[r.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
    u.cacheReadTokens += r.cacheReadTokens ?? 0;
    u.cacheWriteTokens += r.cacheWriteTokens ?? 0;
  }
  const judgeUsage: EvalReport['judgeUsage'] = {};
  for (const r of input.results) {
    if (!r.judgeUsage) continue;
    const u = (judgeUsage[input.judgeModel ?? r.model] ??= { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
    for (const k of ['calls', 'inputTokens', 'outputTokens', 'cacheReadTokens'] as const) u[k] += r.judgeUsage[k];
  }
  const providerRefusals = input.results.filter((r) => r.failureCause === 'provider_refusal').length;
  const { results: _r, prompts: _p, judgeModel: _j, ...rest } = input;
  return { version: 1, ...rest, categories: categoryRows(input.results), tasks, topFailures, usage, judgeUsage, providerRefusals };
}

export function renderMarkdown(rep: EvalReport): string {
  const s = rep.score;
  const lines: string[] = [];
  lines.push(`## Neurouter agent-readiness: ${rep.server.name} — **${s.headline}/100** (${s.band.replace('_', ' ')})`, '');
  const cats = rep.categories ?? [];
  if (cats.length) {
    lines.push('| Model | Mode | Category | Success | Attempts | Tokens / attempt |', '|---|---|---|---:|---:|---:|');
    for (const c of cats) lines.push(`| ${c.model} | ${c.mode} | ${c.category} | ${c.passes}/${c.attempts} (${Math.round(c.successRate * 100)}%) | ${c.attempts} | ${c.tokensPerAttempt} |`);
    lines.push('');
  }
  lines.push(`- Recommended mode: **${s.recommendedMode ?? 'n/a'}** — ${s.recommendationText}`);
  lines.push(`- Confidence: ${s.confidence}; models: ${rep.run.models.join(', ')}; modes: ${rep.run.modes.join(', ')}; repeats: ${rep.run.repeats}; environment: ${rep.run.environment}${rep.run.contract ? `; agent contract ${rep.run.contract}` : ''}${rep.run.judgeModel ? `; judge: ${rep.run.judgeModel}` : ''}${rep.run.provider === 'stub' ? ' (**stub provider — not a real model**)' : ''}`, '');
  lines.push('| Model | Mode | Score | Success | Avg tokens | of which cached | Tokens / multi-step task | Avg calls | Avg latency | Flaky |', '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const c of s.cells)
    lines.push(`| ${c.model} | ${c.mode}${c.best ? ' ★' : ''} | ${c.score} | ${Math.round(c.successRate * 100)}% | ${Math.round(c.avgTokens)} | ${Math.round(c.avgCachedTokens ?? 0)} | ${c.avgTokensMulti === null ? '–' : Math.round(c.avgTokensMulti)} | ${c.avgCalls.toFixed(1)} | ${Math.round(c.avgLatencyMs)} ms | ${c.flakyTasks} |`);
  lines.push('', '_Tokens = uncached input + cached input + output, summed over the turns of an attempt (the same for every provider); "of which cached" is input read from the provider\'s prompt cache._');
  const over = s.cells.reduce((a, c) => a + (c.overBudget ?? 0), 0);
  if (over) lines.push('', `_${over} counted attempt(s) went over their call budget (soft: reported as efficiency, not failed)._`);
  if (rep.providerRefusals) lines.push('', `_${rep.providerRefusals} attempt(s) were refused by the model provider's policy filter (\`provider_refusal\`) and excluded from scoring._`);
  if (rep.incomplete) lines.push('', `**Incomplete run:** ${rep.incomplete.reason}; ${rep.incomplete.attemptsRun} of ${rep.incomplete.attemptsPlanned} attempts ran. Scores cover only those.`);
  const ju = Object.entries(rep.judgeUsage ?? {});
  if (ju.length) lines.push('', `Judge usage: ${ju.map(([m, u]) => `${m}: ${u.calls} calls, ${u.inputTokens + u.cacheReadTokens + u.outputTokens} tokens (input ${u.inputTokens}, cached ${u.cacheReadTokens}, output ${u.outputTokens})`).join('; ')}.`);
  if (rep.calibration) {
    const c = rep.calibration;
    lines.push('', `Calibration (mock data v${c.mockDataVersion}): ${c.passed} tasks passed with their own reference solution, ${c.rejected} rejected (not run), ${c.flagged} flagged for review${c.model ? ` by ${c.model}` : ''}.`);
    for (const t of c.tasks.filter((x) => x.status !== 'passed')) lines.push(`- \`${t.key}\` ${t.status}: ${t.reasons.join('; ').slice(0, 300)}`);
  }
  lines.push('', '### Score breakdown', '', '| Component | Weight | Score | Detail |', '|---|---:|---:|---|');
  for (const b of s.breakdown) lines.push(`| ${b.label} | ${b.weight} | ${Math.round(b.score * 100)}% | ${b.detail} |`);
  if (rep.generator) {
    const u = rep.generator.usage;
    lines.push('', `Suite generated by ${rep.generator.model}: ${rep.generator.tasks} tasks, ${u.calls} calls, ${u.totalTokens} tokens (input ${u.inputTokens}, cached ${u.cacheReadTokens}, output ${u.outputTokens}; budget ${u.budgetTokens})${rep.generator.diagnostics ? `, ${rep.generator.diagnostics} rejected or short` : ''}.`);
    if (rep.generator.coverage) lines.push('', `Coverage by tag: ${Object.entries(rep.generator.coverage).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}.`);
  }
  if (rep.topFailures.length) {
    lines.push('', '### Top failures', '');
    for (const f of rep.topFailures) lines.push(`- \`${f.taskKey}\` (${f.model}, ${f.mode}): ${f.cause ?? 'failed'} — ${f.detail.slice(0, 200)}`);
  }
  if (rep.suggestions.length) {
    lines.push('', '### Suggested fixes', '');
    for (const sg of rep.suggestions) lines.push(`- **${sg.kind}** ${sg.tools.join(', ')} (+${sg.predictedDelta} pts predicted, ${sg.affectedTaskKeys.length} tasks): ${sg.rationale}`);
  }
  return `${lines.join('\n')}\n`;
}

/** Plain-text table for the terminal. */
export function renderTable(rep: EvalReport): string {
  const s = rep.score;
  const cats = rep.categories ?? [];
  const catRows = [['model', 'mode', 'category', 'success', 'attempts', 'tokens/attempt'], ...cats.map((c) => [c.model, c.mode, c.category, `${c.passes}/${c.attempts} (${Math.round(c.successRate * 100)}%)`, String(c.attempts), String(c.tokensPerAttempt)])];
  const cw = catRows[0]!.map((_, i) => Math.max(...catRows.map((r) => r[i]!.length)));
  const catTable = cats.length ? `${catRows.map((r) => r.map((x, i) => x.padEnd(cw[i]!)).join('  ').trimEnd()).join('\n')}\n\n` : '';
  const rows = [['model', 'mode', 'score', 'success', 'tokens', 'cached', 'tokens/multi', 'calls'], ...s.cells.map((c) => [c.model, c.mode + (c.best ? '*' : ''), String(c.score), `${Math.round(c.successRate * 100)}%`, String(Math.round(c.avgTokens)), String(Math.round(c.avgCachedTokens ?? 0)), c.avgTokensMulti === null ? '-' : String(Math.round(c.avgTokensMulti)), c.avgCalls.toFixed(1)])];
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const table = rows.map((r) => r.map((x, i) => x.padEnd(w[i]!)).join('  ')).join('\n');
  const fails = rep.topFailures.slice(0, 5).map((f) => `  - ${f.taskKey} [${f.mode}] ${f.cause ?? ''}`).join('\n');
  const judge = Object.values(rep.judgeUsage ?? {}).reduce((a, u) => a + u.inputTokens + u.cacheReadTokens + u.outputTokens, 0);
  const notes = [
    rep.run.contract ? `agent contract ${rep.run.contract}` : '',
    rep.incomplete ? `INCOMPLETE: ${rep.incomplete.reason} (${rep.incomplete.attemptsRun}/${rep.incomplete.attemptsPlanned} attempts)` : '',
    rep.providerRefusals ? `${rep.providerRefusals} provider refusal(s) excluded` : '',
    judge ? `judge tokens: ${judge}` : '',
    rep.calibration?.rejected ? `${rep.calibration.rejected} task(s) rejected by calibration` : '',
  ].filter(Boolean);
  return `${catTable}${table}\n\nHeadline: ${s.headline}/100 (${s.band}) · recommended: ${s.recommendedMode ?? 'n/a'} · ${s.recommendationText}${notes.length ? `\n${notes.join(' · ')}` : ''}${fails ? `\nTop failures:\n${fails}` : ''}\n`;
}
