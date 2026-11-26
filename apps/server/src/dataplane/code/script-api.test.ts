import { generateOpsStubV2, NR_HOST_STUBS, SCRIPT_ERROR_CLASSES, scriptPrelude } from '@neurouter/compiler';
import { LocalExecutor, type HostCallResult, type RunRequest } from '@neurouter/executor';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wrapScript } from './wrap.js';

const STUBS = 'from typing import Any\ndef get_order(*, order_id: str) -> dict[str, Any]: ...\ndef list_orders(*, limit: int = 20, cursor: str | None = None) -> dict[str, Any]: ...\n';

/** A fake host for `_nr.call`: get_order(order_id=<error code>) fails with that code; list_orders pages 3×4 items. */
function host(calls: Array<Record<string, unknown>> = []) {
  return {
    async call(fn: string, kwargs: Record<string, unknown>): Promise<HostCallResult> {
      calls.push({ ...kwargs, host: fn });
      if (fn !== '_nr.call') return { ok: true, value: { recorded: true } };
      const args = kwargs.args as Record<string, unknown>;
      if (kwargs.fn === 'acme.get_order') {
        const code = String(args.order_id);
        if (code === 'order_1') return { ok: true, value: { ok: true, data: { id: 'order_1' } } };
        const cls = SCRIPT_ERROR_CLASSES.find((c) => (c.codes as readonly string[]).includes(code))!;
        return { ok: true, value: { ok: false, py: cls.base, text: `${code}: failed for the test. Next: acme.list_orders(limit=20)`, error: { code, message: 'failed for the test', retry: 'after_fix', next: [{ fn: 'acme.list_orders', args: { limit: 20 } }], ...(code === 'confirmation_required' ? { plan: { target: 'order order_9', reversible: false } } : {}) } } };
      }
      const page = args.cursor === 'c_2' ? 2 : args.cursor === 'c_3' ? 3 : 1;
      const items = Array.from({ length: 4 }, (_, i) => ({ id: `order_${(page - 1) * 4 + i + 1}` }));
      return { ok: true, value: { ok: true, data: { items }, items, page: { count: 4, total: 12, has_more: page < 3, next_cursor: page < 3 ? `c_${page + 1}` : null } } };
    },
  };
}

function request(body: string): RunRequest {
  const w = wrapScript(body);
  return {
    runId: `run_${Math.random().toString(36).slice(2)}`,
    capability: 'rc_test',
    code: w.code,
    lineOffset: w.lineOffset,
    colOffset: w.colOffset,
    prelude: scriptPrelude([{ ns: 'acme', functions: ['get_order', 'list_orders'] }], [], true),
    modules: { acme: { functions: ['get_order', 'list_orders'], stubs: STUBS }, ops: { functions: ['report'], stubs: generateOpsStubV2([], true) }, _nr: { functions: ['call'], stubs: NR_HOST_STUBS } },
    inputs: {},
    limits: { cpuTimeSec: 5, wallTimeSec: 20, maxMemoryMb: 64, maxToolCalls: 200, maxConcurrentCalls: 8, maxResultBytes: 1024 * 1024 },
    osPolicy: { datetime: '2026-11-26T12:00:00.000Z', seed: 1 },
    typeCheck: false,
  };
}

/** The contract-2 prelude in the real Monty executor (P4): error classes, Result/Page, pages(), line mapping. */
describe('contract-2 script prelude (Monty)', () => {
  let ex: LocalExecutor;
  const sig = () => new AbortController().signal;
  beforeAll(async () => {
    ex = await LocalExecutor.create({ poolMax: 2, prewarm: 1 });
  });
  afterAll(async () => {
    await ex.close();
  });

  for (const cls of SCRIPT_ERROR_CLASSES) {
    it(`${cls.name}: caught by name, by ${cls.base} and by ToolError; str(e) concise; ops.error(e) structured`, async () => {
      const code = cls.codes[0];
      const r = await ex.run(
        request(`out = []\ntry:\n    acme.get_order(order_id="${code}")\nexcept ${cls.name} as e:\n    i = ops.error(e)\n    out.append([str(e), i["code"], i["next"][0]["fn"], isinstance(e, ${cls.base})])\ntry:\n    acme.get_order(order_id="${code}")\nexcept ToolError as e:\n    out.append("tool_error")\nreturn out`),
        host(),
        sig(),
      );
      expect(r.status, JSON.stringify(r.error)).toBe('ok');
      expect(r.value).toEqual([[`${code}: failed for the test. Next: acme.list_orders(limit=20)`, code, 'acme.list_orders', true], 'tool_error']);
    });
  }

  it('ConfirmationRequired carries the plan', async () => {
    const r = await ex.run(request('try:\n    acme.get_order(order_id="confirmation_required")\nexcept ConfirmationRequired as e:\n    return ops.error(e)["plan"]'), host(), sig());
    expect(r.value).toEqual({ target: 'order order_9', reversible: false });
  });

  it('ops.error on a non-tool exception gives a script_error object', async () => {
    const r = await ex.run(request('try:\n    x = {}["k"]\nexcept KeyError as e:\n    return ops.error(e)["code"]'), host(), sig());
    expect(r.value).toBe('script_error');
  });

  it('pages(): .pages() follows next_cursor over 3 pages; max_items caps; Result.next() is None on the last page', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const r = await ex.run(request('a = acme.list_orders.pages(limit=4)\nb = acme.list_orders.pages({"limit": 4}, 6)\nlast = acme.list_orders.page(cursor="c_3")\nreturn [len(a), a[-1]["id"], len(b), last.page.has_more, last.next() is None, repr(last.page)]'), host(calls), sig());
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    expect(r.value).toEqual([12, 'order_12', 6, false, true, 'Page(count=4, total=12, has_more=False)']);
    expect(calls.filter((c) => c.host === '_nr.call').map((c) => (c.args as Record<string, unknown>).cursor ?? null)).toEqual([null, 'c_2', 'c_3', null, 'c_2', 'c_3']);
  });

  it('ops.report forwards kind and text', async () => {
    const calls: Array<Record<string, unknown>> = [];
    const r = await ex.run(request('return ops.report("blocked", "needs approval", reason="prod")'), host(calls), sig());
    expect(r.value).toEqual({ recorded: true });
    expect(calls).toEqual([{ host: 'ops.report', kind: 'blocked', text: 'needs approval', reason: 'prod' }]);
  });

  it('an uncaught tool error reports the user line, without prelude frames', async () => {
    const r = await ex.run(request('x = 1\ny = 2\nacme.get_order(order_id="not_found")\nreturn x'), host(), sig());
    expect(r.status).toBe('script_error');
    expect(r.error).toMatchObject({ type: 'LookupError', line: 3 });
    expect(r.error?.traceback).not.toMatch(/_nr_raise|__call__/);
  });
});
