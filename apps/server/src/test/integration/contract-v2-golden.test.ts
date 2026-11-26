import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { Golden, rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const CONFIG = resolve(import.meta.dirname, '../fixtures/acme.neurouter.yaml');
const GOLDEN = resolve(import.meta.dirname, 'contract-v2.golden.json');
const V2 = { 'x-neurouter-contract': '2' };

/**
 * Contract-2 goldens on the same fixture as the v1 goldens (negotiated with `X-Neurouter-Contract: 2`): every
 * response is one envelope (checked for key order, text = structuredContent, isError = !ok, schema and budgets)
 * and recorded byte for byte. Covers success, empty, truncated, clipped and error paths of several compiled
 * tools, a composite, call_tool, search_tools, run_script and every ops tool (listed and v1 names).
 */
describe('contract v2 goldens (acme, mock)', () => {
  let s: RunningServer;
  const golden = new Golden(GOLDEN);
  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('records the v2 surface and envelopes', async () => {
    const all = ['tools:read', 'tools:write', 'code:run'] as const;
    const mockKey = await keyFor(s, 'acme', 'mock', [...all]);
    const mock = rawMcp(`${s.url}/mcp/acme/mock`, mockKey, { headers: V2 });
    const init = await mock.initialize();
    golden.check('initialize', init.result);
    expect((init.result as { instructions: string }).instructions).toMatch(/^Neurouter contract 2\./);
    golden.check('tools_list', await mock.list());
    golden.check('tools_list_code', await mock.list({ 'x-neurouter-exposure': 'code' }));
    golden.check('tools_list_tools', await mock.list({ 'x-neurouter-exposure': 'tools' }));

    const call = async (name: string, tool: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
      const r = await mock.call(tool, args, headers);
      const env = assertEnvelope(r.result, name);
      golden.check(name, r.result);
      return env;
    };
    // compiled tools: success
    const order = await call('get_order', 'get_order', { order_id: 'order_1' });
    expect(order.state).toMatchObject({ env: 'mock', writes: 'on', call: 1 });
    expect((await call('get_order_again', 'get_order', { order_id: 'order_1' })).state).toMatchObject({ streak: 2 });
    const lo = await call('list_orders', 'list_orders', { limit: 2 });
    expect(lo.page).toMatchObject({ count: 2, total: 20, has_more: true });
    expect(lo.page.next_cursor).toMatch(/^c_/);
    const lo2 = await call('list_orders_page2', 'list_orders', { limit: 2, cursor: lo.page.next_cursor });
    expect(lo2.data.items.map((o: { id: string }) => o.id)).toEqual(['order_3', 'order_4']);
    await call('list_orders_fields', 'list_orders', { limit: 2, fields: ['id', 'status', 'total'] });
    const mism = await call('list_orders_cursor_mismatch', 'list_orders', { limit: 3, cursor: lo.page.next_cursor });
    expect(mism.error).toMatchObject({ code: 'invalid_args', next: [{ tool: 'list_orders', args: { limit: 3 } }] });
    await call('get_customer', 'get_customer', { customer_id: 'customer_1' });
    await call('list_customers', 'list_customers', { limit: 3 });
    // empty lists (scope + widening hint)
    const empty = await call('list_orders_empty', 'list_orders', { status: 'refunded', customer_id: 'cus_doesnotexist' });
    expect(empty.page).toMatchObject({ count: 0, has_more: false, scope: { status: 'refunded', customer_id: 'cus_doesnotexist', limit: 20 } });
    expect(empty.hint).toContain('list_orders({"status":"refunded"})');
    await call('list_customers_empty', 'list_customers', { cursor: '100', limit: 5 });
    await call('list_shipments_empty', 'list_shipments', { order_id: 'ord_doesnotexist' });
    // truncated list and clipped object
    const cut = await call('list_products_truncated', 'list_products', {});
    expect(cut.page).toMatchObject({ count: 3, total: 20, has_more: true });
    expect(cut.truncated).toBeNull();
    const cut2 = await call('list_products_page2', 'list_products', { cursor: cut.page.next_cursor });
    expect(cut2.page).toMatchObject({ count: 3, total: 20, has_more: true });
    const created = await call('create_customer', 'create_customer', { name: `Ada ${'Lovelace '.repeat(30)}`.trim(), email: 'ada@example.com' });
    const clipped = await call('get_customer_clipped', 'get_customer', { customer_id: created.data.id });
    expect(clipped.truncated).toMatchObject({ fields: ['name'], next: { tool: 'get_customer', args: { customer_id: created.data.id, fields: ['name'] } } });
    await call('get_customer_fields', 'get_customer', clipped.truncated.next.args);
    // errors: unknown ids (parent list as next), validation (every failure + a corrected call), unknown tool
    const nf = await call('get_order_not_found', 'get_order', { order_id: 'ord_doesnotexist' });
    expect(nf.error).toMatchObject({ code: 'not_found', retry: 'after_fix', next: [{ tool: 'list_orders', args: { limit: 20 } }], upstream: { status: 404 } });
    await call('get_customer_not_found', 'get_customer', { customer_id: 'cus_nope' });
    await call('get_product_not_found', 'get_product', { sku: 'sku_nope' });
    const bad = await call('list_orders_invalid', 'list_orders', { status: 'open', limit: 500 });
    expect(bad.error.fields).toHaveLength(2);
    expect(bad.error.next).toEqual([{ tool: 'list_orders', args: { status: 'pending', limit: 100 } }]);
    const renamed = await call('get_order_missing_arg', 'get_order', { orderId: 'order_2' });
    expect(renamed.error.next).toEqual([{ tool: 'get_order', args: { order_id: 'order_2' } }]);
    const unknown = await call('unknown_tool', 'get_invoice', { id: 'x' });
    expect(unknown.error).toMatchObject({ code: 'unknown_tool', next: [{ tool: 'search_tools', args: { query: 'get_invoice' } }] });
    expect(unknown.error.closest?.length).toBeGreaterThan(0);
    // composite
    await call('composite', 'count_orders', { status: 'shipped' });
    await call('composite_invalid', 'count_orders', { status: 'nope' });
    // search_tools
    const hits = await call('search', 'search_tools', { query: 'refund an order' });
    expect(hits.data.tools[0]).toHaveProperty('signature');
    await call('search_full', 'search_tools', { query: 'cancel an order', limit: 2, detail: 'full' });
    await call('search_python', 'search_tools', { query: 'find orders of a customer', limit: 3 }, { 'x-neurouter-exposure': 'code' });
    await call('search_empty', 'search_tools', { query: 'zzqx frobnicate warp drive' });
    await call('search_invalid', 'search_tools', { query: '' });
    // ops: listed report tools, then the unlisted v1 names
    await call('report_unmet_need', 'neurouter_report_unmet_need', { intent: 'export orders as CSV', attempted: ['search_tools'] });
    await call('report_issue', 'neurouter_report_issue', { tool: 'get_order', problem: 'wrong total' });
    await call('log_decision', 'neurouter_log_decision', { choice: 'used list_orders', reason: 'no search tool' });
    await call('report_unmet_need_invalid', 'neurouter_report_unmet_need', { intent: '' });
    await call('begin_task', 'neurouter_begin_task', { goal: 'Check order status' });
    await call('whoami', 'neurouter_whoami');
    await call('get_examples', 'neurouter_get_examples', { tool: 'get_order' });
    await call('explain_error', 'neurouter_explain_error', { error_id: nf.error.error_id });
    await call('explain_error_unknown', 'neurouter_explain_error', { error_id: 'err_doesnotexist0000' });
    // read_result stays answered (unlisted) for handles from contract-1 answers (one release)
    const v1 = rawMcp(`${s.url}/mcp/acme/mock`, mockKey);
    await v1.initialize();
    const handle = ((await v1.call('list_products', {})).result as { _meta: Record<string, string> })._meta['dev.neurouter/result-handle'];
    const page2 = await call('read_result', 'neurouter_read_result', { handle, offset: 3, limit: 5 });
    expect(page2.page).toMatchObject({ count: 5, total: 20, has_more: true });
    await call('read_result_unknown', 'neurouter_read_result', { handle: 'rh_nope' });
    // call_tool
    await call('call_tool', 'call_tool', { name: 'get_order', arguments: { order_id: 'order_2' } });
    await call('call_tool_unknown', 'call_tool', { name: 'get_invoice', arguments: {} });
    await call('call_tool_invalid', 'call_tool', { name: 'list_orders', arguments: { limit: 'x' } });
    await call('call_tool_bad_shape', 'call_tool', { arguments: {} });
    await call('call_tool_meta', 'call_tool', { name: 'search_tools', arguments: { query: 'orders' } });
    // run_script: data is the return value; tool errors raise typed exceptions carrying the error object
    const ok = await call('script_ok', 'run_script', { code: 'o = acme.list_orders(limit=3)\nreturn [x["id"] for x in o["items"]]' });
    expect(ok.state).toMatchObject({ script_calls: 1, left: { calls: 199 } });
    const s404 = await call('script_not_found', 'run_script', { code: 'return acme.get_order(order_id="ord_nope")' });
    expect(s404.error).toMatchObject({ code: 'not_found', line: 1, next: [{ tool: 'run_script', args: { code: 'return acme.list_orders(limit=20)' } }] });
    const caught = await call('script_caught', 'run_script', { code: 'try:\n    acme.get_order(order_id="ord_nope")\nexcept LookupError as e:\n    return str(e)' });
    expect(JSON.parse(caught.data)).toMatchObject({ code: 'not_found' });
    const inv = await call('script_invalid_args', 'run_script', { code: 'try:\n    acme.list_orders(limit=500)\nexcept ValueError as e:\n    return str(e)' });
    expect(JSON.parse(inv.data)).toMatchObject({ code: 'invalid_args', next: [{ tool: 'run_script', args: { code: 'return acme.list_orders(limit=100)' } }] });
    await call('script_dry_run', 'run_script', { code: 'return acme.cancel_order(order_id="order_2", reason="other")', mode: 'dry_run' });
    await call('script_rejected', 'run_script', { code: 'import os\nreturn 1' });
    await call('script_type_error', 'run_script', { code: 'return acme.no_such_fn()' });
    await call('script_runtime_error', 'run_script', { code: 'x = {}\nreturn x["missing"]' });
    await call('script_too_large', 'run_script', { code: 'return "x" * 1100000' });
    await call('script_missing_code', 'run_script', {});
    // writes (mutate the mock: last)
    const w = await call('cancel_order', 'cancel_order', { order_id: 'order_3', reason: 'other' });
    expect(w.state.wrote).toBe('cancel_order → order order_3');
    await call('end_task', 'neurouter_end_task', { outcome: 'success' });

    // prod: confirmation without elicitation (plan in data)
    const prod = rawMcp(`${s.url}/mcp/acme/prod`, await keyFor(s, 'acme', 'prod', [...all]), { headers: V2 });
    await prod.initialize();
    const p = async (name: string, tool: string, args: Record<string, unknown>) => {
      const r = await prod.call(tool, args);
      const env = assertEnvelope(r.result, name);
      golden.check(name, r.result);
      return env;
    };
    const pc = await p('prod_cancel_no_elicitation', 'cancel_order', { order_id: 'order_1', reason: 'other' });
    expect(pc.data.plan).toMatchObject({ tool: 'cancel_order', method: 'POST' });
    expect(pc.state.flags).toContain('prod');
    await p('prod_script_no_elicitation', 'run_script', { code: 'return acme.cancel_order(order_id="order_1", reason="other")' });

    // read-only environment, a key without tools:write
    const ro = rawMcp(`${s.url}/mcp/acme/ro`, await keyFor(s, 'acme', 'ro', [...all]), { headers: V2 });
    golden.check('ro_initialize', (await ro.initialize()).result);
    const rd = await ro.call('cancel_order', { order_id: 'order_1', reason: 'other' });
    const roEnv = assertEnvelope(rd.result, 'ro_writes_disabled');
    expect(roEnv.error).toMatchObject({ code: 'writes_disabled', retry: 'no', next: [{ tool: 'get_order', args: { order_id: 'order_1' } }] });
    golden.check('ro_writes_disabled', rd.result);
    const reader = rawMcp(`${s.url}/mcp/acme/mock`, await keyFor(s, 'acme', 'mock', ['tools:read']), { headers: V2 });
    await reader.initialize();
    const np = await reader.call('cancel_order', { order_id: 'order_1', reason: 'other' });
    expect(assertEnvelope(np.result, 'forbidden').error).toMatchObject({ code: 'forbidden' });
    golden.check('forbidden', np.result);

    golden.finish();
  }, 120_000);
});
