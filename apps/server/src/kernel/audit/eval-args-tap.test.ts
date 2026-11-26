import { describe, expect, it } from 'vitest';
import { EvalArgsTap } from './eval-args-tap.js';

describe('EvalArgsTap', () => {
  it('captures clear params only for watched keys, by event id, bounded, until released', () => {
    const tap = new EvalArgsTap(2);
    tap.capture({ id: 'e0', apiKeyId: 'k1', params: { secret_name: 's' } });
    tap.watch('k1');
    const params = { secret_name: 's1' };
    tap.capture({ id: 'e1', apiKeyId: 'k1', params });
    params.secret_name = 'mutated';
    tap.capture({ id: 'e2', apiKeyId: 'k2', params: { x: 1 } });
    tap.capture({ id: 'e3', apiKeyId: 'k1', params: { card: 'c' } });
    tap.capture({ id: 'e4', apiKeyId: 'k1', params: { over: true } });
    expect([...tap.peek('k1')]).toEqual([
      ['e1', { secret_name: 's1' }],
      ['e3', { card: 'c' }],
    ]);
    expect(tap.peek('k2').size).toBe(0);
    tap.release('k1');
    expect(tap.peek('k1').size).toBe(0);
    expect(tap.size).toBe(0);
  });
});
