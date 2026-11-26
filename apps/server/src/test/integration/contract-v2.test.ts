import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RunningServer } from '../../server.js';
import { loadConfig } from '../../kernel/config/load.js';
import { parseExposure } from '../../kernel/runtime-config.js';
import { ADVERTISED_ENVELOPE_SCHEMA } from '../../dataplane/envelope/schema.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor, mcpClient, REPO_ROOT } from '../fakes/server.js';

const CONFIG = resolve(import.meta.dirname, '../fixtures/acme.neurouter.yaml');
const V2 = { 'x-neurouter-contract': '2' };
const ALL = ['tools:read', 'tools:write', 'code:run'] as const;
const CAP_V2 = { experimental: { 'dev.neurouter/contract': { versions: [2, 1] } } };
type Env = Record<string, any>;

describe('contract 2 (acme, mock)', () => {
  let s: RunningServer;
  let url: string;
  let key: string;
  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
    url = `${s.url}/mcp/acme/mock`;
    key = await keyFor(s, 'acme', 'mock', [...ALL]);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  const setServerExposure = async (patch: Record<string, unknown>) => {
    const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'acme'))!;
    const cur: Record<string, unknown> = { ...parseExposure(srv.exposure) };
    const next = { ...cur, ...patch };
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k];
    await s.services.dbs.main.db.updateTable('servers').set({ exposure: JSON.stringify(next) }).where('id', '=', srv.id).execute();
    s.services.runtime.invalidate();
  };
  const setEnvOverride = async (env: string, value: Record<string, unknown> | null) => {
    const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'acme'))!;
    const row = (await s.services.servers.environments(srv.id)).find((e) => e.slug === env)!;
    await s.services.dbs.main.db.updateTable('environments').set({ discovery_override: value ? JSON.stringify(value) : null }).where('id', '=', row.id).execute();
    s.services.runtime.invalidate();
  };
  const instructionsOf = (r: Env) => String(r.result.instructions);

  describe('negotiation (contract-v2 §1)', () => {
    it('an existing server serves 1; the client capability or the header picks 2; the highest common version wins', async () => {
      const c = rawMcp(url, key);
      const v1 = await c.initialize();
      expect(instructionsOf(v1)).toMatch(/^This MCP server exposes/);
      expect(v1.result).not.toHaveProperty('serverInfo._meta');
      expect((await c.list()).map((t) => t.name)).toContain('neurouter_begin_task');
      // capability (legacy: remembered from initialize for the following stateless requests)
      const cap = rawMcp(url, key, { headers: { 'mcp-session-id': 'cap-v2' } });
      const init = await cap.initialize(CAP_V2);
      expect(instructionsOf(init)).toMatch(/^Neurouter contract 2\./);
      expect(init.result).toMatchObject({ serverInfo: { _meta: { 'dev.neurouter/contract': 2 } } });
      const names = (await cap.list()).map((t) => t.name);
      expect(names).not.toContain('neurouter_begin_task');
      expect(names).not.toContain('neurouter_read_result');
      assertEnvelope((await cap.call('get_order', { order_id: 'order_1' })).result);
      // header, and a list
      expect(instructionsOf(await rawMcp(url, key, { headers: { 'x-neurouter-contract': '2,1' } }).initialize())).toMatch(/^Neurouter contract 2/);
      // nothing in common → the setting
      const none = rawMcp(url, key, { headers: { 'mcp-session-id': 'cap-v3' } });
      expect(instructionsOf(await none.initialize({ experimental: { 'dev.neurouter/contract': { versions: [3] } } }))).toMatch(/^This MCP server exposes/);
      // the client can also ask for 1 explicitly
      const v1h = rawMcp(url, key, { headers: { 'x-neurouter-contract': '1' } });
      expect((await v1h.call('get_invoice', {})).error).toMatchObject({ code: -32602 });
    });

    it('the server setting and the environment override choose the default; tools/list and def-hashes follow', async () => {
      const c = rawMcp(url, key);
      const before = await c.list();
      await setServerExposure({ contract: 2 });
      const after = await c.list();
      expect(instructionsOf(await c.initialize())).toMatch(/^Neurouter contract 2/);
      const hash = (l: Env[], n: string) => l.find((t) => t.name === n)?._meta?.['dev.neurouter/def-hash'];
      expect(hash(after, 'get_order')).toBeDefined();
      expect(hash(after, 'get_order')).not.toBe(hash(before, 'get_order'));
      // the client can still ask for 1
      expect(instructionsOf(await rawMcp(url, key, { headers: { 'x-neurouter-contract': '1' } }).initialize())).toMatch(/^This MCP server exposes/);
      // environment override wins over the server
      await setEnvOverride('mock', { contract: 1 });
      expect(instructionsOf(await c.initialize())).toMatch(/^This MCP server exposes/);
      await setEnvOverride('mock', null);
      await setServerExposure({ contract: 1 });
    });

    it('a modern (2026-07-28) client negotiates with its per-request capabilities and gets envelopes from the SDK client', async () => {
      const client = await mcpClient(s, 'acme', 'mock', key, { era: 'modern', headers: V2 });
      const res = await client.callTool({ name: 'list_orders', arguments: { limit: 1 } });
      const env = assertEnvelope(res);
      expect(env.page).toMatchObject({ count: 1, has_more: true });
      // a direct unknown tool is an envelope, not a JSON-RPC error
      const unknown = await client.callTool({ name: 'get_invoice', arguments: {} });
      expect(assertEnvelope(unknown).error).toMatchObject({ code: 'unknown_tool' });
      await client.close();
    });

    it('new servers default to contract 2 (NEUROUTER_NEW_SERVER_CONTRACT); the file keeps the stored contract of existing servers', async () => {
      expect(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:' }).env.NEUROUTER_NEW_SERVER_CONTRACT).toBe(2);
      const dir = mkdtempSync(join(tmpdir(), 'nr-contract-'));
      const spec = resolve(REPO_ROOT, 'examples/petstore/openapi.yaml');
      const file = join(dir, 'neurouter.yaml');
      writeFileSync(file, `version: 1\nservers:\n  - slug: pets\n    name: Pets\n    spec: { path: ${JSON.stringify(spec)} }\n    environments: [{ slug: dev, kind: dev, baseUrl: "mock:" }]\n`);
      const fresh = await bootServer({ NEUROUTER_CONFIG: file, NEUROUTER_NEW_SERVER_CONTRACT: '2', NEUROUTER_EXECUTOR_MODE: 'off' });
      try {
        const exposure = async () => parseExposure((await fresh.services.servers.bySlug(DEFAULT_TENANT_ID, 'pets'))!.exposure);
        expect((await exposure()).contract).toBe(2);
        const k = await keyFor(fresh, 'pets', 'dev', ['tools:read']);
        expect(instructionsOf(await rawMcp(`${fresh.url}/mcp/pets/dev`, k).initialize())).toMatch(/^Neurouter contract 2/);
        // an existing server without a stored contract (created before contract 2) stays on 1 when the file is applied again
        const srv = (await fresh.services.servers.bySlug(DEFAULT_TENANT_ID, 'pets'))!;
        await fresh.services.dbs.main.db.updateTable('servers').set({ exposure: JSON.stringify({ mode: 'auto', discovery: 'auto', pinned: [] }) }).where('id', '=', srv.id).execute();
        await fresh.services.configSync.loadFile(file);
        expect((await exposure()).contract).toBeUndefined();
        // the file can set it explicitly
        writeFileSync(file, `version: 1\nservers:\n  - slug: pets\n    name: Pets\n    spec: { path: ${JSON.stringify(spec)} }\n    exposure: { contract: 2, outputSchema: none }\n    environments: [{ slug: dev, kind: dev, baseUrl: "mock:", contract: 1 }]\n`);
        await fresh.services.configSync.loadFile(file);
        expect(await exposure()).toMatchObject({ contract: 2, outputSchema: 'none' });
        fresh.services.runtime.invalidate();
        expect(instructionsOf(await rawMcp(`${fresh.url}/mcp/pets/dev`, k).initialize())).toMatch(/^This MCP server exposes/);
      } finally {
        await fresh.close();
      }
    }, 60_000);
  });

  describe('every error carries a next call that works (contract-v2 §2.3)', () => {
    const c = () => rawMcp(url, key, { headers: V2 });
    const follow = async (client: ReturnType<typeof rawMcp>, tool: string, args: Record<string, unknown>, code: string) => {
      const env = assertEnvelope((await client.call(tool, args)).result, `${tool} → ${code}`);
      expect(env.error?.code, tool).toBe(code);
      expect(env.error.next.length, `${tool}: next`).toBeGreaterThan(0);
      const n = env.error.next[0];
      const out = assertEnvelope((await client.call(n.tool, n.args)).result, `next of ${code}: ${n.tool}`);
      expect(out.ok, `${code}: next ${JSON.stringify(n)} → ${JSON.stringify(out.error)}`).toBe(true);
      return { env, out };
    };

    it('invalid_args (enum, range, type, renamed argument), not_found, unknown_tool', async () => {
      const m = c();
      await follow(m, 'list_orders', { status: 'open', limit: 500 }, 'invalid_args');
      await follow(m, 'list_orders', { status: 'shiped' }, 'invalid_args');
      await follow(m, 'list_orders', { limit: 'x' }, 'invalid_args');
      await follow(m, 'get_order', { orderId: 'order_2' }, 'invalid_args');
      await follow(m, 'count_orders', { status: 'nope' }, 'invalid_args');
      await follow(m, 'call_tool', { name: 'list_orders', arguments: { limit: 0 } }, 'invalid_args');
      for (const [tool, args] of [['get_order', { order_id: 'nope' }], ['get_customer', { customer_id: 'nope' }], ['get_product', { sku: 'nope' }]] as const) {
        await follow(m, tool, args, 'not_found');
      }
      const { out } = await follow(m, 'get_ordr', { order_id: 'order_1' }, 'unknown_tool');
      expect(out.data.tools.map((t: { name: string }) => t.name)).toContain('get_order');
    });

    it('writes_disabled and forbidden point at the read of the same entity', async () => {
      await follow(rawMcp(`${s.url}/mcp/acme/ro`, await keyFor(s, 'acme', 'ro', [...ALL]), { headers: V2 }), 'cancel_order', { order_id: 'order_1', reason: 'other' }, 'writes_disabled');
      await follow(rawMcp(url, await keyFor(s, 'acme', 'mock', ['tools:read']), { headers: V2 }), 'cancel_order', { order_id: 'order_1', reason: 'other' }, 'forbidden');
    });

    it('scripts: an uncaught tool error keeps its code; next is the run_script call of the fix', async () => {
      const m = c();
      const { out } = await follow(m, 'run_script', { code: 'return acme.get_order(order_id="ord_nope")' }, 'not_found');
      // 20 orders are over the 8,192-char script result budget (B3): the first ones, the rest counted in truncated
      expect(out.data.items.length + (out.truncated?.fields?.length ? 0 : (out.truncated?.items_omitted ?? 0))).toBe(20);
      await follow(m, 'run_script', { code: 'return acme.list_orders(limit=500)' }, 'invalid_args');
    });

    it('page.next_cursor returns the cut part as further pages of the same tool', async () => {
      const m = c();
      let env = assertEnvelope((await m.call('list_products', {})).result);
      const seen: string[] = [];
      for (let i = 0; i < 10; i++) {
        seen.push(...env.data.items.map((p: { sku: string }) => p.sku));
        if (!env.page.has_more) break;
        env = assertEnvelope((await m.call('list_products', { cursor: env.page.next_cursor })).result);
      }
      expect(new Set(seen).size).toBe(20);
      expect(env.page).toMatchObject({ count: 2, total: 20, has_more: false, next_cursor: null });
      expect(env.truncated).toBeNull();
    });

    it('rate_limited: retry after the wait, with retry_after_ms and the same call as next', async () => {
      await setEnvOverride('mock', null);
      const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'acme'))!;
      const row = (await s.services.servers.environments(srv.id)).find((e) => e.slug === 'mock')!;
      await s.services.dbs.main.db.updateTable('environments').set({ limits: JSON.stringify({ toolRateLimit: { perMinute: 1, burst: 1 } }) }).where('id', '=', row.id).execute();
      s.services.runtime.invalidate();
      try {
        const m = rawMcp(url, await keyFor(s, 'acme', 'mock', ['tools:read']), { headers: V2 });
        assertEnvelope((await m.call('get_product', { sku: 'product_1' })).result);
        const env = assertEnvelope((await m.call('get_product', { sku: 'product_1' })).result);
        expect(env.error).toMatchObject({ code: 'rate_limited', retry: 'after_wait', next: [{ tool: 'get_product', args: { sku: 'product_1' } }] });
        expect(env.error.retry_after_ms).toBeGreaterThan(0);
      } finally {
        await s.services.dbs.main.db.updateTable('environments').set({ limits: JSON.stringify({}) }).where('id', '=', row.id).execute();
        s.services.runtime.invalidate();
      }
    });
  });

  describe('exposure.outputSchema (contract-v2 §2.5, D3)', () => {
    const ajv = new Ajv2020({ strict: false, allowUnionTypes: true });
    it('envelope (default): every listed tool advertises the shared envelope schema and every result validates against it', async () => {
      const m = rawMcp(url, key, { headers: V2 });
      const list = await m.list();
      for (const t of list) expect(t.outputSchema, t.name as string).toEqual(ADVERTISED_ENVELOPE_SCHEMA);
      const validate = ajv.compile(ADVERTISED_ENVELOPE_SCHEMA);
      const calls: Array<[string, Record<string, unknown>]> = [
        ['get_order', { order_id: 'order_1' }],
        ['list_orders', { status: 'nope' }],
        ['get_customer', { customer_id: 'customer_2' }],
        ['search_tools', { query: 'orders' }],
        ['run_script', { code: 'return 1' }],
        ['neurouter_report_unmet_need', { intent: 'x' }],
        ['count_orders', { status: 'paid' }],
      ];
      for (const [tool, args] of calls) expect(validate(assertEnvelope((await m.call(tool, args)).result).valueOf()), tool).toBe(true);
    });

    it('none: no outputSchema; typed: the shaped data schema, validated before sending', async () => {
      await setServerExposure({ outputSchema: 'none' });
      expect((await rawMcp(url, key, { headers: V2 }).list()).filter((t) => t.outputSchema)).toEqual([]);
      await setServerExposure({ outputSchema: 'typed' });
      const typed = await rawMcp(url, key, { headers: V2 }).list();
      const getOrder = typed.find((t) => t.name === 'get_order')!;
      expect(getOrder.outputSchema).toMatchObject({ then: { properties: { data: { type: 'object' } } } });
      expect(typed.find((t) => t.name === 'search_tools' || t.name === 'run_script')?.outputSchema).toEqual(ADVERTISED_ENVELOPE_SCHEMA);
      // v1 sessions on a typed server list the per-tool data schema (the former NEUROUTER_OUTPUT_SCHEMA=typed)
      expect((await rawMcp(url, key).list()).find((t) => t.name === 'get_order')!.outputSchema).toMatchObject({ type: 'object', properties: { id: { type: 'string' } } });
      // the SDK client validates structuredContent against the typed schema
      const client = await mcpClient(s, 'acme', 'mock', key, { headers: V2 });
      await client.listTools();
      expect(assertEnvelope(await client.callTool({ name: 'get_order', arguments: { order_id: 'order_1' } })).state.flags).toBeUndefined();
      await client.close();
    });

    it('typed: a response that does not match is sent flagged (never rejected), logged as a tool issue, and the tool is re-listed without outputSchema', async () => {
      await setServerExposure({ outputSchema: 'typed' });
      const bundle = (await s.services.runtime.get(DEFAULT_TENANT_ID, 'acme', 'mock'))!;
      const tool = bundle.build.tools.find((t) => t.name === 'get_product')!;
      // an upstream that deviates from its spec: the declared schema requires a field the API does not send
      tool.outputSchema = { ...tool.outputSchema, required: ['sku', 'barcode'], properties: { ...((tool.outputSchema?.properties as object) ?? {}), barcode: { type: 'string' } } };
      const publish = vi.spyOn(s.services.bus, 'publish');
      const client = await mcpClient(s, 'acme', 'mock', key, { headers: V2 });
      const listed = await client.listTools();
      expect(listed.tools.find((t) => t.name === 'get_product')!.outputSchema).toMatchObject({ then: { properties: { data: { required: ['sku', 'barcode'] } } } });
      const res = await client.callTool({ name: 'get_product', arguments: { sku: 'product_1' } });
      const env = assertEnvelope(res);
      expect(env.ok).toBe(true);
      expect(env.state.flags).toEqual(['schema_mismatch']);
      expect(publish).toHaveBeenCalledWith({ kind: 'tools_list_changed' });
      const relisted = await client.listTools();
      expect(relisted.tools.find((t) => t.name === 'get_product')!.outputSchema).toBeUndefined();
      await client.close();
      await vi.waitFor(async () => {
        const issue = await s.services.dbs.main.db.selectFrom('issues').select(['tool_name', 'problem']).where('tool_name', '=', 'get_product').executeTakeFirst();
        expect(issue?.problem).toMatch(/does not match the typed outputSchema/);
      });
      publish.mockRestore();
      await setServerExposure({ outputSchema: undefined });
    });
  });
});

describe('tools/list size, contract 1 vs 2 (examples)', () => {
  it('acme-orders and the GitHub subset with the agent-ready overlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-sizes-'));
    const file = join(dir, 'neurouter.yaml');
    const gh = resolve(REPO_ROOT, 'examples/github');
    writeFileSync(
      file,
      [
        'version: 1',
        'servers:',
        `  - { slug: acme, name: Acme Orders, spec: { path: ${JSON.stringify(resolve(REPO_ROOT, 'examples/acme-orders/openapi.yaml'))} }, exposure: { contract: 1 }, environments: [{ slug: mock, kind: dev, baseUrl: "mock:", writes: { enabled: true } }] }`,
        `  - { slug: github, name: GitHub REST, spec: { path: ${JSON.stringify(join(gh, 'github-subset.json'))} }, overlay: ${JSON.stringify(join(gh, 'agent-ready.overlay.yaml'))}, exposure: { contract: 1 }, environments: [{ slug: mock, kind: dev, baseUrl: "mock:", writes: { enabled: true } }] }`,
      ].join('\n'),
    );
    const s = await bootServer({ NEUROUTER_CONFIG: file });
    const rows: Array<Record<string, unknown>> = [];
    try {
      for (const slug of ['acme', 'github']) {
        const k = await keyFor(s, slug, 'mock', [...ALL]);
        const size = async (headers: Record<string, string>) => {
          const list = await rawMcp(`${s.url}/mcp/${slug}/mock`, k, { headers }).list();
          return { tools: list.length, bytes: Buffer.byteLength(JSON.stringify(list)) };
        };
        const set = async (outputSchema: string | undefined) => {
          const srv = (await s.services.servers.bySlug(DEFAULT_TENANT_ID, slug))!;
          await s.services.dbs.main.db.updateTable('servers').set({ exposure: JSON.stringify({ ...parseExposure(srv.exposure), ...(outputSchema ? { outputSchema } : {}) }) }).where('id', '=', srv.id).execute();
          s.services.runtime.invalidate();
        };
        const v1 = await size({});
        const v2 = await size(V2);
        await set('none');
        const v2none = await size(V2);
        await set('typed');
        const v1typed = await size({});
        const v2typed = await size(V2);
        await set(undefined);
        rows.push({ server: slug, v1, v1typed, v2_envelope: v2, v2_none: v2none, v2_typed: v2typed });
        // the shared envelope schema costs ~0.3 KB per listed tool; typed is the old per-tool schema plus the envelope
        expect(v2.bytes - v2none.bytes).toBeLessThanOrEqual(v2.tools * (JSON.stringify(ADVERTISED_ENVELOPE_SCHEMA).length + 40));
        expect(v2.bytes).toBeLessThan(v1typed.bytes);
      }
      console.log(`tools/list sizes (bytes of the tools array):\n${JSON.stringify(rows, null, 1)}`);
    } finally {
      await s.close();
    }
  }, 120_000);
});
