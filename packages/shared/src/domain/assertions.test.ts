import { describe, expect, it } from 'vitest';
import { ASSERTION_TYPES, Assertion, READINESS_WEIGHTS } from './assertions.js';
import { readinessBand } from './enums.js';

describe('assertion DSL', () => {
  it('parses every assertion type', () => {
    const samples: unknown[] = [
      { type: 'called', tool: 'get_pet_by_id', args: { petId: 1 }, argsMatch: 'subset', minTimes: 1 },
      { type: 'not_called', tool: 'delete_pet' },
      { type: 'no_writes' },
      { type: 'max_calls', n: 5 },
      { type: 'state', resource: 'pets', where: { name: 'Rex' }, expect: 'exists' },
      { type: 'state', resource: 'pets', scope: { owner: 'octocat' }, where: { status: 'sold' }, expect: { count: 2 } },
      { type: 'answer_contains', anyOf: ['Rex'], caseInsensitive: true },
      { type: 'answer_matches', regex: '\\d+ pets' },
      { type: 'unmet_need_reported_or_declined' },
      { type: 'framing' },
      { type: 'judge', criterion: 'asks which pet the user means' },
    ];
    const types = samples.map((s) => Assertion.parse(s).type);
    expect(new Set(types)).toEqual(new Set(ASSERTION_TYPES));
  });
  it('rejects malformed assertions', () => {
    expect(() => Assertion.parse({ type: 'called' })).toThrow();
    expect(() => Assertion.parse({ type: 'max_calls', n: -1 })).toThrow();
    expect(() => Assertion.parse({ type: 'state', resource: 'pets', where: {}, expect: 'maybe' })).toThrow();
    expect(() => Assertion.parse({ type: 'answer_contains', anyOf: [] })).toThrow();
    expect(() => Assertion.parse({ type: 'bogus' })).toThrow();
  });
  it('weights and bands', () => {
    const sansCorrectness = Object.entries(READINESS_WEIGHTS).filter(([k]) => k !== 'correctness').reduce((s, [, w]) => s + w, 0);
    expect(sansCorrectness).toBeCloseTo(1, 10);
    expect([0, 49, 50, 74, 75, 89, 90, 100].map(readinessBand)).toEqual(['not_ready', 'not_ready', 'needs_work', 'needs_work', 'ready', 'ready', 'excellent', 'excellent']);
  });
});
