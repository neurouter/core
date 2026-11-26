import { describe, expect, it } from 'vitest';
import { buildReport, renderMarkdown, renderTable } from './report.js';
import { recordFromTranscript, regradeSummary, regradeTranscripts, unredactCalls, type TranscriptEntry } from './regrade.js';
import { call, result, task } from './test/fixtures.js';
import type { ReadinessScore } from './types.js';

const entry = (p: Partial<TranscriptEntry>): TranscriptEntry => ({
  taskKey: 'coupon',
  model: 'm',
  mode: 'tool',
  attempt: 1,
  passed: false,
  transcript: [
    { kind: 'user', text: 'Is coupon_3 valid?' },
    { kind: 'tool_call', id: '1', name: 'call_tool', arguments: { name: 'get_coupon', arguments: { coupon: 'coupon_3', secret_name: 's1' } } },
    { kind: 'tool_result', id: '1', name: 'call_tool', isError: false, text: '{"id":"coupon_3","valid":false}' },
    { kind: 'assistant', text: 'Coupon coupon_3 is not valid.' },
  ],
  calls: [call('get_coupon', { coupon: 'coupon_3', secret_name: { $redacted: 'sensitive-key' } })],
  ...p,
});

describe('offline re-grade', () => {
  it('rebuilds the record: final answer, agent calls, redacted arguments recovered from the agent side', () => {
    const rec = recordFromTranscript(entry({}));
    expect(rec.finalAnswer).toBe('Coupon coupon_3 is not valid.');
    expect(rec.calls[0]!.arguments).toEqual({ coupon: 'coupon_3', secret_name: 's1' });
    // inner script calls stay redacted (their arguments are not in the transcript)
    expect(unredactCalls([call('x', { k: { $redacted: 'r' } }, { via: 'script' })], [])[0]!.arguments).toEqual({ k: { $redacted: 'r' } });
  });

  it('re-scores with the ground truth: the old literal "false" failure now passes; refusals are excluded', async () => {
    const t = task({ key: 'coupon', category: 'single', referenceCalls: [{ tool: 'get_coupon', arguments: { coupon: 'coupon_3' } }], assertions: [{ type: 'called', tool: 'get_coupon', args: { coupon: 'coupon_3', secret_name: 's1' } }, { type: 'answer_contains', from: 'ref[0].data.valid', anyOf: ['false'] }] });
    const out = await regradeTranscripts([entry({}), entry({ attempt: 2, endReason: 'refusal', transcript: [] }), entry({ taskKey: 'gone' })], {
      tasks: new Map([[t.key, t]]),
      groundTruth: async () => ({ refs: [{ tool: 'get_coupon', ok: true, data: { id: 'coupon_3', valid: false } }] }),
    });
    expect(out.rows.map((r) => [r.newPassed, r.excluded])).toEqual([
      [true, false],
      [false, true],
    ]);
    expect(out.skippedTasks).toEqual(['gone']);
    expect(regradeSummary(out.rows)).toMatchObject({ attempts: 2, oldPassRate: 0, newPassRate: 1, excluded: 1, flipsUp: 1 });
  });
});

describe('report (0.2.2)', () => {
  it('reports judge usage, refusals, over-budget, incomplete runs and calibration', () => {
    const score = { headline: 70, band: 'needs_work', recommendedMode: 'tool', recommendationText: 'x', confidence: 'measured', modeScores: {}, cells: [{ model: 'm', mode: 'tool', score: 70, components: [], successRate: 1, categorySuccess: {}, avgTokens: 1, avgCachedTokens: 0, avgCalls: 1, avgLatencyMs: 1, avgTokensMulti: null, flakyTasks: 0, attempts: 1, excludedFallback: 0, overBudget: 1, best: true }], breakdown: [] } as unknown as ReadinessScore;
    const rep = buildReport({
      server: { slug: 's', name: 's' },
      run: { id: null, models: ['m'], modes: ['tool'], repeats: 1, environment: 'mock', buildHash: null, provider: 'openai', startedAt: 'a', endedAt: 'b' },
      score,
      suggestions: [],
      judgeModel: 'judge-m',
      results: [result({ taskKey: 'a', overBudget: true, judgeUsage: { calls: 2, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } }), result({ taskKey: 'b', passed: false, failureCause: 'provider_refusal' })],
      prompts: {},
      incomplete: { reason: '--max-run-tokens 10 reached', attemptsRun: 2, attemptsPlanned: 4 },
      calibration: { mockDataVersion: 2, passed: 1, rejected: 1, flagged: 0, model: null, tasks: [{ key: 'x', status: 'rejected', reasons: ['reference call 1 failed'] }] },
    });
    expect(rep.judgeUsage).toEqual({ 'judge-m': { calls: 2, inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 } });
    expect(rep.providerRefusals).toBe(1);
    expect(rep.topFailures).toEqual([]);
    expect(rep.tasks.find((x) => x.key === 'b')!.cells[0]).toMatchObject({ attempts: 0, refusals: 1 });
    const md = renderMarkdown(rep);
    expect(md).toContain('Incomplete run');
    expect(md).toContain('Judge usage: judge-m: 2 calls, 110 tokens');
    expect(md).toContain('`provider_refusal`');
    expect(md).toContain('`x` rejected: reference call 1 failed');
    expect(md).toContain('over their call budget');
    expect(renderTable(rep)).toContain('INCOMPLETE');
  });
});
