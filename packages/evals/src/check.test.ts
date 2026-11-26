import { describe, expect, it } from 'vitest';
import { argsSubset, checkAttempt, classifyFailure, framingOk, primaryTool } from './check.js';
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

  it('not_called, no_writes (dry runs and blocked writes are not writes), max_calls', async () => {
    const t = task({ assertions: [{ type: 'not_called', tool: 'delete_pet' }, { type: 'no_writes' }, { type: 'max_calls', n: 2 }] });
    const rec = record({ toolCallsByAgent: 2, calls: [call('add_pet', {}, { write: true, decision: 'dry_run' }), call('add_pet', {}, { write: true, decision: 'denied_read_only', status: 'blocked' })] });
    expect((await checkAttempt(t, rec)).passed).toBe(true);
    const rec2 = record({ toolCallsByAgent: 3, calls: [call('add_pet', {}, { write: true }), call('delete_pet')] });
    expect((await checkAttempt(t, rec2)).results.map((x) => x.passed)).toEqual([false, false, false]);
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
  it('error for refusals', async () => {
    const r = await checkAttempt(t, record({ endReason: 'refusal', calls: [call('get_pet_by_id', { petId: 1 })] }));
    expect(r).toMatchObject({ passed: false, failureCause: 'error' });
    expect(classifyFailure(t, record({ endReason: 'error' }), { passed: false, results: [], framingPassed: null })).toBe('error');
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
