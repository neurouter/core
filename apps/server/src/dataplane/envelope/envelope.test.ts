import type { ToolDef } from '@neurouter/shared';
import { describe, expect, it } from 'vitest';
import { ArgValidator } from '../pipeline/arg-validate.js';
import { buildError, correctedArgs, fitError, mapCode, upstreamDetail } from './errors.js';
import { isListTool, listView, widenHint } from './page.js';
import type { CursorPayload } from '../paging/cursor.js';
import { nextSignals, pagingPlan } from '../paging/plan.js';
import { closestNames, nounOf, parentListCall, readCall } from './relations.js';
import { ADVERTISED_ENVELOPE_SCHEMA, envelopeErrors, typedEnvelopeSchema, typedErrors } from './schema.js';
import { StateTracker, taskHandle } from './state.js';
import { BUDGET, type ErrorInfo } from './types.js';

function tool(name: string, method: ToolDef['binding'] extends infer B ? (B extends { method: infer M } ? M : never) : never, path: string, inputSchema: Record<string, unknown>, extra: Partial<ToolDef> = {}): ToolDef {
  const write = method !== 'GET';
  return {
    name,
    pyName: `acme.${name}`,
    title: name,
    description: name,
    kind: 'operation' as ToolDef['kind'],
    inputSchema: { type: 'object', additionalProperties: false, ...inputSchema },
    binding: { type: 'http', method, pathTemplate: path, params: Object.keys((inputSchema.properties as object) ?? {}).map((k) => ({ arg: k, in: path.includes(`{${camel(k)}}`) ? 'path' : 'query', name: path.includes(`{${camel(k)}}`) ? camel(k) : k, required: false })), successStatuses: [200], responseContentType: 'application/json', security: [] },
    risk: { readOnly: !write, destructive: method === 'DELETE' || name.startsWith('cancel'), idempotent: !write, openWorld: true, write },
    tags: [],
    hidden: false,
    pinned: false,
    deprecated: false,
    examples: [],
    pySignature: '',
    sourceRef: { pointer: '' },
    overlayApplied: [],
    key: name,
    defHash: `h-${name}`,
    ...extra,
  };
}
const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());

const STATUS = { type: 'string', enum: ['pending', 'paid', 'shipped', 'delivered', 'cancelled', 'refunded'] };
const listOrders = tool('list_orders', 'GET', '/orders', { properties: { status: STATUS, customer_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100, default: 20 }, cursor: { type: 'string' } } }, {
  outputSchema: { type: 'object', properties: { items: { type: 'array', items: { type: 'object' } }, nextCursor: { type: ['string', 'null'] }, total_count: { type: 'integer' } } },
});
const getOrder = tool('get_order', 'GET', '/orders/{orderId}', { properties: { order_id: { type: 'string' } }, required: ['order_id'] }, {
  outputSchema: { type: 'object', properties: { id: { type: 'string' }, items: { type: 'array' }, total: { type: 'number' } } },
});
const cancelOrder = tool('cancel_order', 'POST', '/orders/{orderId}/cancel', { properties: { order_id: { type: 'string' }, reason: { type: 'string', enum: ['customer_request', 'other'] } }, required: ['order_id'] });
const TOOLS = [listOrders, getOrder, cancelOrder];
const EC = { env: 'mock', tools: TOOLS };
const args = new ArgValidator();
const issuesFor = (t: ToolDef, a: Record<string, unknown>) => {
  const c = args.check(t.defHash, t.inputSchema, a);
  return c.ok ? [] : c.issues;
};

describe('error builder (contract-v2 §2.3)', () => {
  it('maps every v1 catalog code to a contract-2 code with retry advice', () => {
    expect(mapCode('upstream_not_found')).toEqual({ code: 'not_found', retry: 'after_fix' });
    expect(mapCode('not_permitted')).toEqual({ code: 'forbidden', retry: 'no' });
    expect(mapCode('upstream_validation')).toEqual({ code: 'upstream_rejected', retry: 'after_fix' });
    expect(mapCode('upstream_rate_limited')).toEqual({ code: 'rate_limited', retry: 'after_wait' });
    expect(mapCode('response_too_large').code).toBe('too_large');
    expect(mapCode('script_limit').code).toBe('limit_exceeded');
    expect(mapCode('kill_switch')).toEqual({ code: 'unavailable', retry: 'no' });
  });

  it('invalid_args: every failure with allowed values, and one corrected call that validates', () => {
    const a = { status: 'open', limit: 500 };
    const e = buildError({ code: 'invalid_args', message: 'x', tool: listOrders, name: 'list_orders', args: a, issues: issuesFor(listOrders, a) }, EC);
    expect(e.fields).toEqual([
      { field: 'status', received: 'open', allowed: STATUS.enum, problem: 'not an allowed value' },
      { field: 'limit', received: 500, allowed: '1..100', problem: 'out of range' },
    ]);
    expect(e.message).toBe('2 invalid arguments; nothing was called.');
    expect(e.next).toEqual([{ tool: 'list_orders', args: { status: 'pending', limit: 100 } }]);
    expect(args.check(listOrders.defHash, listOrders.inputSchema, e.next[0]!.args)).toEqual({ ok: true });
  });

  it('invalid_args: the closest enum value, numeric strings coerced, unknown arguments renamed or dropped', () => {
    const a = { status: 'shiped', limit: '5', foo: 1 };
    const fixed = correctedArgs(listOrders, a, issuesFor(listOrders, a));
    expect(fixed).toEqual({ status: 'shipped', limit: 5 });
    const b = { orderId: 'order_2' };
    expect(correctedArgs(getOrder, b, issuesFor(getOrder, b))).toEqual({ order_id: 'order_2' });
    // a required value with no example or default cannot be invented
    expect(correctedArgs(getOrder, {}, issuesFor(getOrder, {}))).toBeNull();
    expect(correctedArgs({ ...getOrder, examples: [{ arguments: { order_id: 'order_1' } }] }, {}, issuesFor(getOrder, {}))).toEqual({ order_id: 'order_1' });
  });

  it('not_found: Neurouter-authored message, upstream body moved to a marked field, parent list as next', () => {
    const e = buildError({ code: 'upstream_not_found', message: 'The API answered 404 for get_order: {"type":"about:blank"}', tool: getOrder, args: { order_id: 'ord_x' }, upstream: { status: 404, body: { type: 'about:blank', title: 'Not Found', status: 404, detail: 'order ord_x not found' } }, errorId: 'err_1' }, EC);
    expect(e).toEqual({ code: 'not_found', message: "No order 'ord_x' in mock. Nothing changed.", retry: 'after_fix', next: [{ tool: 'list_orders', args: { limit: 20 } }], upstream: { status: 404, detail: 'order ord_x not found' }, error_id: 'err_1' });
    expect(e.message).not.toContain('about:blank');
  });

  it('unknown_tool: closest names and search_tools with the attempted name', () => {
    const e = buildError({ code: 'unknown_tool', message: 'x', name: 'get_ordr' }, { ...EC, closest: closestNames('get_ordr', TOOLS.map((t) => t.name)) });
    expect(e).toMatchObject({ code: 'unknown_tool', retry: 'after_fix', next: [{ tool: 'search_tools', args: { query: 'get_ordr' } }] });
    expect(e.closest?.[0]).toBe('get_order');
  });

  it('refusals of writes point at a read of the same entity (the actual state)', () => {
    for (const code of ['writes_disabled', 'not_permitted', 'policy_denied', 'upstream_conflict'] as const) {
      const e = buildError({ code, message: 'refused', tool: cancelOrder, args: { order_id: 'order_1', reason: 'other' } }, EC);
      expect(e.next, code).toEqual([{ tool: 'get_order', args: { order_id: 'order_1' } }]);
    }
  });

  it('retryable failures repeat the call; too_large halves the page size', () => {
    expect(buildError({ code: 'upstream_error', message: 'x', tool: getOrder, args: { order_id: 'o' }, upstream: { status: 502, body: 'bad gateway' } }, EC)).toMatchObject({ code: 'upstream_error', retry: 'yes', next: [{ tool: 'get_order', args: { order_id: 'o' } }], upstream: { status: 502, detail: 'bad gateway' } });
    expect(buildError({ code: 'upstream_rate_limited', message: 'x', tool: getOrder, args: { order_id: 'o' }, retryAfterMs: 3000, upstream: { status: 429, body: {} } }, EC)).toMatchObject({ code: 'rate_limited', retry: 'after_wait', retry_after_ms: 3000, next: [{ tool: 'get_order' }] });
    expect(buildError({ code: 'response_too_large', message: 'x', tool: listOrders, args: { limit: 100 } }, EC).next).toEqual([{ tool: 'list_orders', args: { limit: 50 } }]);
  });

  it('upstream excerpts are short, redacted and never stack traces', () => {
    expect(upstreamDetail({ message: 'Bearer abc.def.ghi was rejected' })).not.toContain('abc.def.ghi');
    expect(upstreamDetail({ token: 'secret-value', code: 7 })).not.toContain('secret-value');
    expect(upstreamDetail('x'.repeat(1000)).length).toBeLessThanOrEqual(BUDGET.upstreamChars);
    expect(upstreamDetail({ title: 'Conflict', detail: 'version 3 is stale' })).toBe('version 3 is stale');
  });

  it('fits the 150-token budget (characters ÷ 4 ≤ 600) by shrinking the least useful parts first', () => {
    const big: ErrorInfo = {
      code: 'invalid_args',
      message: 'm'.repeat(200),
      fields: Array.from({ length: 12 }, (_, i) => ({ field: `field_${i}`, received: 'r'.repeat(60), allowed: Array.from({ length: 30 }, (_x, j) => `value_${j}`), problem: 'not an allowed value' })),
      retry: 'after_fix',
      next: [{ tool: 'list_orders', args: { status: 'pending' } }],
      closest: ['a', 'b', 'c', 'd', 'e'],
      upstream: { status: 400, detail: 'u'.repeat(300) },
      error_id: 'err_x',
    };
    const fit = fitError(big);
    expect(JSON.stringify(fit).length).toBeLessThanOrEqual(BUDGET.errorChars);
    expect(fit).toMatchObject({ code: 'invalid_args', retry: 'after_fix', next: [{ tool: 'list_orders' }], error_id: 'err_x' });
  });
});

describe('list pages (contract-v2 §2.1)', () => {
  it('lists are arrays or list wrappers; an entity with one array field is not', () => {
    expect(isListTool(listOrders, {})).toBe(true);
    expect(isListTool(getOrder, {})).toBe(false);
  });

  const enc = (p: CursorPayload) => `c_${JSON.stringify(p)}`;
  const view = (args: Record<string, unknown>, value: unknown, headers: Record<string, string> = {}, cut?: Parameters<typeof listView>[3], handle: string | null = null) =>
    listView(listOrders, args, value, cut, { encode: enc, signals: nextSignals(pagingPlan(listOrders), args, value, headers, 'https://api.acme.test', 20), handle, own: ['cursor', 'fields'] });

  it('has_more is explicit: the upstream signals decide; next_cursor carries the upstream token; empty pages are final', () => {
    expect(view({ limit: 2 }, { total_count: 20, items: [1, 2], nextCursor: 'c' }).page).toEqual({ count: 2, total: 20, has_more: true, next_cursor: enc({ k: 'u', v: 'c' }) });
    expect(view({ limit: 50 }, { total_count: 2, items: [1, 2], nextCursor: null }).page).toEqual({ count: 2, total: 2, has_more: false, next_cursor: null });
    expect(view({}, [1, 2], { link: '<https://api.acme.test/orders?page=2>; rel="next"' }).page).toMatchObject({ total: null, has_more: true, next_cursor: enc({ k: 'l', q: { page: '2' } }) });
    // a Link to another origin is not followed (has_more stays honest, no cursor)
    expect(view({}, [1, 2], { link: '<https://evil.test/orders?page=2>; rel="next"' }).page).toMatchObject({ has_more: true, next_cursor: null });
    const empty = view({ status: 'refunded', customer_id: 'c' }, { items: [] });
    expect(empty.page).toEqual({ count: 0, total: 0, has_more: false, next_cursor: null, scope: { status: 'refunded', customer_id: 'c', limit: 20 } });
    expect(empty.hint).toBe('0 matches for these filters (page.scope). Widen: list_orders({"status":"refunded"})');
  });

  it("Neurouter's cuts are pages: has_more, scope, and a cursor into the stored result, then the upstream's next page", () => {
    const v = view({}, { items: [1, 2, 3] }, {}, { totalItems: 20, returnedItems: 3, totalBytes: 2000, returnedBytes: 300 }, 'rh_x');
    expect(v.page).toEqual({ count: 3, total: 20, has_more: true, next_cursor: enc({ k: 'r', h: 'rh_x', n: 3, t: 20, then: null }), scope: { limit: 20 } });
    expect(v.truncated).toBeNull();
    const up = view({}, { items: [1, 2, 3], nextCursor: '30' }, {}, { totalItems: 30, returnedItems: 3, totalBytes: 2000, returnedBytes: 300 }, 'rh_x');
    expect(up.page).toMatchObject({ total: null, has_more: true, next_cursor: enc({ k: 'r', h: 'rh_x', n: 3, t: null, then: { k: 'u', v: '30' } }) });
    // the stored result's last part hands over to the upstream's next page
    const last = listView(listOrders, {}, { items: [4, 5] }, undefined, { encode: enc, signals: null, handle: 'rh_x', stored: { offset: 3, length: 5, total: null, then: { k: 'u', v: '30' } }, own: [] });
    expect(last.page).toMatchObject({ count: 2, has_more: true, next_cursor: enc({ k: 'u', v: '30' }) });
    expect(widenHint(listOrders, { limit: 5 })).toBe('0 items.');
  });
});

describe('state block (contract-v2 §2.4)', () => {
  const base = { taskId: 'task-1', requestId: 'r', env: 'mock', writes: 'on' as const, write: false, now: 0 };
  it('full form on the first call, short form after, full again on writes and on changes; streaks of identical results', () => {
    const st = new StateTracker();
    expect(st.next({ ...base, callKey: 'a', resultKey: '1' })).toEqual({ env: 'mock', writes: 'on', task: taskHandle('task-1'), call: 1 });
    expect(st.next({ ...base, callKey: 'a', resultKey: '1' })).toEqual({ task: taskHandle('task-1'), call: 2, streak: 2 });
    expect(st.next({ ...base, callKey: 'a', resultKey: '1' })).toMatchObject({ call: 3, streak: 3 });
    expect(st.next({ ...base, callKey: 'a', resultKey: '2' })).toEqual({ task: taskHandle('task-1'), call: 4 });
    expect(st.next({ ...base, callKey: 'w', resultKey: '3', write: true, wrote: 'cancel_order → order order_1' })).toMatchObject({ env: 'mock', writes: 'on', wrote: 'cancel_order → order order_1' });
    expect(st.next({ ...base, writes: 'off', callKey: 'b', resultKey: '4' })).toMatchObject({ env: 'mock', writes: 'off' });
    expect(st.next({ ...base, taskId: 'task-2', callKey: 'a', resultKey: '1', fullFlags: ['prod'] })).toMatchObject({ call: 1, flags: ['prod'] });
  });

  it('stays within 50 tokens', () => {
    const st = new StateTracker();
    const s = st.next({ ...base, callKey: 'a', resultKey: '1', wrote: `x → ${'y'.repeat(300)}`, flags: ['instruction_like_text'], flagPaths: ['a'.repeat(80), 'b'.repeat(80), 'c'.repeat(80)], left: { calls: 1, seconds: 2 }, scriptCalls: 3 });
    expect(JSON.stringify(s).length).toBeLessThanOrEqual(BUDGET.stateChars);
    expect(taskHandle('x')).toMatch(/^t_[0-9A-Za-z]{8}$/);
  });
});

describe('envelope schemas (contract-v2 §2.5)', () => {
  const env = { ok: true, data: { id: 'o' }, page: null, truncated: null, error: null, state: { task: 't_abcd1234', call: 1 } };
  it('the full schema enforces error iff !ok and closed keys', () => {
    expect(envelopeErrors(env)).toEqual([]);
    expect(envelopeErrors({ ...env, ok: false })).not.toEqual([]);
    expect(envelopeErrors({ ...env, extra: 1 })).not.toEqual([]);
    expect(JSON.stringify(ADVERTISED_ENVELOPE_SCHEMA).length).toBeLessThan(400);
  });

  it('typed: data is checked on success unless the server flagged schema_mismatch; $defs are hoisted', () => {
    const out = { $defs: { Order: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } }, $ref: '#/$defs/Order' };
    expect(typedEnvelopeSchema(out)).toHaveProperty('$defs.Order');
    expect(typedErrors('k1', out, env)).toEqual([]);
    expect(typedErrors('k1', out, { ...env, data: { id: 1 } })).not.toEqual([]);
    expect(typedErrors('k1', out, { ...env, data: { id: 1 }, state: { ...env.state, flags: ['schema_mismatch'] } })).toEqual([]);
    expect(typedErrors('k1', out, { ...env, ok: false, data: null, error: {} })).toEqual([]);
  });
});

describe('relations', () => {
  it('names the entity and finds parent lists and reads', () => {
    expect(nounOf(cancelOrder)).toBe('order');
    expect(nounOf(listOrders)).toBe('order');
    expect(parentListCall(cancelOrder, { order_id: 'o' }, TOOLS)).toEqual({ tool: 'list_orders', args: { limit: 20 } });
    expect(readCall(cancelOrder, { order_id: 'o' }, TOOLS)).toEqual({ tool: 'get_order', args: { order_id: 'o' } });
  });
});
