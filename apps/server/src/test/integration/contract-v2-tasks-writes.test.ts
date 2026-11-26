import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { ConfirmTokens } from '../../dataplane/pipeline/confirm-token.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor, mcpClient, resetPg } from '../fakes/server.js';

const CONFIG = resolve(import.meta.dirname, '../fixtures/acme.neurouter.yaml');
const V2 = { 'x-neurouter-contract': '2' };
const ALL = ['tools:read', 'tools:write', 'code:run'] as const;
const PG = process.env.NEUROUTER_TEST_PG_URL;
type Env = Record<string, any>;

const env = async (c: ReturnType<typeof rawMcp>, name: string, args: Record<string, unknown> = {}): Promise<Env> => assertEnvelope((await c.call(name, args)).result, name);

/**
 * Contract 2, P3 (contract-v2 §2.4, §4.2, §4.3, §4.6; D1, D2, D5): tasks inferred without framing (per MCP session,
 * idle gap, closed by `neurouter_report`), the state block counted in the task row, `neurouter_report` per kind
 * (incl. eval isolation), confirm tokens for destructive calls outside prod (misuse, scripts), prod elicitation
 * unchanged, and the rate-limit budget in `state.left`.
 */
describe('contract 2: tasks, report, confirm tokens (acme, mock)', () => {
  let s: RunningServer;
  let key: string;
  const db = () => s.services.dbs.main.db;
  const mcp = (k = key, headers: Record<string, string> = {}) => rawMcp(`${s.url}/mcp/acme/mock`, k, { headers: { ...V2, ...headers } });

  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
    key = await keyFor(s, 'acme', 'mock', [...ALL]);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  describe('task inference without begin/end (D1)', () => {
    it('calls form one task; state counts in the task row; identical results streak; the first calls label it', async () => {
      const k = await keyFor(s, 'acme', 'mock', ['tools:read']);
      const c = mcp(k, { 'mcp-session-id': 'sess-a' });
      await c.initialize();
      const a = await env(c, 'search_tools', { query: 'find late orders' });
      const b = await env(c, 'get_order', { order_id: 'order_1' });
      const b2 = await env(c, 'get_order', { order_id: 'order_1' });
      expect(a.state).toMatchObject({ env: 'mock', writes: 'off', call: 1 });
      expect(b.state).toEqual({ task: a.state.task, call: 2 });
      expect(b2.state).toEqual({ task: a.state.task, call: 3, streak: 2 });
      await new Promise((r) => setTimeout(r, 50));
      const row = await db().selectFrom('tasks').selectAll().where('session_key', '=', 'sess-a').executeTakeFirstOrThrow();
      expect(row).toMatchObject({ framing: 'inferred', status: 'open', state_calls: 3, state_streak: 2 });
      expect(JSON.parse(String(row.inferred_label))).toMatchObject({ goal: 'Find: find late orders', model: 'neurouter:first-calls' });
    });

    it('another MCP session of the same credential and client is another task; an idle gap opens a new one', async () => {
      const k = await keyFor(s, 'acme', 'mock', ['tools:read']);
      const one = mcp(k, { 'mcp-session-id': 'sess-1' });
      const two = mcp(k, { 'mcp-session-id': 'sess-2' });
      await one.initialize();
      await two.initialize();
      const x = await env(one, 'get_order', { order_id: 'order_1' });
      const y = await env(two, 'get_order', { order_id: 'order_1' });
      expect(x.state.task).not.toBe(y.state.task);
      expect(y.state.call).toBe(1);
      expect((await env(one, 'get_order', { order_id: 'order_2' })).state).toMatchObject({ task: x.state.task, call: 2 });
      // 11 minutes of inactivity: the next call opens a new inferred task
      await db().updateTable('tasks').set({ last_activity_at: Date.now() - 11 * 60_000 }).where('session_key', '=', 'sess-1').execute();
      await new Promise((r) => setTimeout(r, 5100)); // the per-credential task cache lives 5 s
      const z = await env(one, 'get_order', { order_id: 'order_1' });
      expect(z.state.task).not.toBe(x.state.task);
      expect(z.state).toMatchObject({ call: 1, env: 'mock' });
    }, 20_000);

    it('neurouter_report(done|blocked) closes the task (success / partial + exit_kind); the next call starts a new one', async () => {
      const k = await keyFor(s, 'acme', 'mock', ['tools:read']);
      const c = mcp(k, { 'mcp-session-id': 'sess-report' });
      await c.initialize();
      const first = await env(c, 'get_order', { order_id: 'order_1' });
      const done = await env(c, 'neurouter_report', { kind: 'done', text: 'Order 1 is shipped' });
      expect(done.data).toMatchObject({ recorded: true, similar: 0 });
      const closed = await db().selectFrom('tasks').selectAll().where('id', '=', done.data.ref).executeTakeFirstOrThrow();
      expect(closed).toMatchObject({ status: 'closed', outcome: 'success', exit_kind: 'done', notes: 'Order 1 is shipped', session_key: 'sess-report' });
      const next = await env(c, 'get_order', { order_id: 'order_2' });
      expect(next.state.task).not.toBe(first.state.task);
      const blocked = await env(c, 'neurouter_report', { kind: 'blocked', text: 'ambiguous: which order?', reason: 'two matches' });
      expect(await db().selectFrom('tasks').select(['outcome', 'exit_kind', 'notes']).where('id', '=', blocked.data.ref).executeTakeFirstOrThrow()).toEqual({ outcome: 'partial', exit_kind: 'blocked', notes: 'ambiguous: which order? (two matches)' });
    });
  });

  describe('neurouter_report kinds (D2)', () => {
    it('is the only listed ops tool; the v1 names still answer; contract 1 does not know it', async () => {
      const c = mcp();
      await c.initialize();
      const names = (await c.list()).map((t) => String(t.name));
      expect(names.filter((n) => n.startsWith('neurouter_'))).toEqual(['neurouter_report']);
      expect((await env(c, 'neurouter_report_unmet_need', { intent: 'export as CSV' })).ok).toBe(true);
      const v1 = rawMcp(`${s.url}/mcp/acme/mock`, key);
      await v1.initialize();
      expect((await v1.list()).map((t) => t.name)).not.toContain('neurouter_report');
      expect((await v1.call('neurouter_report', { kind: 'done', text: 'x' })).error).toMatchObject({ code: -32602 });
    });

    it('each kind records like the v1 tool it replaces; eval traffic never reaches the inbox', async () => {
      const kinds = [
        { kind: 'unmet_need', text: 'export orders as CSV (report test)', attempted: ['search_tools'] },
        { kind: 'tool_problem', text: 'total looks wrong (report test)', tool: 'get_order' },
        { kind: 'decision', text: 'used list_orders (report test)', reason: 'no search tool' },
        { kind: 'blocked', text: 'needs the user (report test)' },
        { kind: 'done', text: 'finished (report test)' },
      ];
      const live = mcp(await keyFor(s, 'acme', 'mock', ['tools:read']));
      const ev = mcp(await keyFor(s, 'acme', 'mock', ['tools:read'], { purpose: 'eval' }));
      await live.initialize();
      await ev.initialize();
      for (const k of kinds) {
        await env(live, 'get_order', { order_id: 'order_1' });
        expect((await env(live, 'neurouter_report', k)).data.recorded, k.kind).toBe(true);
        await env(ev, 'get_order', { order_id: 'order_1' });
        expect((await env(ev, 'neurouter_report', { ...k, text: `${k.text} eval` })).data.recorded, k.kind).toBe(true);
      }
      const needs = await db().selectFrom('unmet_needs').select('intent').where('intent', 'like', '%(report test)%').execute();
      expect(needs.map((n) => n.intent)).toEqual(['export orders as CSV (report test)']);
      const issues = await db().selectFrom('issues').select('problem').where('problem', 'like', '%(report test)%').execute();
      expect(issues.map((n) => n.problem)).toEqual(['total looks wrong (report test)']);
      const evalTasks = await db().selectFrom('tasks').select(['origin', 'exit_kind']).where('notes', 'like', '%(report test) eval').execute();
      expect(evalTasks.map((t) => t.origin).sort()).toEqual(['eval', 'eval']);
      expect(evalTasks.map((t) => t.exit_kind).sort()).toEqual(['blocked', 'done']);
      await s.services.auditStore.flush();
      const audited = await s.services.dbs.audit.db.selectFrom('audit_log').select('tool_name').where('tool_name', '=', 'neurouter_report').execute();
      expect(audited.length).toBeGreaterThanOrEqual(10);
    });
  });

  describe('confirm tokens outside prod (D5)', () => {
    it('dry_run returns the plan and the confirmed call; without a token a destructive call answers confirmation_required', async () => {
      const c = mcp();
      await c.initialize();
      const dry = await env(c, 'cancel_order', { order_id: 'order_6', reason: 'other', dry_run: true });
      expect(dry.ok).toBe(true);
      expect(dry.data.plan).toMatchObject({ tool: 'cancel_order', target: 'order order_6', reversible: false });
      expect(dry.state.flags).toContain('dry_run');
      const run = await env(c, dry.data.next.tool, dry.data.next.args);
      expect(run.state.wrote).toBe('cancel_order → order order_6');
      // non-destructive writes run directly
      expect((await env(c, 'update_order', { order_id: 'order_7', note: 'x' })).ok).toBe(true);
    });

    it('misuse: other arguments, other principal, reused, expired → confirmation_required with a fresh token; nothing runs', async () => {
      const c = mcp();
      await c.initialize();
      const need = await env(c, 'cancel_order', { order_id: 'order_8', reason: 'other' });
      const token = need.error.next[0].args.confirm as string;
      expect(token).toMatch(/^ct_/);
      const other = await env(c, 'cancel_order', { order_id: 'order_9', reason: 'other', confirm: token });
      expect(other.error).toMatchObject({ code: 'confirmation_required' });
      expect(other.error.message).toMatch(/for another call/);
      const stranger = mcp(await keyFor(s, 'acme', 'mock', [...ALL]));
      await stranger.initialize();
      expect((await env(stranger, 'cancel_order', { order_id: 'order_8', reason: 'other', confirm: token })).error.message).toMatch(/for another call/);
      expect((await env(c, 'cancel_order', { order_id: 'order_8', reason: 'other', confirm: token })).ok).toBe(true);
      expect((await env(c, 'cancel_order', { order_id: 'order_8', reason: 'other', confirm: token })).error.message).toMatch(/already used/);
      // expired: a token minted with this server's key 6 minutes ago
      const row = await db().selectFrom('tasks').select('credential_key').where('state_calls', '>', 0).orderBy('last_activity_at', 'desc').executeTakeFirstOrThrow();
      const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'acme'))!;
      const mockEnv = (await s.services.servers.environments(srv.id)).find((e) => e.slug === 'mock')!;
      const old = new ConfirmTokens(db(), s.services.keyring, () => Date.now() - 6 * 60_000).mint({ tenantId: DEFAULT_TENANT_ID, environmentId: mockEnv.id, credentialKey: row.credential_key, tool: 'cancel_order', args: { order_id: 'order_10', reason: 'other' } });
      expect((await env(c, 'cancel_order', { order_id: 'order_10', reason: 'other', confirm: old })).error.message).toMatch(/expired/);
    });

    it('run_script: destructive inner calls run only with the token of the script dry run (per plan)', async () => {
      const c = mcp();
      await c.initialize();
      const code = 'return acme.cancel_order(order_id="order_11", reason="other")';
      const need = await env(c, 'run_script', { code });
      expect(need.error).toMatchObject({ code: 'confirmation_required' });
      expect(need.data.plan[0]).toMatchObject({ tool: 'cancel_order', target: 'order order_11' });
      const otherCode = await env(c, 'run_script', { code: code.replace('order_11', 'order_12'), confirm: need.error.next[0].args.confirm });
      expect(otherCode.error.message).toMatch(/another script or plan/);
      const ok = await env(c, 'run_script', need.error.next[0].args);
      expect(ok.ok, JSON.stringify(ok.error)).toBe(true);
      expect(ok.state.script_calls).toBe(1);
      // a dry run hands back the confirmed execute call
      const dry = await env(c, 'run_script', { code: code.replace('order_11', 'order_13'), mode: 'dry_run' });
      expect(dry.data.next.args).toMatchObject({ mode: 'execute', confirm: expect.stringMatching(/^ct_/) });
      expect((await env(c, 'run_script', dry.data.next.args)).ok).toBe(true);
      // reads-only scripts are not gated
      expect((await env(c, 'run_script', { code: 'return len(acme.list_orders(limit=2)["items"])' })).data).toBe(2);
    });

    it('prod keeps human elicitation: a confirm token is never accepted, the prompt names effect and reversibility', async () => {
      const prodKey = await keyFor(s, 'acme', 'prod', [...ALL]);
      const asked: string[] = [];
      const client = await mcpClient(s, 'acme', 'prod', prodKey, { elicitation: true, era: 'modern', headers: V2, onElicit: (m) => (asked.push(m), { approve: false }) });
      const devToken = (await env(mcp(), 'cancel_order', { order_id: 'order_14', reason: 'other' })).error.next[0].args.confirm;
      const r = await client.callTool({ name: 'cancel_order', arguments: { order_id: 'order_14', reason: 'other', confirm: devToken } });
      const e = assertEnvelope(r, 'prod_declined');
      expect(e.error).toMatchObject({ code: 'confirmation_declined' });
      expect(asked).toHaveLength(1);
      expect(asked[0]).toMatch(/Effect: Cancels an order/);
      expect(asked[0]).toMatch(/Irreversible\./);
      const noElicit = rawMcp(`${s.url}/mcp/acme/prod`, prodKey, { headers: V2 });
      await noElicit.initialize();
      const u = await env(noElicit, 'cancel_order', { order_id: 'order_14', reason: 'other', confirm: devToken });
      expect(u.error).toMatchObject({ code: 'confirmation_unsupported', next: [{ tool: 'neurouter_report', args: { kind: 'blocked' } }] });
      expect(u.data.plan).toMatchObject({ reversible: false, effect: expect.stringMatching(/refunded/) });
    });
  });

  it('state.left: the rate-limit budget shows once a bucket is down to 20%', async () => {
    const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'acme'))!;
    const row = (await s.services.servers.environments(srv.id)).find((e) => e.slug === 'mock')!;
    await db().updateTable('environments').set({ limits: JSON.stringify({ toolRateLimit: { perMinute: 5, burst: 5 } }) }).where('id', '=', row.id).execute();
    s.services.runtime.invalidate();
    try {
      const c = mcp(await keyFor(s, 'acme', 'mock', ['tools:read']));
      await c.initialize();
      const lefts: unknown[] = [];
      for (let i = 0; i < 6; i++) lefts.push((await env(c, 'get_product', { sku: 'product_1' })).state.left);
      expect(lefts).toEqual([undefined, undefined, undefined, { calls: 1 }, { calls: 0 }, { calls: 0 }]);
    } finally {
      await db().updateTable('environments').set({ limits: JSON.stringify({}) }).where('id', '=', row.id).execute();
      s.services.runtime.invalidate();
    }
  });
});

/** Two instances on one database count one task: call numbers and streaks continue across instances (P1 counted per instance). */
describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('task state across two instances (%s)', (_d, pgUrl) => {
  let a: RunningServer;
  let b: RunningServer;
  let dir: string | null = null;
  beforeAll(async () => {
    let url: string;
    if (pgUrl) url = await resetPg(pgUrl, 'nr_it_task_state');
    else {
      dir = mkdtempSync(join(tmpdir(), 'nr-task-state-'));
      url = `sqlite:${join(dir, 'neurouter.db')}`;
    }
    const shared = { NEUROUTER_CONFIG: CONFIG, DATABASE_URL: url, NEUROUTER_MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`, HASH_PEPPER: randomBytes(32).toString('base64url'), NEUROUTER_EXECUTOR_MODE: 'off' };
    a = await bootServer(shared);
    b = await bootServer(shared);
  }, 90_000);
  afterAll(async () => {
    await a?.close();
    await b?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('one inferred task; calls alternate between instances and count 1..4; the streak spans both; a token minted on one is spent once', async () => {
    const k = await keyFor(a, 'acme', 'mock', ['tools:read', 'tools:write']);
    const ca = rawMcp(`${a.url}/mcp/acme/mock`, k, { headers: { ...V2, 'mcp-session-id': 'multi' } });
    const cb = rawMcp(`${b.url}/mcp/acme/mock`, k, { headers: { ...V2, 'mcp-session-id': 'multi' } });
    await ca.initialize();
    await cb.initialize();
    const s1 = await env(ca, 'get_order', { order_id: 'order_1' });
    const s2 = await env(cb, 'get_order', { order_id: 'order_1' });
    const s3 = await env(ca, 'get_order', { order_id: 'order_1' });
    const s4 = await env(cb, 'get_customer', { customer_id: 'customer_1' });
    expect([s1, s2, s3, s4].map((x) => x.state.call)).toEqual([1, 2, 3, 4]);
    expect(new Set([s1, s2, s3, s4].map((x) => x.state.task)).size).toBe(1);
    expect(s2.state.streak).toBe(2);
    expect(s3.state.streak).toBe(3);
    expect(s4.state.streak).toBeUndefined();
    const need = await env(ca, 'cancel_order', { order_id: 'order_2', reason: 'other' });
    expect((await env(cb, need.error.next[0].tool, need.error.next[0].args)).ok).toBe(true);
    expect((await env(ca, need.error.next[0].tool, need.error.next[0].args)).error.message).toMatch(/already used/);
  });
});
