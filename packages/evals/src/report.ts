import type { Suggestion } from './suggest.js';
import type { ReadinessScore, TaskRunResult } from './types.js';

/** CLI/CI report (`EvalReport` ≈ EvalRunDetail + suggestions, §15.8). */
export interface EvalReport {
  version: 1;
  server: { slug: string; name: string };
  run: { id: string | null; models: string[]; modes: string[]; repeats: number; environment: string; buildHash: string | null; provider: string; startedAt: string; endedAt: string };
  score: ReadinessScore;
  tasks: Array<{ key: string; category: string; prompt: string; cells: Array<{ model: string; mode: string; passes: number; attempts: number; failureCause: string | null }> }>;
  topFailures: Array<{ taskKey: string; model: string; mode: string; cause: string | null; detail: string }>;
  suggestions: Suggestion[];
  usage: Record<string, { inputTokens: number; outputTokens: number }>;
}

export function buildReport(input: Omit<EvalReport, 'version' | 'tasks' | 'topFailures' | 'usage'> & { results: TaskRunResult[]; prompts: Record<string, { category: string; prompt: string }> }): EvalReport {
  const byTask = new Map<string, TaskRunResult[]>();
  for (const r of input.results) byTask.set(r.taskKey, [...(byTask.get(r.taskKey) ?? []), r]);
  const tasks = [...byTask.entries()].map(([key, rs]) => {
    const cells = new Map<string, { model: string; mode: string; passes: number; attempts: number; failureCause: string | null }>();
    for (const r of rs) {
      const k = `${r.model}|${r.mode}`;
      const c = cells.get(k) ?? { model: r.model, mode: r.mode, passes: 0, attempts: 0, failureCause: null };
      c.attempts++;
      if (r.passed) c.passes++;
      else c.failureCause ??= r.failureCause;
      cells.set(k, c);
    }
    return { key, category: input.prompts[key]?.category ?? rs[0]!.category, prompt: input.prompts[key]?.prompt ?? '', cells: [...cells.values()] };
  });
  const topFailures = input.results
    .filter((r) => !r.passed)
    .slice(0, 10)
    .map((r) => ({ taskKey: r.taskKey, model: r.model, mode: r.mode, cause: r.failureCause, detail: r.assertionResults.filter((a) => !a.passed).map((a) => a.detail).join('; ') || r.error || '' }));
  const usage: EvalReport['usage'] = {};
  for (const r of input.results) {
    const u = (usage[r.model] ??= { inputTokens: 0, outputTokens: 0 });
    u.inputTokens += r.inputTokens;
    u.outputTokens += r.outputTokens;
  }
  const { results: _r, prompts: _p, ...rest } = input;
  return { version: 1, ...rest, tasks, topFailures, usage };
}

export function renderMarkdown(rep: EvalReport): string {
  const s = rep.score;
  const lines: string[] = [];
  lines.push(`## Neurouter agent-readiness: ${rep.server.name} — **${s.headline}/100** (${s.band.replace('_', ' ')})`, '');
  lines.push(`- Recommended mode: **${s.recommendedMode ?? 'n/a'}** — ${s.recommendationText}`);
  lines.push(`- Confidence: ${s.confidence}; models: ${rep.run.models.join(', ')}; modes: ${rep.run.modes.join(', ')}; repeats: ${rep.run.repeats}; environment: ${rep.run.environment}${rep.run.provider === 'stub' ? ' (**stub provider — not a real model**)' : ''}`, '');
  lines.push('| Model | Mode | Score | Success | Avg tokens | Avg calls | Avg latency | Flaky |', '|---|---|---:|---:|---:|---:|---:|---:|');
  for (const c of s.cells) lines.push(`| ${c.model} | ${c.mode}${c.best ? ' ★' : ''} | ${c.score} | ${Math.round(c.successRate * 100)}% | ${Math.round(c.avgTokens)} | ${c.avgCalls.toFixed(1)} | ${Math.round(c.avgLatencyMs)} ms | ${c.flakyTasks} |`);
  lines.push('', '### Score breakdown', '', '| Component | Weight | Score | Detail |', '|---|---:|---:|---|');
  for (const b of s.breakdown) lines.push(`| ${b.label} | ${b.weight} | ${Math.round(b.score * 100)}% | ${b.detail} |`);
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
  const rows = [['model', 'mode', 'score', 'success', 'tokens', 'calls'], ...s.cells.map((c) => [c.model, c.mode + (c.best ? '*' : ''), String(c.score), `${Math.round(c.successRate * 100)}%`, String(Math.round(c.avgTokens)), c.avgCalls.toFixed(1)])];
  const w = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const table = rows.map((r) => r.map((x, i) => x.padEnd(w[i]!)).join('  ')).join('\n');
  const fails = rep.topFailures.slice(0, 5).map((f) => `  - ${f.taskKey} [${f.mode}] ${f.cause ?? ''}`).join('\n');
  return `${table}\n\nHeadline: ${s.headline}/100 (${s.band}) · recommended: ${s.recommendedMode ?? 'n/a'} · ${s.recommendationText}${fails ? `\nTop failures:\n${fails}` : ''}\n`;
}
