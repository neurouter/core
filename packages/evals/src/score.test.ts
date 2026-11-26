import { describe, expect, it } from 'vitest';
import { attemptTokens, greater, preliminaryScore, recommend, scoreCell, scoreRun } from './score.js';
import { buildReport, renderMarkdown } from './report.js';
import { result, task } from './test/fixtures.js';
import type { CellScore } from './types.js';

const tasks = [
  task({ key: 's1', category: 'single', referenceCalls: [{ tool: 'a', arguments: {} }] }),
  task({ key: 'm1', category: 'multi', referenceCalls: [{ tool: 'a', arguments: {} }, { tool: 'b', arguments: {} }] }),
  task({ key: 'i1', category: 'impossible' }),
];

describe('scoreCell', () => {
  it('applies the §15.6 formula with renormalization when correctness is absent', () => {
    const results = [
      result({ taskKey: 's1', attempt: 1, passed: true, toolCalls: 1 }),
      result({ taskKey: 's1', attempt: 2, passed: false, framingPassed: false }),
      result({ taskKey: 'm1', category: 'multi', attempt: 1, passed: true, toolCalls: 3 }),
      result({ taskKey: 'm1', category: 'multi', attempt: 2, passed: true, toolCalls: 2 }),
      result({ taskKey: 'i1', category: 'impossible', attempt: 1, passed: true, toolCalls: 0 }),
      result({ taskKey: 'i1', category: 'impossible', attempt: 2, passed: true, toolCalls: 0 }),
    ];
    const c = scoreCell({ tasks, results, models: ['m'], modes: ['tool'], lintScore: 80 }, 'm', 'tool');
    const by = Object.fromEntries(c.components.map((x) => [x.key, x.score]));
    expect(by.success).toBeCloseTo(0.75); // (0.5 + 1) / 2
    expect(by.impossible).toBe(1);
    // passed: s1 (2/2=1), m1 (3/4, 3/3=1), i1 (1/1 ×2) → mean(1, .75, 1, 1, 1)
    expect(by.efficiency).toBeCloseTo(0.95);
    expect(by.framing).toBeCloseTo(5 / 6);
    expect(by.quality).toBe(0.8);
    expect(by.stability).toBeCloseTo(2 / 3);
    expect(by.correctness).toBeUndefined();
    const expected = (0.45 * 0.75 + 0.1 * 1 + 0.1 * 0.95 + 0.05 * (5 / 6) + 0.2 * 0.8 + 0.1 * (2 / 3)) / 1.0;
    expect(c.score).toBe(Math.round(100 * expected));
    expect(c.flakyTasks).toBe(1);
    const withCorr = scoreCell({ tasks, results, models: ['m'], modes: ['tool'], lintScore: 80, correctness: 0.5 }, 'm', 'tool');
    expect(withCorr.score).toBe(Math.round((100 * (expected + 0.1 * 0.5)) / 1.1));
  });

  it('excludes fallback-served attempts; >20% excluded → degraded confidence', () => {
    const results = [result({ taskKey: 's1', passed: true }), result({ taskKey: 's1', attempt: 2, passed: false, fallbackUsed: true }), result({ taskKey: 's1', attempt: 3, passed: false, fallbackUsed: true })];
    const s = scoreRun({ tasks: [tasks[0]!], results, models: ['m'], modes: ['tool'], lintScore: 100 });
    expect(s.cells[0]!.excludedFallback).toBe(2);
    expect(s.cells[0]!.components.find((x) => x.key === 'success')!.score).toBe(1);
    expect(s.confidence).toBe('degraded');
  });
});

const cell = (mode: 'tool' | 'code', score: number, multi: number, tokens = 1000): CellScore => ({ model: 'm', mode, score, components: [], successRate: multi, categorySuccess: { multi, single: mode === 'tool' ? 1 : 0.9 }, avgTokens: tokens, avgCachedTokens: 0, avgCalls: 1, avgLatencyMs: 1, avgTokensMulti: tokens, flakyTasks: 0, attempts: 1, excludedFallback: 0, best: false });

describe('recommend', () => {
  it('picks the higher cell', () => expect(recommend([cell('tool', 60, 0.5), cell('code', 80, 0.9, 500)]).mode).toBe('code'));
  it('ties (< 3 pts) go to tool unless code multi success is ≥ 10 pts higher', () => {
    expect(recommend([cell('tool', 70, 0.5), cell('code', 72, 0.55)]).mode).toBe('tool');
    expect(recommend([cell('tool', 70, 0.5), cell('code', 71, 0.6)]).mode).toBe('code');
  });
  it('generates the recommendation text', () => {
    const r = recommend([cell('tool', 60, 0.5, 2000), cell('code', 80, 0.9, 1000)]);
    expect(r.text).toBe('code mode: +40 pts success, −50% tokens on multi-step tasks; tool mode is better for single lookups');
  });
  it('does not call a mode better for single lookups when both pass the same share (float noise)', () => {
    // 8 single tasks × 3 repeats, 14/24 passes in both modes, spread differently over the tasks: the
    // per-task means come out as 0.5833333333333333 (tool) and 0.5833333333333334 (code)
    const singles = Array.from({ length: 8 }, (_, i) => task({ key: `s${i}`, category: 'single', referenceCalls: [{ tool: 'a', arguments: {} }] }));
    const multi = task({ key: 'm', category: 'multi', referenceCalls: [{ tool: 'a', arguments: {} }, { tool: 'b', arguments: {} }] });
    const passes = { tool: [0, 0, 0, 2, 3, 3, 3, 3], code: [0, 0, 0, 3, 3, 3, 3, 2] } as const;
    const results = (['tool', 'code'] as const).flatMap((mode) => [
      ...singles.flatMap((t, i) => [1, 2, 3].map((a) => result({ key: `${t.key}|m|${mode}|${a}`, taskKey: t.key, mode, attempt: a, passed: a <= passes[mode][i]! }))),
      ...[1, 2, 3].map((a) => result({ key: `m|m|${mode}|${a}`, taskKey: 'm', category: 'multi', mode, attempt: a, passed: true, inputTokens: mode === 'tool' ? 1000 : 3000 })),
    ]);
    const input = { tasks: [...singles, multi], results, models: ['m'], modes: ['tool', 'code'] as Array<'tool' | 'code'>, lintScore: 80 };
    const tool = scoreCell(input, 'm', 'tool');
    const code = scoreCell(input, 'm', 'code');
    expect(tool.categorySuccess.single).not.toBe(code.categorySuccess.single); // the float noise is real
    const r = scoreRun(input);
    expect(r.recommendationText).not.toContain('better for single lookups');
    expect(greater(0.5833333333333334, 0.5833333333333333)).toBe(false);
    expect(greater(15 / 24, 14 / 24)).toBe(true);
  });
  it('single mode measured', () => expect(recommend([cell('tool', 60, 0.5)]).mode).toBe('tool'));
});

describe('scoreRun', () => {
  it('headline = best mode of the primary model; bands', () => {
    const results = [result({ taskKey: 's1', mode: 'tool', passed: false }), result({ taskKey: 's1', mode: 'code', passed: true }), result({ taskKey: 's1', model: 'other', mode: 'tool', passed: true })];
    const s = scoreRun({ tasks: [tasks[0]!], results, models: ['m', 'other'], modes: ['tool', 'code'], lintScore: 90 });
    expect(s.headline).toBe(s.modeScores.code);
    expect(s.cells.filter((c) => c.best).map((c) => `${c.model}/${c.mode}`)).toEqual(['m/code', 'other/tool']);
    expect(s.band).toBe(s.headline >= 90 ? 'excellent' : s.headline >= 75 ? 'ready' : s.headline >= 50 ? 'needs_work' : 'not_ready');
    expect(s.confidence).toBe('measured');
  });
  it('preliminary score = lint', () => expect(preliminaryScore({ score: 48.6 })).toEqual({ score: 49, band: 'not_ready', confidence: 'preliminary' }));
});

describe('tokens (consistent across providers)', () => {
  it('counts uncached + cached input + output per attempt, and reports cached input separately', () => {
    const t = [task({ key: 'm1', category: 'multi', referenceCalls: [{ tool: 'a', arguments: {} }, { tool: 'b', arguments: {} }] })];
    // the same prompt and answer: OpenAI cached most of the tool list (automatic), Anthropic did not (no cache_control)
    const openai = result({ key: 'o', taskKey: 'm1', category: 'multi', model: 'gpt', inputTokens: 1_000, cacheReadTokens: 9_000, outputTokens: 200 });
    const anthropic = result({ key: 'a', taskKey: 'm1', category: 'multi', model: 'claude', inputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 200 });
    const gemini = result({ key: 'g', taskKey: 'm1', category: 'multi', model: 'gemini', inputTokens: 4_000, cacheReadTokens: 6_000, outputTokens: 200 });
    const input = { tasks: t, results: [openai, anthropic, gemini], models: ['gpt', 'claude', 'gemini'], modes: ['tool'] as Array<'tool' | 'code'>, lintScore: 80 };
    const cells = ['gpt', 'claude', 'gemini'].map((m) => scoreCell(input, m, 'tool'));
    expect(cells.map((c) => c.avgTokensMulti)).toEqual([10_200, 10_200, 10_200]);
    expect(cells.map((c) => c.avgTokens)).toEqual([10_200, 10_200, 10_200]);
    expect(cells.map((c) => c.avgCachedTokens)).toEqual([9_000, 0, 6_000]);
    expect(attemptTokens({ inputTokens: 5, outputTokens: 2 })).toBe(7);
    const rep = buildReport({ server: { slug: 's', name: 's' }, run: { id: null, models: ['gpt'], modes: ['tool'], repeats: 1, environment: 'mock', buildHash: null, provider: 'openai', startedAt: '', endedAt: '' }, score: scoreRun(input), suggestions: [], results: [openai, anthropic], prompts: {} });
    expect(rep.usage.gpt).toEqual({ inputTokens: 1_000, outputTokens: 200, cacheReadTokens: 9_000, cacheWriteTokens: 0 });
    const md = renderMarkdown(rep);
    expect(md).toContain('of which cached');
    expect(md).toContain('| 10200 | 9000 | 10200 |');
  });
});
