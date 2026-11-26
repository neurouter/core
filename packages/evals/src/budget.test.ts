import { describe, expect, it } from 'vitest';
import { deriveCallBudget, isIncidentalArg, runawayCeiling, upstreamCalls, withoutIncidental } from './budget.js';
import { call, record } from './test/fixtures.js';

describe('call budgets', () => {
  it('derives ceil(2 × reference calls) + 2 per paginated call, at least 3', () => {
    const paged = { type: 'object', properties: { per_page: { type: 'integer' } } };
    expect(deriveCallBudget([{ tool: 'get', arguments: {} }])).toBe(3);
    expect(deriveCallBudget([{ tool: 'list', arguments: {} }, { tool: 'get', arguments: {} }], (t) => (t === 'list' ? paged : {}))).toBe(6);
    expect(deriveCallBudget([{ tool: 'list', arguments: { limit: 5 } }])).toBe(4);
    expect(runawayCeiling(3)).toBe(12);
    expect(runawayCeiling(1)).toBe(10);
  });

  it('paging arguments are incidental; upstream calls exclude meta, ops and invalid_args', () => {
    expect(isIncidentalArg('per_page') && isIncidentalArg('starting_after') && !isIncidentalArg('owner')).toBe(true);
    expect(withoutIncidental({ owner: 'o', limit: 1 })).toEqual({ owner: 'o' });
    expect(upstreamCalls(record({ calls: [call('search_tools'), call('run_script'), call('neurouter_end_task'), call('a', {}, { via: 'script' }), call('b', {}, { status: 'invalid_args' }), call('c')] }))).toBe(2);
  });
});
