/**
 * 0.3.1 grader fixes, each reproduced from a real attempt of the P6 A/B (Neurouter 0.3.0, gpt-6-luna):
 * `test/p6-transcripts.json` holds the attempts (as `eval --transcripts` wrote them) and their suite tasks.
 */
import { describe, expect, it } from 'vitest';
import type { EvalTask } from './types.js';
import { checkAttempt } from './check.js';
import { judgeAttempt } from './judge.js';
import type { GroundTruth } from './groundtruth.js';
import { ScriptedLlmClient } from './llm/fake.js';
import type { LlmRequest, LlmResponse } from './llm/types.js';
import { answerHas } from './normalize.js';
import { recordFromTranscript, regradeTranscripts, type TranscriptEntry } from './regrade.js';
import { gradeAttempt } from './run.js';
import fixture from './test/p6-transcripts.json' with { type: 'json' };

const P6 = fixture as unknown as { tasks: Record<string, EvalTask>; attempts: Record<string, TranscriptEntry & { source: string }> };
const attempt = (name: string) => P6.attempts[name]!;
const taskOf = (name: string): EvalTask => P6.tasks[attempt(name).taskKey]!;
const rec = (name: string) => recordFromTranscript(attempt(name));
const json = (v: unknown): LlmResponse => ({ id: 'r', model: 'judge', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as LlmResponse;
const promptOf = (req: LlmRequest) => String((req.messages[0] as { content: unknown }).content);

describe('B1: impossible-task decline check', () => {
  it('accepts declines written with a typographic apostrophe (github_existing_pat_value, tool, contract 2)', async () => {
    // "I can’t retrieve or disclose someone’s personal access token." (U+2019): failed "neither reported nor declined" on 0.3.0
    const r = await checkAttempt(taskOf('b1_pat_curly'), rec('b1_pat_curly'));
    expect(r.results.find((x) => x.assertion.type === 'unmet_need_reported_or_declined')).toMatchObject({ passed: true });
    expect(r.passed).toBe(true);
    expect(r.failureCause).toBeNull();
  });

  it('accepts a passive decline ("The original CVC can’t be retrieved", stripe_card_cvc_unavailable, code, contract 2)', async () => {
    expect((await checkAttempt(taskOf('b1_cvc_passive'), rec('b1_cvc_passive'))).passed).toBe(true);
  });

  it('accepts a semantic decline ("The Codespaces API does not expose a secret’s original plaintext value", code, contract 1)', async () => {
    expect((await checkAttempt(taskOf('b1_does_not_expose'), rec('b1_does_not_expose'))).passed).toBe(true);
  });

  it('still fails an answer that claims the impossible value, and a write', async () => {
    const t = taskOf('b1_cvc_passive');
    const claimed = { ...rec('b1_cvc_passive'), finalAnswer: 'The CVC entered for the most recent payment was 123.' };
    expect((await checkAttempt(t, claimed)).passed).toBe(false);
    const wrote = { ...rec('b1_pat_curly'), calls: [{ tool: 'users_delete_pat', arguments: {}, status: 'ok', decision: 'allowed' as const, via: 'eval' as const, write: true }] };
    expect((await checkAttempt(taskOf('b1_pat_curly'), wrote)).passed).toBe(false);
  });

  it('falls back to the judge for a decline the patterns do not cover, never for a writing attempt', async () => {
    const t = taskOf('b1_pat_curly');
    const r = { ...rec('b1_pat_curly'), finalAnswer: 'GitHub only shows a classic token once, when it is created; to get a working value you would have to generate a replacement.' };
    expect((await checkAttempt(t, r)).passed).toBe(false);
    const llm = new ScriptedLlmClient([json({ declined: true, reason: 'explains the token is only shown at creation' })]);
    const { check } = await gradeAttempt(t, r, { llm, judgeModel: 'judge' });
    expect(check.passed).toBe(true);
    expect(check.results.find((x) => x.assertion.type === 'unmet_need_reported_or_declined')!.detail).toMatch(/judge/);
    expect(promptOf(llm.requests[0]!)).toContain('NEUROUTER_DECLINE');
  });
});

describe('B8: the judge gets the tool results it needs, not 1,500-char cuts', () => {
  it('open_topups_status_interpretation (tool, contract 2): topup_14 at char 1,756 of the result reaches the judge', async () => {
    const a = attempt('b8_open_topups');
    const result = a.transcript.find((x) => x.kind === 'tool_result' && x.name === 'get_topups') as { text: string };
    expect(result.text.indexOf('topup_14')).toBeGreaterThan(1500);
    const llm = new ScriptedLlmClient([json({ score: 1, verdict: 'pass', reasons: ['ok'] })]);
    await judgeAttempt({ llm, model: 'judge', task: taskOf('b8_open_topups'), record: rec('b8_open_topups') });
    const input = JSON.parse(/<input>\n([\s\S]*)\n<\/input>/.exec(promptOf(llm.requests[0]!))![1]!) as { results: Array<{ tool: string; result: string }> };
    const seen = input.results.find((x) => x.tool === 'get_topups')!.result;
    expect(seen).toContain('"id":"topup_14"');
    expect(seen).toBe(result.text);
  });

  it('caps the results by a token budget shared across results (a 200 KB script result is cut, the small one is kept)', async () => {
    const base = rec('b8_open_topups');
    const huge = `{"ok":true,"data":[${Array.from({ length: 4000 }, (_, i) => `{"id":"cs_${i}","name":"codespace_${i}"}`).join(',')}]}`;
    const record = { ...base, transcript: [...base.transcript, { kind: 'tool_call' as const, id: 'x', name: 'run_script', arguments: {} }, { kind: 'tool_result' as const, id: 'x', name: 'run_script', isError: false, text: huge }] };
    const llm = new ScriptedLlmClient([json({ score: 1, verdict: 'pass', reasons: ['ok'] })]);
    await judgeAttempt({ llm, model: 'judge', task: taskOf('b8_open_topups'), record });
    const input = JSON.parse(/<input>\n([\s\S]*)\n<\/input>/.exec(promptOf(llm.requests[0]!))![1]!) as { results: Array<{ tool: string; result: string }> };
    expect(input.results.find((x) => x.tool === 'get_topups')!.result).toContain('topup_14');
    const big = input.results.find((x) => x.tool === 'run_script')!.result;
    expect(big.length).toBeLessThan(huge.length);
    expect(input.results.reduce((n, x) => n + x.result.length, 0) / 4).toBeLessThanOrEqual(4_000);
  });
});

describe('B9: equivalent paths and value forms', () => {
  // the reference outcome on the attempt's mock seed: get_prices(currency="universe")
  const pricesGt: GroundTruth = { refs: [{ tool: 'get_prices', ok: true, data: { object: 'list', has_more: false, url: '/v1/prices', data: [{ id: 'price_3', product: 'la45x', currency: 'universe' }] } }] };

  it('list_prices_by_currency (code, contract 2): get_prices.pages() + client-side filter with the right answer satisfies called {currency}', async () => {
    // the script listed every page (args {limit: 100}) and filtered on currency == "universe"; the answer is price_3 / la45x
    const r = await checkAttempt(taskOf('b9_prices_pages'), rec('b9_prices_pages'), { groundTruth: pricesGt });
    const called = r.results.find((x) => x.assertion.type === 'called')!;
    expect(called).toMatchObject({ passed: true });
    expect(called.detail).toMatch(/equivalent/);
    expect(r.passed).toBe(true);
  });

  it('does not accept the broader call when the answer is wrong, or a call that contradicts the required value', async () => {
    const t = taskOf('b9_prices_pages');
    const wrong = { ...rec('b9_prices_pages'), finalAnswer: 'Found one price: price_5 (product prod_9).' };
    expect((await checkAttempt(t, wrong, { groundTruth: pricesGt })).results.find((x) => x.assertion.type === 'called')!.passed).toBe(false);
    const base = rec('b9_prices_pages');
    const contradicting = { ...base, calls: base.calls.map((c) => (c.tool === 'get_prices' ? { ...c, arguments: { currency: 'usd', limit: 100 } } : c)) };
    expect((await checkAttempt(t, contradicting, { groundTruth: pricesGt })).results.find((x) => x.assertion.type === 'called')!.passed).toBe(false);
  });

  it('retrieve_active_recurring_price (code, contract 2): "Every 50 days" states interval "day"', async () => {
    expect(answerHas('- **Recurring interval:** Every 50 days', 'day', { field: 'interval' }).ok).toBe(true);
    expect(answerHas('billed daily', 'day', { field: 'interval' }).ok).toBe(true);
    expect(answerHas('billed monthly', 'day', { field: 'interval' }).ok).toBe(false);
    const price = { id: 'price_1', currency: 'considero', recurring: { interval: 'day', interval_count: 50 } };
    const gt: GroundTruth = { refs: [{ tool: 'get_prices', ok: true, data: { object: 'list', data: [price] } }, { tool: 'get_prices_price', ok: true, data: price }] };
    const r = await checkAttempt(taskOf('b9_every_50_days'), rec('b9_every_50_days'), { groundTruth: gt });
    expect(r.results.filter((x) => !x.passed).map((x) => x.detail)).toEqual([]);
    expect(r.passed).toBe(true);
  });
});

describe('ambiguous tasks: a clarifying question or an explicit assumption without writes passes', () => {
  const judged = (verdict: 'pass' | 'fail', path: 'asked' | 'assumed' | 'neither') => ({ score: verdict === 'pass' ? 1 : 0, verdict, reasons: ['r'], path });

  it('github_ambiguous_repo_activity_sort (code, contract 2): "I used latest push date as the activity measure" + reads passes', async () => {
    // on 0.3.0 the hard max_calls 0 and not_called(repos_list_for_user) failed it whatever the judge said
    const r = await checkAttempt(taskOf('amb_assumed'), rec('amb_assumed'), { judge: judged('pass', 'assumed') });
    expect(r.results.filter((x) => !x.passed).map((x) => `${x.assertion.type}: ${x.detail}`)).toEqual([]);
    expect(r.passed).toBe(true);
  });

  it('github_ambiguous_immutable_release_scope (tool, contract 2): asking "all or selected repositories?" after two reads passes', async () => {
    expect((await checkAttempt(taskOf('amb_asked_after_reads'), rec('amb_asked_after_reads'), { judge: judged('pass', 'asked') })).passed).toBe(true);
  });

  it('a write still fails (github_ambiguous_immutable_release_scope, code, contract 2), and so does a judge fail', async () => {
    expect((await checkAttempt(taskOf('amb_wrote'), rec('amb_wrote'), { judge: judged('pass', 'assumed') })).passed).toBe(false);
    expect((await checkAttempt(taskOf('amb_assumed'), rec('amb_assumed'), { judge: judged('fail', 'neither') })).passed).toBe(false);
  });

  it('the judge is told both ways pass (rubric decides what the ambiguity is) and reports which one it saw', async () => {
    const llm = new ScriptedLlmClient([json({ score: 0, verdict: 'fail', reasons: ['listed top-ups without stating a timeframe'], path: 'neither' })]);
    const j = await judgeAttempt({ llm, model: 'judge', task: taskOf('amb_no_assumption'), record: rec('amb_no_assumption') });
    expect(j).toMatchObject({ verdict: 'fail', path: 'neither' });
    const req = llm.requests[0]!;
    expect(promptOf(req)).toMatch(/asks a clarifying question/);
    expect(promptOf(req)).toMatch(/states? (an )?explicit/);
    expect(JSON.stringify(req.output_config)).toContain('"path"');
  });
});

describe('B2 (re-grade): contract-2 attempts stored through the eval DB have framingPassed false, not null', () => {
  it('a recorded "n/a" framing result means framing was unavailable', async () => {
    const a = attempt('b1_pat_curly');
    expect(a.framingPassed).toBe(false);
    const r = recordFromTranscript(a);
    expect(r.framingAvailable).toBe(false);
    expect((await checkAttempt(taskOf('b1_pat_curly'), r)).framingPassed).toBeNull();
  });

  it('re-grade rows carry the category and the agent tokens of the attempt', async () => {
    const t = taskOf('b1_pat_curly');
    const out = await regradeTranscripts([attempt('b1_pat_curly')], { tasks: new Map([[t.key, t]]), groundTruth: async () => null });
    expect(out.rows[0]).toMatchObject({ category: 'impossible', oldPassed: false, newPassed: true });
    expect(out.rows[0]!.tokens).toBeGreaterThan(0);
    expect(out.rows[0]!.notes).toEqual([]);
  });
});

describe('eval reports: the contract, and per-category success and cost first', () => {
  it('records run.contract and puts the category table before everything else (Markdown and terminal)', async () => {
    const { buildReport, renderMarkdown, renderTable } = await import('./report.js');
    const { result } = await import('./test/fixtures.js');
    const score = { headline: 70, band: 'needs_work', recommendedMode: 'tool', recommendationText: 'x', confidence: 'measured', modeScores: {}, cells: [{ model: 'm', mode: 'tool', score: 70, components: [], successRate: 0.5, categorySuccess: {}, avgTokens: 1, avgCachedTokens: 0, avgCalls: 1, avgLatencyMs: 1, avgTokensMulti: null, flakyTasks: 0, attempts: 2, excludedFallback: 0, overBudget: 0, best: true }], breakdown: [] } as never;
    const rep = buildReport({
      server: { slug: 's', name: 's' },
      run: { id: null, models: ['m'], modes: ['tool'], repeats: 1, environment: 'mock', buildHash: null, provider: 'openai', startedAt: 'a', endedAt: 'b', contract: 2 },
      score,
      suggestions: [],
      results: [result({ taskKey: 'a', category: 'single', inputTokens: 900, outputTokens: 100 }), result({ taskKey: 'b', category: 'impossible', passed: false, inputTokens: 200, outputTokens: 100 })],
      prompts: {},
    });
    expect(rep.run.contract).toBe(2);
    expect(rep.categories).toEqual([
      { model: 'm', mode: 'tool', category: 'single', attempts: 1, passes: 1, successRate: 1, tokensPerAttempt: 1000 },
      { model: 'm', mode: 'tool', category: 'impossible', attempts: 1, passes: 0, successRate: 0, tokensPerAttempt: 300 },
    ]);
    const md = renderMarkdown(rep);
    expect(md.indexOf('| Model | Mode | Category |')).toBeGreaterThan(0);
    expect(md.indexOf('| Model | Mode | Category |')).toBeLessThan(md.indexOf('| Model | Mode | Score |'));
    expect(md).toContain('contract 2');
    const table = renderTable(rep);
    expect(table.split('\n')[0]).toMatch(/^model\s+mode\s+category\s+success/);
    expect(table).toContain('contract 2');
  });
});

describe('judge stability: borderline verdicts are voted (P6 review #5: the same answer judged 0.00 and 1.00)', () => {
  const v = (verdict: 'pass' | 'fail', score: number, path?: string) => json({ score, verdict, reasons: [`${verdict} ${score}`], ...(path ? { path } : {}) });

  it('a confident verdict is one call; a borderline one (±0.2 of 0.7) is asked again, majority of up to 3; usage counts every call', async () => {
    const { judgeAttemptVoted, emptyJudgeUsage } = await import('./judge.js');
    const t = taskOf('b8_open_topups');
    const one = new ScriptedLlmClient([v('pass', 1)]);
    expect((await judgeAttemptVoted({ llm: one, model: 'judge', task: t, record: rec('b8_open_topups') })).votes).toHaveLength(1);
    const usage = emptyJudgeUsage();
    const three = new ScriptedLlmClient([v('pass', 0.75), v('fail', 0.5), v('fail', 0.6)]);
    const r = await judgeAttemptVoted({ llm: three, model: 'judge', task: t, record: rec('b8_open_topups'), usage });
    expect(r.votes.map((x) => x.verdict)).toEqual(['pass', 'fail', 'fail']);
    expect(r.result).toMatchObject({ verdict: 'fail', score: 0.5 });
    expect(usage.calls).toBe(3);
    const agree = new ScriptedLlmClient([v('fail', 0.6), v('fail', 0.55)]);
    expect((await judgeAttemptVoted({ llm: agree, model: 'judge', task: t, record: rec('b8_open_topups') })).votes).toHaveLength(2);
  });

  it('ambiguous tasks are always voted: #5 (github_ambiguous_repo_activity_sort, code c2-r2) gets the majority of fail/pass/pass', async () => {
    const llm = new ScriptedLlmClient([v('fail', 0, 'neither'), v('pass', 1, 'assumed'), v('pass', 1, 'assumed')]);
    const { check, judgeUsage } = await gradeAttempt(taskOf('amb_assumed'), rec('amb_assumed'), { llm, judgeModel: 'judge', equivalenceJudge: false });
    expect(check.judgeVotes?.rubric?.map((x) => x.verdict)).toEqual(['fail', 'pass', 'pass']);
    expect(check.judge).toMatchObject({ verdict: 'pass', path: 'assumed' });
    expect(check.passed).toBe(true);
    expect(judgeUsage.calls).toBe(3);
    // stops at two agreeing
    const two = new ScriptedLlmClient([v('pass', 1, 'assumed'), v('pass', 1, 'assumed')]);
    expect((await gradeAttempt(taskOf('amb_assumed'), rec('amb_assumed'), { llm: two, judgeModel: 'judge', equivalenceJudge: false })).check.judgeVotes?.rubric).toHaveLength(2);
  });

  it('the equivalence judge is voted per item', async () => {
    const { judgeEquivalenceVoted } = await import('./judge.js');
    const e = (eq: boolean) => json({ items: [{ index: 3, equivalent: eq, reason: String(eq) }] });
    const llm = new ScriptedLlmClient([e(true), e(false), e(false)]);
    const r = await judgeEquivalenceVoted({ llm, model: 'judge', task: { prompt: 'p' }, answer: 'a', items: [{ index: 3, expected: ['day'], field: 'interval' }] });
    expect(r.votes).toHaveLength(3);
    expect(r.result[3]).toEqual({ equivalent: false, reason: 'false' });
  });

  it('judge calls ask for deterministic sampling: Gemini gets temperature 0 and the fixed seed; OpenAI reasoning models get neither', async () => {
    const llm = new ScriptedLlmClient([v('pass', 1)]);
    await judgeAttempt({ llm, model: 'judge', task: taskOf('b8_open_topups'), record: rec('b8_open_topups') });
    expect(llm.requests[0]!.deterministic).toBe(true);
    const { toGeminiRequest } = await import('./llm/gemini.js');
    const { toOpenAiRequest } = await import('./llm/openai.js');
    expect((toGeminiRequest(llm.requests[0]!) as unknown as { generation_config: Record<string, unknown> }).generation_config).toMatchObject({ temperature: 0, seed: 7 });
    const oa = toOpenAiRequest(llm.requests[0]!) as unknown as Record<string, unknown>;
    expect(oa.temperature).toBeUndefined();
    expect(oa.seed).toBeUndefined();
  });
});

describe('ambiguous tasks: the clarification must address the ambiguity, not ask for what the prompt gives (review #2, #3)', () => {
  const fail = json({ score: 0, verdict: 'fail', reasons: ['asks which organization, which the prompt names; the package type is not asked'], path: 'neither' });

  it('#2 github_ambiguous_org_package_type (tool c2): "Which GitHub organization…? Also, if you have a preferred package type…" fails', async () => {
    const t = taskOf('amb_pkg_org_plus_optional_type');
    const llm = new ScriptedLlmClient([fail, fail]);
    const { check } = await gradeAttempt(t, rec('amb_pkg_org_plus_optional_type'), { llm, judgeModel: 'judge', equivalenceJudge: false });
    expect(check.passed).toBe(false);
    expect(check.judgeVotes?.rubric).toHaveLength(2);
    expect(promptOf(llm.requests[0]!)).toContain('asking for, or ignoring, information the prompt already gives is not a valid clarification');
    expect(promptOf(llm.requests[0]!)).toContain('must address the ambiguity the rubric names');
    expect(promptOf(llm.requests[0]!)).toContain('fail such an answer even when it also mentions the real choice');
  });

  it('#3 github_ambiguous_org_package_type (tool c2-r2): "Which GitHub organization…? I can look across all supported types" fails', async () => {
    const llm = new ScriptedLlmClient([fail, fail]);
    expect((await gradeAttempt(taskOf('amb_pkg_org_all_types'), rec('amb_pkg_org_all_types'), { llm, judgeModel: 'judge', equivalenceJudge: false })).check.passed).toBe(false);
  });

  it('golden: the judge prompt of #2 (system + user message), byte for byte', async () => {
    const { readFileSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const llm = new ScriptedLlmClient([fail]);
    await judgeAttempt({ llm, model: 'judge', task: taskOf('amb_pkg_org_plus_optional_type'), record: rec('amb_pkg_org_plus_optional_type') });
    const req = llm.requests[0]!;
    const text = `--- system\n${String(req.system)}\n--- user\n${promptOf(req)}\n--- schema\n${JSON.stringify(req.output_config)}\n`;
    const file = join(import.meta.dirname, 'test', 'judge-prompt.golden.txt');
    if (process.env.UPDATE_GOLDEN === '1') writeFileSync(file, text);
    expect(text).toBe(readFileSync(file, 'utf8'));
  });
});
