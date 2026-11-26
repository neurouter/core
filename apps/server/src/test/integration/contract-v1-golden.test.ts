import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { Golden, rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const CONFIG = resolve(import.meta.dirname, '../fixtures/acme.neurouter.yaml');
const GOLDEN = resolve(import.meta.dirname, 'contract-v1.golden.json');

/**
 * Contract v1 goldens: every agent-facing response shape of 0.2.1 (API tools, call_tool, search_tools,
 * run_script, composite and every ops tool; success, empty, truncated, clipped and error paths). Recorded on
 * 0.2.1 before the v2 envelope existed; a v1 server MUST keep answering byte-identically.
 */
describe('contract v1 goldens (acme, mock)', () => {
  let s: RunningServer;
  const golden = new Golden(GOLDEN);
  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('records the v1 surface and responses', async () => {
    const all = ['tools:read', 'tools:write', 'code:run'] as const;
    const mock = rawMcp(`${s.url}/mcp/acme/mock`, await keyFor(s, 'acme', 'mock', [...all]));
    const init = await mock.initialize();
    golden.check('initialize', init.result);
    const listed = await mock.list();
    golden.check('tools_list', listed);
    golden.check('tools_list_code', await mock.list({ 'x-neurouter-exposure': 'code' }));
    golden.check('tools_list_tools', await mock.list({ 'x-neurouter-exposure': 'tools' }));

    const call = async (name: string, tool: string, args: Record<string, unknown> = {}) => {
      const r = await mock.call(tool, args);
      golden.check(name, r.result ?? { jsonrpc_error: r.error });
      return r.result as Record<string, unknown> | undefined;
    };
    // API tools: success, empty list, list, truncated list, clipped object, errors
    await call('get_order', 'get_order', { order_id: 'order_1' });
    await call('list_orders', 'list_orders', { limit: 2 });
    await call('list_orders_empty', 'list_orders', { status: 'refunded', customer_id: 'cus_doesnotexist' });
    await call('list_products_truncated', 'list_products', {});
    await call('get_shipment', 'get_shipment', { shipment_id: 'shipment_1' });
    const created = (await call('create_customer', 'create_customer', { name: `Ada ${'Lovelace '.repeat(30)}`.trim(), email: 'ada@example.com' }))?.structuredContent as { id: string };
    await call('get_customer_clipped', 'get_customer', { customer_id: created.id });
    const nf = await call('get_order_not_found', 'get_order', { order_id: 'ord_doesnotexist' });
    await call('list_orders_invalid', 'list_orders', { status: 'open', limit: 500 });
    await call('get_order_missing_arg', 'get_order', { orderId: 'x' });
    await call('unknown_tool', 'get_invoice', { id: 'x' });
    await call('composite', 'count_orders', { status: 'shipped' });
    // search_tools
    await call('search_json', 'search_tools', { query: 'refund an order', format: 'json' });
    await call('search_python', 'search_tools', { query: 'find orders of a customer' });
    await call('search_empty', 'search_tools', { query: 'zzqx frobnicate warp drive' });
    await call('search_invalid', 'search_tools', { query: '' });
    // ops tools
    await call('begin_task', 'neurouter_begin_task', { goal: 'Check order status' });
    await call('whoami', 'neurouter_whoami');
    await call('get_examples', 'neurouter_get_examples', { tool: 'get_order' });
    const errorId = (nf?._meta as Record<string, string> | undefined)?.['dev.neurouter/error-id'];
    expect(errorId).toMatch(/^err_/);
    await call('explain_error', 'neurouter_explain_error', { error_id: errorId });
    await call('explain_error_unknown', 'neurouter_explain_error', { error_id: 'err_doesnotexist0000' });
    await call('log_decision', 'neurouter_log_decision', { choice: 'used list_orders', reason: 'no search tool' });
    await call('report_issue', 'neurouter_report_issue', { tool: 'get_order', problem: 'wrong total' });
    await call('report_unmet_need', 'neurouter_report_unmet_need', { intent: 'export orders as CSV', attempted: ['search_tools'] });
    const trunc = (await mock.call('list_products', {})).result as Record<string, unknown>;
    const handle = (trunc._meta as Record<string, string>)['dev.neurouter/result-handle'];
    expect(handle).toMatch(/^rh_/);
    await call('read_result', 'neurouter_read_result', { handle, offset: 3, limit: 2 });
    await call('read_result_unknown', 'neurouter_read_result', { handle: 'rh_nope' });
    // run_script
    await call('script_ok', 'run_script', { code: 'o = acme.list_orders(limit=3)\nreturn [x["id"] for x in o["items"]]' });
    await call('script_not_found', 'run_script', { code: 'return acme.get_order(order_id="ord_nope")' });
    await call('script_dry_run', 'run_script', { code: 'return acme.cancel_order(order_id="order_2", reason="other")', mode: 'dry_run' });
    await call('script_rejected', 'run_script', { code: 'import os\nreturn 1' });
    await call('script_type_error', 'run_script', { code: 'return acme.no_such_fn()' });
    await call('script_runtime_error', 'run_script', { code: 'x = {}\nreturn x["missing"]' });
    // writes (mutate the mock: last)
    await call('cancel_order', 'cancel_order', { order_id: 'order_3', reason: 'other' });
    await call('end_task', 'neurouter_end_task', { outcome: 'success' });

    // prod: confirmation without elicitation
    const prod = rawMcp(`${s.url}/mcp/acme/prod`, await keyFor(s, 'acme', 'prod', [...all]));
    await prod.initialize();
    const p = async (name: string, tool: string, args: Record<string, unknown>) => golden.check(name, (await prod.call(tool, args)).result);
    await p('prod_cancel_no_elicitation', 'cancel_order', { order_id: 'order_1', reason: 'other' });
    await p('prod_script_no_elicitation', 'run_script', { code: 'return acme.cancel_order(order_id="order_1", reason="other")' });

    // read-only environment with search discovery: writes_disabled, call_tool
    const ro = rawMcp(`${s.url}/mcp/acme/ro`, await keyFor(s, 'acme', 'ro', [...all]));
    golden.check('ro_initialize', (await ro.initialize()).result);
    golden.check('ro_tools_list', await ro.list());
    const r = async (name: string, tool: string, args: Record<string, unknown>) => {
      const out = await ro.call(tool, args);
      golden.check(name, out.result ?? { jsonrpc_error: out.error });
    };
    await r('ro_writes_disabled', 'cancel_order', { order_id: 'order_1', reason: 'other' });
    await r('ro_call_tool', 'call_tool', { name: 'get_order', arguments: { order_id: 'order_2' } });
    await r('ro_call_tool_unknown', 'call_tool', { name: 'get_invoice', arguments: {} });
    await r('ro_call_tool_invalid', 'call_tool', { name: 'list_orders', arguments: { limit: 'x' } });
    await r('ro_call_tool_bad_shape', 'call_tool', { arguments: {} });
    await r('ro_call_tool_ops', 'call_tool', { name: 'neurouter_whoami', arguments: {} });

    // a key without tools:write
    const reader = rawMcp(`${s.url}/mcp/acme/mock`, await keyFor(s, 'acme', 'mock', ['tools:read']));
    await reader.initialize();
    golden.check('not_permitted', (await reader.call('cancel_order', { order_id: 'order_1', reason: 'other' })).result);

    golden.finish();
  }, 120_000);
});
