import { describe, expect, it } from 'vitest';
import type { Assertion } from '@neurouter/shared';
import { argsMatchNormalized, argsSubset, checkAttempt, classifyFailure, failedAnswerExpectations, framingOk, primaryTool } from './check.js';
import type { GroundTruth } from './groundtruth.js';
import { call, record, task } from './test/fixtures.js';

const framedAgent = [
  { name: 'neurouter_begin_task', arguments: {}, isError: false, latencyMs: 1 },
  { name: 'get_pet_by_id', arguments: { petId: 1 }, isError: false, latencyMs: 1 },
  { name: 'neurouter_end_task', arguments: {}, isError: false, latencyMs: 1 },
];

describe('checkAttempt', () => {
  it('called: subset/exact args, minTimes, inner script calls', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id', args: { petId: 1 } }, { type: 'called', tool: 'list_pets', minTimes: 2 }, { type: 'called', tool: 'add_pet', args: { name: 'x' }, argsMatch: 'exact' }] });
    const rec = record({
      calls: [call('get_pet_by_id', { petId: '1', extra: true }, { via: 'script', scriptRunId: 's1' }), call('list_pets'), call('list_pets'), call('add_pet', { name: 'x', tag: 'y' })],
    });
    const r = await checkAttempt(t, rec);
    expect(r.results.map((x) => x.passed)).toEqual([true, true, false]);
    expect(r.passed).toBe(false);
  });

  it('not_called, no_writes (dry runs and blocked writes are not writes), hard max_calls', async () => {
    const t = task({ assertions: [{ type: 'not_called', tool: 'delete_pet' }, { type: 'no_writes' }, { type: 'max_calls', n: 2, hard: true }] });
    const rec = record({ toolCallsByAgent: 2, calls: [call('add_pet', {}, { write: true, decision: 'dry_run' }), call('add_pet', {}, { write: true, decision: 'denied_read_only', status: 'blocked' })] });
    expect((await checkAttempt(t, rec)).passed).toBe(true);
    const rec2 = record({ toolCallsByAgent: 3, calls: [call('add_pet', {}, { write: true }), call('delete_pet'), call('list_pets')] });
    expect((await checkAttempt(t, rec2)).results.map((x) => x.passed)).toEqual([false, false, false]);
  });

  it('max_calls counts upstream API calls only: inner script calls yes; search_tools, run_script, ops and invalid_args no', async () => {
    // regression: real code-mode runs followed the server instructions (search_tools, then run_script) and failed "2 calls (max 1)"
    const t = task({ assertions: [{ type: 'called', tool: 'get_order_by_id', args: { order_id: 1 } }, { type: 'max_calls', n: 1 }] });
    const calls = [call('neurouter_begin_task'), call('search_tools'), call('run_script'), call('get_order_by_id', { order_id: 1 }, { via: 'script', scriptRunId: 's1' }), call('get_order_by_id', { order_id: 'x' }, { status: 'invalid_args' }), call('neurouter_read_result')];
    const ok = await checkAttempt(t, record({ toolCallsByAgent: 3, calls }));
    expect(ok).toMatchObject({ passed: true, upstreamCalls: 1, callBudget: 1, overBudget: false });
    expect(ok.results[1]!.detail).toBe('1 upstream calls (budget 1)');
  });

  it('max_calls is soft: over budget passes (reported), a runaway beyond max(10, 4n) fails as over_budget; n: 0 is strict', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'list_pets' }, { type: 'max_calls', n: 3 }] });
    const many = (n: number) => Array.from({ length: n }, () => call('list_pets'));
    const over = await checkAttempt(t, record({ calls: many(6) }));
    expect(over).toMatchObject({ passed: true, overBudget: true, failureCause: null });
    expect(over.results[1]).toMatchObject({ passed: true, overBudget: true });
    const runaway = await checkAttempt(t, record({ calls: many(13) }));
    expect(runaway).toMatchObject({ passed: false, failureCause: 'over_budget' });
    const zero = task({ category: 'ambiguous', assertions: [{ type: 'max_calls', n: 0 }] });
    expect((await checkAttempt(zero, record({ calls: many(1) }))).passed).toBe(false);
    expect((await checkAttempt(zero, record())).passed).toBe(true);
  });

  it('state via the injected reader', async () => {
    const t = task({ assertions: [{ type: 'state', resource: 'pets', where: { name: 'Rex' }, expect: 'exists' }, { type: 'state', resource: 'pets', where: { name: 'Zed' }, expect: { count: 0 } }] });
    const r = await checkAttempt(t, record(), { stateReader: (_res, _s, where) => (where.name === 'Rex' ? [{ id: 1 }] : []) });
    expect(r.passed).toBe(true);
    expect((await checkAttempt(t, record())).passed).toBe(false);
  });

  it('answer_contains / answer_matches', async () => {
    const t = task({ assertions: [{ type: 'answer_contains', anyOf: ['REX'], caseInsensitive: true }, { type: 'answer_matches', regex: 'id\\s*1' }] });
    expect((await checkAttempt(t, record({ finalAnswer: 'Found rex with id 1' }))).passed).toBe(true);
    expect((await checkAttempt(t, record({ finalAnswer: 'nothing' }))).passed).toBe(false);
  });

  it('unmet_need_reported_or_declined', async () => {
    const t = task({ category: 'impossible', assertions: [{ type: 'unmet_need_reported_or_declined' }] });
    expect((await checkAttempt(t, record({ calls: [call('neurouter_report_unmet_need', { intent: 'sms' })] }))).passed).toBe(true);
    expect((await checkAttempt(t, record({ finalAnswer: "Sorry, I can't send SMS with these tools." }))).passed).toBe(true);
    expect((await checkAttempt(t, record({ finalAnswer: 'Done!' }))).passed).toBe(false);
    expect((await checkAttempt(t, record({ finalAnswer: "I can't", calls: [call('add_pet', {}, { write: true })] }))).passed).toBe(false);
  });

  it('framing is scored separately and does not fail the run', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id' }, { type: 'framing' }] });
    const ok = await checkAttempt(t, record({ agentCalls: framedAgent, calls: [call('get_pet_by_id')] }));
    expect(ok).toMatchObject({ passed: true, framingPassed: true, failureCause: null });
    const nof = await checkAttempt(t, record({ agentCalls: [framedAgent[1]!], calls: [call('get_pet_by_id')] }));
    expect(nof).toMatchObject({ passed: true, framingPassed: false, failureCause: 'no_framing' });
    expect(framingOk(record({ agentCalls: [framedAgent[1]!, framedAgent[0]!, framedAgent[2]!] }))).toBe(false);
  });

  it('judge assertions use the supplied verdict', async () => {
    const t = task({ assertions: [{ type: 'judge', criterion: 'asks' }] });
    expect((await checkAttempt(t, record(), { judge: { score: 0.9, verdict: 'pass', reasons: [] } })).passed).toBe(true);
    expect((await checkAttempt(t, record(), { judge: { score: 0.6, verdict: 'pass', reasons: [] } })).passed).toBe(false);
    expect((await checkAttempt(t, record())).passed).toBe(false);
  });
});

describe('classifyFailure (first match)', () => {
  const t = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id', args: { petId: 1 } }], referenceCalls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 } }] });
  const cause = async (rec: ReturnType<typeof record>, tt = t) => (await checkAttempt(tt, rec)).failureCause;
  it('policy_blocked', async () => expect(await cause(record({ calls: [call('get_pet_by_id', { petId: 1 }, { decision: 'denied_policy', status: 'blocked' })] }))).toBe('policy_blocked'));
  it('bad_arguments', async () => expect(await cause(record({ calls: [call('get_pet_by_id', { petId: 9 })] }))).toBe('bad_arguments'));
  it('bad_arguments on invalid_args', async () => expect(await cause(record({ calls: [call('get_pet_by_id', { petId: 1 }, { status: 'invalid_args' })] }))).toBe('bad_arguments'));
  it('wrong_tool', async () => expect(await cause(record({ calls: [call('list_pets')] }))).toBe('wrong_tool'));
  it('hallucinated', async () => {
    const imp = task({ category: 'impossible', assertions: [{ type: 'no_writes' }] });
    expect(await cause(record({ finalAnswer: 'Sent!', calls: [call('add_pet', {}, { write: true })] }), imp)).toBe('hallucinated');
  });
  it('missing_capability', async () => expect(await cause(record({ calls: [call('neurouter_report_unmet_need')] }))).toBe('missing_capability'));
  it('over_budget', async () => expect(await cause(record({ endReason: 'max_turns' }))).toBe('over_budget'));
  it('gave_up', async () => expect(await cause(record({ endReason: 'end_turn' }))).toBe('gave_up'));
  it('over_budget, not gave_up, when a finished attempt only misses a hard max_calls', async () => {
    const tb = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id' }, { type: 'max_calls', n: 1, hard: true }] });
    expect(await cause(record({ endReason: 'end_turn', calls: [call('get_pet_by_id', { petId: 1 }), call('get_pet_by_id', { petId: 1 })] }), tb)).toBe('over_budget');
  });

  it('provider_refusal for refusals and policy-filter errors; error for other errors', async () => {
    const r = await checkAttempt(t, record({ endReason: 'refusal', calls: [call('get_pet_by_id', { petId: 1 })] }));
    expect(r).toMatchObject({ passed: false, failureCause: 'provider_refusal' });
    const flagged = await checkAttempt(t, record({ endReason: 'error', error: "400 Invalid prompt: your prompt was flagged as potentially violating our usage policy (invalid_prompt)" }));
    expect(flagged.failureCause).toBe('provider_refusal');
    expect(classifyFailure(t, record({ endReason: 'error', error: 'ECONNRESET' }), { passed: false, results: [], framingPassed: null })).toBe('error');
  });
  it('primaryTool', async () => {
    const rec = record({ calls: [call('list_pets')] });
    expect(primaryTool(t, rec, await checkAttempt(t, rec))).toBe('get_pet_by_id');
  });
});

describe('argsSubset', () => {
  it('compares nested values loosely for numbers', () => {
    expect(argsSubset({ a: { b: [1, 2] } }, { a: { b: [1, 2], c: 3 } })).toBe(true);
    expect(argsSubset({ a: 1 }, { a: '1' })).toBe(true);
    expect(argsSubset({ a: [1] }, { a: [1, 2] })).toBe(false);
  });
});

describe('called: required arguments, normalization, alternatives, $from', () => {
  it('matches required args only (paging never), normalized types and case, arrays as sets', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'list_repos', args: { owner: 'octocat', repo: 'Hello-World', per_page: 10, active: true, labels: ['bug'] } }] });
    const r = await checkAttempt(t, record({ calls: [call('list_repos', { owner: 'OctoCat', repo: 'hello-world', per_page: 100, active: 'true', labels: 'bug,docs' })] }));
    expect(r.passed).toBe(true);
    expect(argsMatchNormalized({ n: 5 }, { n: '5' })).toBe(true);
    expect(argsMatchNormalized({ a: { gte: 50 } }, { a: { gte: '50', lte: 99 } })).toBe(true);
    expect(argsMatchNormalized({ n: 5 }, { n: 6 })).toBe(false);
  });

  it('accepts equivalent tools (anyOf)', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'agents_get_repo_public_key', anyOf: [{ tool: 'actions_get_repo_public_key' }] }] });
    expect((await checkAttempt(t, record({ calls: [call('actions_get_repo_public_key')] }))).passed).toBe(true);
    expect((await checkAttempt(t, record({ calls: [call('list_pets')] }))).failureCause).toBe('wrong_tool');
  });

  it('resolves {$from} against the ground truth; reports redacted recorded arguments', async () => {
    const gt: GroundTruth = { refs: [{ tool: 'list_refunds', ok: true, data: { data: [{ id: 'refund_7' }] } }] };
    const t = task({ assertions: [{ type: 'called', tool: 'get_refund', args: { refund: { $from: 'ref[0].data.data[0].id' } } }], referenceCalls: [{ tool: 'list_refunds', arguments: {} }] });
    expect((await checkAttempt(t, record({ calls: [call('get_refund', { refund: 'refund_7' })] }), { groundTruth: gt })).passed).toBe(true);
    expect((await checkAttempt(t, record({ calls: [call('get_refund', { refund: 'refund_1' })] }), { groundTruth: gt })).passed).toBe(false);
    const red = await checkAttempt(task({ assertions: [{ type: 'called', tool: 'get_secret', args: { secret_name: 's' } }] }), record({ calls: [call('get_secret', { secret_name: { $redacted: 'sensitive-key' } })] }));
    expect(red.results[0]!.detail).toContain('redacted');
  });
});

describe('answer_contains: ground truth, normalization, judge fallback', () => {
  const gt: GroundTruth = {
    refs: [{ tool: 'get_coupon', ok: true, data: { id: 'coupon_3', valid: false, amount_off: 1250, currency: 'usd', created_at: '2025-09-23T05:04:19.330Z', wallet: 'apple_pay', items: [{ id: 'a_1' }, { id: 'a_2' }] } }],
  };
  const t = (a: Assertion) => task({ assertions: [a], referenceCalls: [{ tool: 'get_coupon', arguments: {} }] });
  const check = (a: Assertion, answer: string, opts = {}) => checkAttempt(t(a), record({ finalAnswer: answer }), { groundTruth: gt, ...opts });

  it('booleans, minor units, dates, enum-like values', async () => {
    expect((await check({ type: 'answer_contains', from: 'ref[0].data.valid' }, 'The coupon is not valid.')).passed).toBe(true);
    expect((await check({ type: 'answer_contains', from: 'ref[0].data.valid' }, 'The coupon is valid.')).passed).toBe(false);
    expect((await check({ type: 'answer_contains', from: 'ref[0].data.amount_off' }, 'It takes $12.50 off.')).passed).toBe(true);
    expect((await check({ type: 'answer_contains', from: 'ref[0].data.created_at' }, 'Created September 23, 2025 at 05:04:19 UTC.')).passed).toBe(true);
    const r = await check({ type: 'answer_contains', from: 'ref[0].data.wallet' }, 'Wallet: Apple Pay');
    expect(r.results[0]).toMatchObject({ passed: true, matchedBy: 'normalized' });
  });

  it('wildcards need every value (match all); literal hints are used without ground truth', async () => {
    expect((await check({ type: 'answer_contains', from: 'ref[0].data.items[*].id' }, 'a_1 and a_2')).passed).toBe(true);
    expect((await check({ type: 'answer_contains', from: 'ref[0].data.items[*].id' }, 'only a_1')).passed).toBe(false);
    const noGt = await checkAttempt(t({ type: 'answer_contains', from: 'ref[0].data.id', anyOf: ['coupon_3'] }), record({ finalAnswer: 'coupon_3' }));
    expect(noGt.results[0]!.detail).toContain('hint');
    expect(noGt.passed).toBe(true);
  });

  it('a failed normalized match passes when the equivalence judge rules it stated (matched_by: judge)', async () => {
    const a: Assertion = { type: 'answer_contains', from: 'ref[0].data.wallet' };
    const failed = await check(a, 'paid with the Apple wallet');
    expect(failed.passed).toBe(false);
    expect(failedAnswerExpectations(t(a), failed, gt)).toEqual([{ index: 0, expected: ['apple_pay'], field: 'wallet' }]);
    const judged = await check(a, 'paid with the Apple wallet', { equivalence: { 0: { equivalent: true, reason: 'names Apple Pay' } } });
    expect(judged.results[0]).toMatchObject({ passed: true, matchedBy: 'judge' });
  });

  it('J1: an exact value (id, number, money) that fails normalized matching is never overruled by the equivalence judge', async () => {
    // ids: "the third coupon" is not coupon_3; the judge is not asked, and a recorded "equivalent" ruling is ignored
    const id: Assertion = { type: 'answer_contains', from: 'ref[0].data.id' };
    const failed = await check(id, 'the third coupon');
    expect(failedAnswerExpectations(t(id), failed, gt)).toEqual([]);
    const judged = await check(id, 'the third coupon', { equivalence: { 0: { equivalent: true, reason: 'names coupon 3' } } });
    expect(judged.results[0]).toMatchObject({ passed: false });
    expect(judged.results[0]!.detail).toContain('exact value');
    // kind: text opts a value back into the judge
    const asText: Assertion = { type: 'answer_contains', from: 'ref[0].data.id', kind: 'text' };
    expect((await check(asText, 'the third coupon', { equivalence: { 0: { equivalent: true, reason: 'names coupon 3' } } })).results[0]).toMatchObject({ passed: true, matchedBy: 'judge' });
  });

  it('J1 (long-workflows probe, stripe-n200-tool): EUR 1,171,050 vs ground truth 1,211,050 fails although the judge ruled it equivalent twice', async () => {
    // ground truth and final answer copied from probe/stripe-n200-tool{.json,-transcripts.json} (2026-11-27)
    const truth: GroundTruth = {
      refs: [{ tool: 'run_script', ok: true, data: { by_currency: [
        { currency: 'usd', amount: 1351500 }, { currency: 'eur', amount: 1211050 }, { currency: 'gbp', amount: 1152400 }, { currency: 'aud', amount: 778700 },
        { currency: 'sek', amount: 689100 }, { currency: 'jpy', amount: 571450 }, { currency: 'chf', amount: 366400 }, { currency: 'cad', amount: 213850 },
      ], largest: 'usd', charges: 200 } }],
    };
    const answer = [
      'Across all 200 charges, failed-charge totals are:', '', '| Currency | Total (minor units) |', '|---|---:|',
      '| CAD | 213,850 |', '| EUR | 1,171,050 |', '| AUD | 778,700 |', '| USD | 1,351,500 |', '| CHF | 366,400 |', '| SEK | 689,100 |', '| GBP | 1,152,400 |', '| JPY | 571,450 |',
      '', '**USD has the largest failed total: 1,351,500 minor units.**',
    ].join('\n');
    const lw = task({
      assertions: [{ type: 'answer_contains', from: 'ref[0].data.by_currency[*].amount', match: 'all' }, { type: 'answer_contains', from: 'ref[0].data.largest' }, { type: 'no_writes' }],
      referenceCalls: [{ tool: 'run_script', arguments: { code: 'return 1' } }],
    });
    const rec = record({ finalAnswer: answer });
    const equivalence = { 0: { equivalent: true, reason: 'The answer states all expected values for the failed amounts across currencies and correctly identifies USD as the largest.' } };
    const r = await checkAttempt(lw, rec, { groundTruth: truth, equivalence });
    expect(r.passed).toBe(false);
    expect(r.results[0]).toMatchObject({ passed: false });
    expect(r.results[0]!.detail).toContain('1211050');
    expect(r.results[1]).toMatchObject({ passed: true });
    // the equivalence judge is not even asked about the amounts
    expect(failedAnswerExpectations(lw, await checkAttempt(lw, rec, { groundTruth: truth }), truth)).toEqual([]);
  });
});

describe('framing on contract 2', () => {
  it('is n/a when the server offers no begin/end task (framingPassed null, never no_framing)', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id' }, { type: 'framing' }] });
    const r = await checkAttempt(t, record({ framingAvailable: false, agentCalls: [framedAgent[1]!], calls: [call('get_pet_by_id')] }));
    expect(r).toMatchObject({ passed: true, framingPassed: null, failureCause: null });
  });
});

describe('contract 2 ops and confirmation', () => {
  it('neurouter_report with kind unmet_need counts as reporting an unmet need', async () => {
    const t = task({ category: 'impossible', assertions: [{ type: 'unmet_need_reported_or_declined' }] });
    expect((await checkAttempt(t, record({ finalAnswer: 'Done.', calls: [call('neurouter_report', { kind: 'unmet_need', text: 'sms' })] }))).passed).toBe(true);
    expect((await checkAttempt(t, record({ finalAnswer: 'Done.', calls: [call('neurouter_report', { kind: 'done' })] }))).passed).toBe(false);
    const s = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id' }] });
    expect((await checkAttempt(s, record({ calls: [call('neurouter_report', { kind: 'unmet_need' })] }))).failureCause).toBe('missing_capability');
  });

  it('the confirmation round of a destructive call (dry run) is not charged to the budget', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'delete_pet' }, { type: 'max_calls', n: 1, hard: true }] });
    const r = await checkAttempt(t, record({ calls: [call('delete_pet', { pet_id: 1 }, { decision: 'dry_run', write: true }), call('delete_pet', { pet_id: 1, confirm: 'tok' }, { write: true })] }));
    expect(r).toMatchObject({ passed: true, upstreamCalls: 1 });
  });
});
