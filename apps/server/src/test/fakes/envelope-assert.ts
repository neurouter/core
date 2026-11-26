import { expect } from 'vitest';
import { envelopeErrors } from '../../dataplane/envelope/schema.js';
import { BUDGET } from '../../dataplane/envelope/types.js';

const KEYS = ['ok', 'data', 'page', 'truncated', 'error', 'state'];

/**
 * Contract-2 conformance of one `tools/call` result (contract-v2 §2, §7): exactly one text item that is the
 * compact JSON of `structuredContent`, fixed key order, `isError === !ok`, the envelope schema, and the
 * state (≤ 50 tok), error (≤ 150 tok) and hint (≤ 200 chars) budgets. Returns the envelope.
 */
export function assertEnvelope(result: unknown, label = 'result'): Record<string, any> {
  const r = result as { content?: Array<{ type: string; text: string }>; structuredContent?: Record<string, any>; isError?: boolean };
  expect(r, `${label}: a tools/call result (not a JSON-RPC error)`).toBeTruthy();
  expect(r.content?.length, `${label}: one content item`).toBe(1);
  expect(r.content![0]!.type).toBe('text');
  const env = r.structuredContent!;
  expect(r.content![0]!.text, `${label}: text = compact structuredContent`).toBe(JSON.stringify(env));
  const keys = Object.keys(env);
  expect(keys.slice(0, 6), `${label}: key order`).toEqual(KEYS);
  expect(keys.length === 6 || (keys.length === 7 && keys[6] === 'hint'), `${label}: only hint may follow`).toBe(true);
  expect(Boolean(r.isError), `${label}: isError = !ok`).toBe(!env.ok);
  expect(envelopeErrors(env), `${label}: envelope schema`).toEqual([]);
  expect(JSON.stringify(env.state).length, `${label}: state ≤ 50 tokens`).toBeLessThanOrEqual(BUDGET.stateChars);
  if (env.error) {
    expect(JSON.stringify(env.error).length, `${label}: error ≤ 150 tokens`).toBeLessThanOrEqual(BUDGET.errorChars);
    expect(JSON.stringify(env.error), `${label}: no stack traces or explain_error steering`).not.toMatch(/Traceback|__neurouter_main__|neurouter_explain_error| at [\w.]+ \(/);
  }
  if (env.hint !== undefined) expect(env.hint.length).toBeLessThanOrEqual(BUDGET.hintChars);
  return env;
}
