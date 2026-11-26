import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const CONFIG = resolve(import.meta.dirname, '../fixtures/acme.neurouter.yaml');
const V2 = { 'x-neurouter-contract': '2' };
const ALL = ['tools:read', 'tools:write', 'code:run'] as const;
type Env = Record<string, any>;

/**
 * Contract 2, P4 (contract-v2 §5): the script API. Tool functions return plain data; `fn.page()` returns a Result
 * (`.data`, `.items`, `.page`, `.next()`, `.pages()`) and `fn.pages()` iterates every page with the P2 cursors;
 * tool errors raise the ToolError names (built-in bases kept) with a concise `str(e)` and `ops.error(e)`; the
 * confirmation flow inside scripts; `ops.report`; snake_case keywords (D8); v1 scripts unchanged.
 */
describe('contract 2: code mode (acme, mock)', () => {
  let s: RunningServer;
  let key: string;
  const mcp = (env = 'mock', headers: Record<string, string> = V2) => rawMcp(`${s.url}/mcp/acme/${env}`, key, { headers });
  const run = async (code: string, extra: Record<string, unknown> = {}, env = 'mock'): Promise<Env> => {
    const c = mcp(env);
    await c.initialize();
    return assertEnvelope((await c.call('run_script', { code, ...extra })).result, 'run_script');
  };
  const ok = async (code: string, extra: Record<string, unknown> = {}): Promise<unknown> => {
    const r = await run(code, extra);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    return r.data;
  };

  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
    key = await keyFor(s, 'acme', 'mock', [...ALL]);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('functions return plain data; page() returns a Result with .data, .items and .page', async () => {
    expect(await ok('o = acme.get_order(order_id="order_1")\nreturn [isinstance(o, dict), o["id"]]')).toEqual([true, 'order_1']);
    const r = (await ok('r = acme.list_orders.page(limit=3)\nreturn {"n": len(r.items), "count": r.page.count, "total": r.page.total, "more": r.page.has_more, "cursor": r.page.next_cursor[:2], "ids": [o["id"] for o in r.data["items"]]}')) as Env;
    expect(r).toEqual({ n: 3, count: 3, total: 20, more: true, cursor: 'c_', ids: ['order_1', 'order_2', 'order_3'] });
  });

  it('Result.next() follows the P2 cursor; fn.pages() walks every page (one call per page)', async () => {
    expect(await ok('r = acme.list_orders.page(limit=3)\nn = r.next()\nreturn [o["id"] for o in n.items]')).toEqual(['order_4', 'order_5', 'order_6']);
    const all = await run('items = acme.list_orders.pages(limit=6)\nreturn [len(items), len(set([o["id"] for o in items]))]');
    expect(all.data).toEqual([20, 20]);
    expect(all.state.script_calls).toBe(4);
    expect(await ok('return len(acme.list_orders.pages({"limit": 5}, 7))')).toBe(7);
    expect(await ok('return len(acme.list_orders.pages(status="paid", max_items=500))')).toBeGreaterThan(0);
    const last = (await ok('r = acme.list_orders.page(limit=100)\nreturn [r.page.has_more, r.next() is None]')) as boolean[];
    expect(last).toEqual([false, true]);
  });

  it('ops.pages stays as an alias for one release', async () => {
    expect(await ok('return len(ops.pages(fn="acme.list_orders", args={"limit": 6}, max_items=100))')).toBe(20);
  });

  it('a cursor from another call is refused as InvalidArgs before any upstream call', async () => {
    const r = await ok('c = acme.list_orders.page(limit=3).page.next_cursor\ntry:\n    acme.list_orders.page(limit=4, cursor=c)\n    return "no error"\nexcept InvalidArgs as e:\n    return [str(e)[:13], ops.error(e)["next"]]');
    expect(r).toEqual(['invalid_args:', [{ fn: 'acme.list_orders', args: { limit: 4 } }]]);
  });

  it('NotFound: catchable by name and by its LookupError base; str(e) concise; ops.error(e) has code/next/retry', async () => {
    const r = (await ok('try:\n    acme.get_order(order_id="ord_nope")\nexcept NotFound as e:\n    i = ops.error(e)\n    return {"s": str(e), "code": i["code"], "next": i["next"], "retry": i["retry"]}')) as Env;
    expect(r.code).toBe('not_found');
    expect(r.retry).toBe('after_fix');
    expect(r.next).toEqual([{ fn: 'acme.list_orders', args: { limit: 20 } }]);
    expect(r.s).toMatch(/^not_found: .*ord_nope.* Next: acme\.list_orders\(limit=20\)$/);
    expect(r.s.length).toBeLessThan(250);
    expect(await ok('try:\n    acme.get_order(order_id="ord_nope")\nexcept LookupError:\n    return "base"')).toBe('base');
    expect(await ok('try:\n    acme.get_order(order_id="ord_nope")\nexcept ToolError as e:\n    return [isinstance(e, LookupError), isinstance(e, ValueError)]')).toEqual([true, false]);
  });

  it('InvalidArgs: every failing field (Python names) and a corrected next call', async () => {
    const r = (await ok('try:\n    acme.list_orders(limit=500)\nexcept InvalidArgs as e:\n    i = ops.error(e)\n    return [i["code"], [f["field"] for f in i["fields"]], i["next"]]')) as unknown[];
    expect(r).toEqual(['invalid_args', ['limit'], [{ fn: 'acme.list_orders', args: { limit: 100 } }]]);
    // an enum value outside the Literal is caught by the type check, before any call
    const typed = await run('return acme.list_orders(status="open")');
    expect(typed.error.message).toMatch(/pending/);
    expect(typed.state.script_calls ?? 0).toBe(0);
    expect(await ok('try:\n    acme.list_orders(limit=500)\nexcept ValueError:\n    return "base"')).toBe('base');
  });

  it('snake_case keywords (D8) map to the upstream names', async () => {
    const r = (await ok('o = acme.list_orders(customer_id="customer_1", limit=5)\nreturn len(o["items"])')) as number;
    expect(typeof r).toBe('number');
  });

  it('an uncaught tool error is the run error with its own code, the user line and next as run_script calls', async () => {
    const r = await run('x = 1\no = acme.get_order(order_id="ord_nope")\nreturn o');
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'not_found', line: 2, next: [{ tool: 'run_script', args: { code: 'return acme.list_orders(limit=20)' } }] });
  });

  it('attribute access on an exception points at ops.error(e)', async () => {
    const r = await run('try:\n    acme.get_order(order_id="ord_nope")\nexcept NotFound as e:\n    return e.code');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r.error)).toContain('ops.error(e)');
  });

  it('unknown functions are caught by the type check with the closest names', async () => {
    const r = await run('return acme.get_ordr(order_id="order_1")');
    expect(r.ok).toBe(false);
    expect(r.error.message).toMatch(/get_ordr/);
    expect(r.error.message).not.toContain('_nr_');
  });

  it('a wrong keyword is a type error before any call', async () => {
    const r = await run('return acme.get_order(order="order_1")');
    expect(r.ok).toBe(false);
    expect(r.state.script_calls ?? 0).toBe(0);
  });

  it('confirmation flow: dry run plans with {plan}; execute needs the token; with it the cancel runs', async () => {
    const code = 'o = acme.cancel_order(order_id="order_7", reason="other")\nreturn o';
    const dry = await run(code, { mode: 'dry_run' });
    expect(dry.ok).toBe(true);
    expect(dry.data.result).toMatchObject({ plan: { tool: 'cancel_order', target: 'order order_7', reversible: false } });
    expect(dry.data.next.args.confirm).toMatch(/^ct_/);
    const gate = await run(code);
    expect(gate.ok).toBe(false);
    expect(gate.error.code).toBe('confirmation_required');
    expect(gate.data.plan[0]).toMatchObject({ tool: 'cancel_order', target: 'order order_7' });
    const done = await run(code, { confirm: gate.error.next[0].args.confirm });
    expect(done.ok, JSON.stringify(done.error)).toBe(true);
    expect(done.data.status).toBe('cancelled');
  });

  it('ConfirmationRequired inside a script: a destructive call outside the dry-run plan raises with the plan', async () => {
    // the dry run sees {plan} from the update and stops there, so its plan has no destructive call and no token is
    // asked; the real run then reaches cancel_order, which is not in any confirmed plan
    const code = 'o = acme.update_order(order_id="order_9", note="checked")\nif "plan" in o:\n    return "planned"\ntry:\n    acme.cancel_order(order_id="order_9", reason="other")\n    return "ran"\nexcept ConfirmationRequired as e:\n    i = ops.error(e)\n    return [i["code"], i["plan"]["target"], i["plan"]["reversible"], isinstance(e, PermissionError), i["next"][0]["fn"]]';
    const r = await run(code);
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data).toEqual(['confirmation_required', 'order order_9', false, true, 'run_script']);
    // uncaught: the run answers confirmation_required with the re-plan call (run_script without a token)
    const raw = await run('o = acme.update_order(order_id="order_10", note="x")\nif "plan" in o:\n    return "planned"\nacme.cancel_order(order_id="order_10", reason="other")\nreturn "ran"');
    expect(raw.ok).toBe(false);
    expect(raw.error).toMatchObject({ code: 'confirmation_required', line: 4, next: [{ tool: 'run_script' }] });
    expect(raw.data.plan[0]).toMatchObject({ tool: 'cancel_order', target: 'order order_10', reversible: false });
  });

  it('ops.report records like neurouter_report', async () => {
    const r = (await ok('return ops.report("unmet_need", "export orders as CSV", attempted=["acme.list_orders"])')) as Env;
    expect(r).toMatchObject({ recorded: true });
  });

  it('getattr/hasattr are allowed in contract 2', async () => {
    expect(await ok('r = acme.list_orders.page(limit=1)\nreturn [hasattr(r, "page"), getattr(r.page, "count")]')).toEqual([true, 1]);
  });

  it('the run_script description names a real function, the builtins and the idioms; its example runs', async () => {
    const c = mcp('mock', { ...V2, 'x-neurouter-exposure': 'code' });
    await c.initialize();
    const list = (await c.list()) as Array<{ name: string; description: string }>;
    const d = list.find((t) => t.name === 'run_script')!.description;
    expect(d).toContain('acme.list_orders.pages(');
    expect(d).toContain('except NotFound');
    expect(d).toContain('ops.error(e)');
    expect(d).toContain('getattr');
    const example = /Example:\n([\s\S]+?)\n*$/.exec(d)?.[1];
    expect(example, d).toBeTruthy();
    const r = await run(example!.split('\n').map((l) => l.replace(/^ {2}/, '')).join('\n'));
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
  });

  it('contract 1 scripts are unchanged: plain functions, RuntimeError-style errors, no prelude names', async () => {
    const v1 = mcp('mock', {});
    await v1.initialize();
    const r = (await v1.call('run_script', { code: 'try:\n    acme.get_order(order_id="ord_nope")\nexcept RuntimeError as e:\n    return str(e)[:24]' })).result as { structuredContent: Env };
    expect(r.structuredContent.status).toBe('ok');
    expect(r.structuredContent.result).toMatch(/^upstream_not_found/);
    const r2 = (await v1.call('run_script', { code: 'return NotFound' })).result as { structuredContent: Env };
    expect(r2.structuredContent.status).not.toBe('ok');
  });
});
