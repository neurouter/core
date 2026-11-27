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
 * 0.3.4, B1: contract 2 outside prod with writes on (confirm `none`) and a destructive tool callable, every `execute`
 * run is dry-run first (D5). The dry run's reads are real upstream calls, so the long-workflow probe's GitHub n200
 * script made 180 upstream calls for 90 needed. Now: a dry run that planned no writes IS the execute (its result,
 * labelled as one); with writes planned, the execute pass reuses the dry run's read responses until its first write.
 * The `mock` environment of the acme fixture has writes on and `cancel_order` (destructive) callable.
 */
describe('contract 2: run_script reads reach the upstream once (B1)', () => {
  let s: RunningServer;
  let key: string;
  const run = async (code: string, extra: Record<string, unknown> = {}): Promise<Env> => {
    const c = rawMcp(`${s.url}/mcp/acme/mock`, key, { headers: V2 });
    await c.initialize();
    return assertEnvelope((await c.call('run_script', { code, ...extra })).result, 'run_script');
  };
  const audit = async () => {
    await s.services.auditStore.flush();
    return s.services.dbs.audit.db.selectFrom('audit_log').select(['seq', 'kind', 'tool_name', 'decision', 'status', 'dry_run', 'script_run_id']).orderBy('seq').execute();
  };
  /** Runs `fn`, returning the audit rows it added and its upstream calls (tool calls that were not dry runs or refusals). */
  const measured = async <T>(fn: () => Promise<T>) => {
    const before = (await audit()).at(-1)?.seq ?? 0;
    const out = await fn();
    const rows = (await audit()).filter((r) => r.seq > before);
    const upstream = rows.filter((r) => r.kind === 'tool_call' && (r.decision === 'allowed' || r.decision === 'confirmed'));
    return { out, rows, upstream: upstream.map((r) => r.tool_name), scripts: rows.filter((r) => r.kind === 'script_run') };
  };
  const scriptRuns = async (ids: Array<string | null>) =>
    s.services.dbs.main.db.selectFrom('script_runs').select(['id', 'mode', 'status', 'stats']).where('id', 'in', ids.filter((x): x is string => !!x)).execute();

  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
    key = await keyFor(s, 'acme', 'mock', [...ALL]);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('the gate applies here: run_script is destructive and takes a confirm token', async () => {
    const c = rawMcp(`${s.url}/mcp/acme/mock`, key, { headers: { ...V2, 'x-neurouter-exposure': 'code' } });
    await c.initialize();
    const rs = ((await c.list()) as Array<{ name: string; annotations: Env; inputSchema: Env }>).find((t) => t.name === 'run_script')!;
    expect(rs.annotations.destructiveHint).toBe(true);
    expect(rs.inputSchema.properties.confirm).toBeTruthy();
  });

  it('(a) read-only script: each read reaches the upstream once; the run is recorded as one execute', async () => {
    const code = 'o = acme.get_order(order_id="order_1")\nr = acme.list_orders.page(limit=3)\nc = acme.list_customers.page(limit=2)\nprint("seen", o["id"])\nreturn [o["id"], len(r.items), len(c.items)]';
    const m = await measured(() => run(code));
    expect(m.out.ok, JSON.stringify(m.out.error)).toBe(true);
    expect(m.out.data).toEqual(['order_1', 3, 2]);
    expect(m.out.logs).toContain('seen order_1');
    expect(m.out.state.flags ?? []).not.toContain('dry_run');
    expect(m.out.state.script_calls).toBe(3);
    expect(m.upstream).toEqual(['get_order', 'list_orders', 'list_customers']);
    // one script_run audit row: an execute (decision allowed, not a dry run), and one script_runs row in mode execute
    expect(m.scripts).toHaveLength(1);
    expect(m.scripts[0]).toMatchObject({ decision: 'allowed', status: 'ok', dry_run: 0 });
    const rows = await scriptRuns(m.scripts.map((x) => x.script_run_id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ mode: 'execute', status: 'ok' });
    expect(JSON.parse(rows[0]!.stats)).toMatchObject({ toolCalls: 3 });
    // the inner calls belong to that run
    expect(m.rows.filter((r) => r.kind === 'tool_call').every((r) => r.script_run_id === m.scripts[0]!.script_run_id)).toBe(true);
  });

  it('(a) a failing read-only script is one execute too (its error, no dry_run label)', async () => {
    const m = await measured(() => run('o = acme.get_order(order_id="order_1")\nacme.get_order(order_id="ord_nope")\nreturn 1'));
    expect(m.out.ok).toBe(false);
    expect(m.out.error.code).toBe('not_found');
    expect(m.upstream).toEqual(['get_order', 'get_order']);
    expect(m.scripts).toHaveLength(1);
    expect(m.scripts[0]).toMatchObject({ decision: 'allowed', dry_run: 0 });
  });

  it('(b) non-destructive writes: the execute pass reuses the dry run reads; reads after a write go upstream', async () => {
    const code = 'a = acme.get_order(order_id="order_2")\nb = acme.list_orders.page(limit=2)\nu = acme.update_order(order_id="order_2", note="b1-checked")\nafter = acme.get_order(order_id="order_2")\nreturn [a["id"], len(b.items), "plan" in u, after.get("note")]';
    const m = await measured(() => run(code));
    expect(m.out.ok, JSON.stringify(m.out.error)).toBe(true);
    // the real run: the update happened and the read after it sees it
    expect(m.out.data).toEqual(['order_2', 2, false, 'b1-checked']);
    expect(m.out.state.flags ?? []).not.toContain('dry_run');
    // dry run: get_order, list_orders (real), update planned, get_order (real); execute: the first two reused,
    // update_order and the read after it upstream
    expect(m.upstream).toEqual(['get_order', 'list_orders', 'get_order', 'update_order', 'get_order']);
    expect(m.scripts.map((x) => x.decision)).toEqual(['dry_run', 'allowed']);
    const rows = await scriptRuns(m.scripts.map((x) => x.script_run_id));
    const exec = rows.find((r) => r.mode === 'execute')!;
    expect(JSON.parse(exec.stats)).toMatchObject({ toolCalls: 4, replayedReads: 2 });
  });

  it('(c) destructive: the token round is unchanged; the confirmed run reuses its own dry run reads', async () => {
    const code = 'o = acme.get_order(order_id="order_7")\nc = acme.cancel_order(order_id="order_7", reason="other")\nreturn [o["id"], c.get("status")]';
    const gate = await measured(() => run(code));
    expect(gate.out.ok, JSON.stringify(gate.out)).toBe(false);
    expect(gate.out.error.code).toBe('confirmation_required');
    expect(gate.out.data.plan[0]).toMatchObject({ tool: 'cancel_order', target: 'order order_7' });
    expect(gate.upstream).toEqual(['get_order']);
    expect(gate.scripts.map((x) => x.decision)).toEqual(['dry_run']);
    const done = await measured(() => run(code, { confirm: gate.out.error.next[0].args.confirm }));
    expect(done.out.ok, JSON.stringify(done.out.error)).toBe(true);
    expect(done.out.data).toEqual(['order_7', 'cancelled']);
    // the plan is re-checked by a dry run (its read is real), then the confirmed run reuses that read
    expect(done.upstream).toEqual(['get_order', 'cancel_order']);
    expect(done.scripts.map((x) => x.decision)).toEqual(['dry_run', 'confirmed']);
  });

  it('an explicit dry run stays a dry run (labelled, plan returned)', async () => {
    const m = await measured(() => run('o = acme.get_order(order_id="order_3")\nreturn o["id"]', { mode: 'dry_run' }));
    expect(m.out.ok).toBe(true);
    expect(m.out.data.result).toBe('order_3');
    expect(m.out.state.flags).toContain('dry_run');
    expect(m.scripts.map((x) => x.decision)).toEqual(['dry_run']);
    expect(m.upstream).toEqual(['get_order']);
  });

  it('no cross-run reuse: the same read-only script twice reaches the upstream twice', async () => {
    const code = 'return acme.get_order(order_id="order_4")["id"]';
    const one = await measured(() => run(code));
    const two = await measured(() => run(code));
    expect([one.upstream, two.upstream]).toEqual([['get_order'], ['get_order']]);
  });
});
