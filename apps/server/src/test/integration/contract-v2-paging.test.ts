import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const SPEC = resolve(import.meta.dirname, '../fixtures/paging.openapi.yaml');
const V2 = { 'x-neurouter-contract': '2' };
type Env = Record<string, any>;

/** A real upstream for the styles the mock cannot show: absolute `Link` URLs and opaque tokens (12 items each). */
function fakeUpstream(): Promise<{ server: Server; port: number; seen: string[] }> {
  const seen: string[] = [];
  const items = Array.from({ length: 12 }, (_, i) => ({ id: `g_${i + 1}`, name: `Gadget ${i + 1}` }));
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    seen.push(`${u.pathname}${u.search}`);
    const port = (server.address() as { port: number }).port;
    res.setHeader('content-type', 'application/json');
    if (u.pathname === '/api/gadgets') {
      const page = Number(u.searchParams.get('page') ?? 1);
      const per = Number(u.searchParams.get('per_page') ?? 5);
      const last = Math.ceil(items.length / per);
      // GitHub-style: absolute Link URLs (the last one also carries a parameter the tool does not declare)
      if (page < last) res.setHeader('link', `<http://127.0.0.1:${port}/api/gadgets?page=${page + 1}&per_page=${per}&sig=abc>; rel="next", <http://127.0.0.1:${port}/api/gadgets?page=${last}&per_page=${per}>; rel="last"`);
      res.end(JSON.stringify(items.slice((page - 1) * per, page * per)));
      return;
    }
    if (u.pathname === '/api/widgets') {
      const from = u.searchParams.get('cursor') ? Number(Buffer.from(u.searchParams.get('cursor')!, 'base64url').toString().split(':')[1]) : 0;
      const n = Number(u.searchParams.get('limit') ?? 5);
      const page = items.slice(from, from + n);
      res.end(JSON.stringify({ data: page, next_cursor: from + n < items.length ? Buffer.from(`tok:${from + n}`).toString('base64url') : null }));
      return;
    }
    if (u.pathname === '/api/notes') {
      // a list with a Link to another origin: has_more is reported, but Neurouter does not follow it
      res.setHeader('link', '<https://elsewhere.test/api/notes?page=2>; rel="next"');
      res.end(JSON.stringify(items.slice(0, 2).map((x) => ({ id: x.id, title: x.name }))));
      return;
    }
    res.statusCode = 404;
    res.end('{"message":"not found"}');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port, seen })));
}

/**
 * Contract 2 paging (contract-v2 §2.1, P2): one cursor contract over every upstream paging style, Neurouter's own
 * cuts as pages, `fields`, signed cursors (tamper, other arguments, other credential), collisions, and `ops.pages`.
 */
describe('contract 2 paging (mock + real upstream)', () => {
  let s: RunningServer;
  let api: Awaited<ReturnType<typeof fakeUpstream>>;
  let mock: ReturnType<typeof rawMcp>;
  let live: ReturnType<typeof rawMcp>;

  beforeAll(async () => {
    api = await fakeUpstream();
    const dir = mkdtempSync(join(tmpdir(), 'nr-paging-'));
    writeFileSync(
      join(dir, 'paging.overlay.yaml'),
      `overlay: 1
tools:
  operationId:listNotes:
    response: { maxItems: 4 }
  operationId:getNote:
    response: { maxBytes: 300 }
  operationId:listWidgets:
    response: { include: ["data[].id", "data[].name", "data[].status"] }
`,
    );
    writeFileSync(
      join(dir, 'neurouter.yaml'),
      `version: 1
settings: { codeMode: { enabled: true } }
servers:
  - slug: paging
    name: Paging
    spec: { path: ${SPEC} }
    overlay: ${join(dir, 'paging.overlay.yaml')}
    exposure: { contract: 2 }
    environments:
      - slug: mock
        kind: dev
        baseUrl: "mock:"
        writes: { enabled: true }
        codeMode: true
      - slug: live
        kind: dev
        baseUrl: http://127.0.0.1:${api.port}/api
        allowHttp: true
`,
    );
    s = await bootServer({ NEUROUTER_CONFIG: join(dir, 'neurouter.yaml'), UPSTREAM_ALLOW_PRIVATE_NETWORKS: 'true' });
    mock = rawMcp(`${s.url}/mcp/paging/mock`, await keyFor(s, 'paging', 'mock', ['tools:read', 'tools:write', 'code:run']), { headers: V2 });
    await mock.initialize();
    live = rawMcp(`${s.url}/mcp/paging/live`, await keyFor(s, 'paging', 'live', ['tools:read']), { headers: V2 });
    await live.initialize();
  }, 90_000);
  afterAll(async () => {
    await s?.close();
    api?.server.close();
  });

  const call = async (c: ReturnType<typeof rawMcp>, name: string, args: Record<string, unknown> = {}): Promise<Env> => assertEnvelope((await c.call(name, args)).result, name);

  /** Follows next_cursor from the first page to the last; returns the item ids and the pages. */
  const walk = async (c: ReturnType<typeof rawMcp>, name: string, args: Record<string, unknown> = {}, items = (d: any) => (Array.isArray(d) ? d : (Object.values(d).find(Array.isArray) as any[]))) => {
    const ids: string[] = [];
    const pages: Env[] = [];
    let env = await call(c, name, args);
    for (let i = 0; i < 20; i++) {
      expect(env.ok, JSON.stringify(env.error)).toBe(true);
      pages.push(env);
      ids.push(...items(env.data).map((x: any) => String(x.id)));
      expect(typeof env.page.has_more).toBe('boolean');
      if (!env.page.has_more) break;
      expect(env.page.next_cursor).toMatch(/^c_/);
      env = await call(c, name, { ...args, cursor: env.page.next_cursor });
    }
    return { ids, pages };
  };

  it('tools/list: cursor/limit/fields injected per paging style; upstream position parameters replaced; nr_ on collisions', async () => {
    const tools = await mock.list();
    const props = (n: string) => Object.keys((tools.find((t) => t.name === n)!.inputSchema as { properties: object }).properties);
    expect(props('list_widgets')).toEqual(['status', 'cursor', 'limit', 'fields']);
    expect(props('list_gadgets')).toEqual(['cursor', 'limit', 'fields']);
    expect(props('list_gizmos')).toEqual(['limit', 'cursor', 'fields']);
    expect(props('list_charges')).toEqual(['limit', 'cursor', 'fields']);
    expect(props('list_documents')).toEqual(['cursor', 'limit', 'fields']);
    expect(props('list_notes')).toEqual(['cursor', 'fields']);
    expect(props('get_note')).toEqual(['note_id', 'fields']);
    expect(props('list_reports').sort()).toEqual(['cursor', 'fields', 'limit', 'nr_fields', 'nr_limit']);
    const widgets = tools.find((t) => t.name === 'list_widgets')! as Env;
    expect(widgets.inputSchema.properties.fields.description).toContain('Default: id, name, status');
    // contract 1 keeps the upstream schema as is
    const v1 = rawMcp(`${s.url}/mcp/paging/mock`, await keyFor(s, 'paging', 'mock', ['tools:read']), { headers: { 'x-neurouter-contract': '1' } });
    await v1.initialize();
    expect(Object.keys(((await v1.list()).find((t) => t.name === 'list_gadgets')!.inputSchema as { properties: object }).properties)).toEqual(['page', 'per_page']);
  });

  it.each([
    ['list_widgets', 'cursor + next_cursor token'],
    ['list_gadgets', 'page/per_page + Link: rel=next (relative)'],
    ['list_gizmos', 'offset/limit + total_count'],
    ['list_charges', 'starting_after + has_more'],
    ['list_documents', 'pageToken/pageSize + nextPageToken'],
  ])('%s (%s): next_cursor walks all 20 mock items, has_more false on the last page', async (name) => {
    const { ids, pages } = await walk(mock, name, { limit: 5 });
    expect(ids).toHaveLength(20);
    expect(new Set(ids).size).toBe(20);
    expect(pages).toHaveLength(4);
    expect(pages.at(-1)!.page).toMatchObject({ has_more: false, next_cursor: null });
    for (const p of pages.slice(0, -1)) expect(p.page).toMatchObject({ count: 5, has_more: true });
  });

  it('limit maps to the upstream page size; a raw upstream cursor value is passed through', async () => {
    const g = await call(mock, 'list_gadgets', { limit: 7 });
    expect(g.page).toMatchObject({ count: 7, has_more: true });
    const rest = await call(mock, 'list_gadgets', { limit: 7, cursor: g.page.next_cursor });
    expect(rest.data.map((x: any) => x.id)).not.toContain(g.data[0].id);
    const raw = await call(mock, 'list_widgets', { cursor: '15' });
    expect(raw.page).toMatchObject({ count: 5, has_more: false });
  });

  it("Neurouter's cuts are pages of the same tool (stored result), with scope", async () => {
    const { ids, pages } = await walk(mock, 'list_notes');
    expect(new Set(ids).size).toBe(20);
    expect(pages).toHaveLength(5);
    expect(pages[0]!.page).toMatchObject({ count: 4, total: 20, has_more: true, scope: {} });
    expect(pages[0]!.truncated).toBeNull();
    expect(pages.at(-1)!.page).toMatchObject({ count: 4, total: 20, has_more: false, next_cursor: null });
  });

  it('real upstream: absolute Link URLs (undeclared parameters kept) and opaque tokens; a Link to another origin is not followed', async () => {
    const g = await walk(live, 'list_gadgets');
    expect(g.ids).toEqual(Array.from({ length: 12 }, (_, i) => `g_${i + 1}`));
    expect(api.seen).toContain('/api/gadgets?page=2&per_page=5&sig=abc');
    const w = await walk(live, 'list_widgets');
    expect(w.ids).toHaveLength(12);
    expect(w.pages).toHaveLength(3);
    const n = await call(live, 'list_notes');
    expect(n.page).toMatchObject({ count: 2, has_more: true, next_cursor: null });
  });

  it('cursors are signed and bound: altered, other arguments, other tool, other credential → invalid_args with the first-page call; nothing is called', async () => {
    const first = await call(mock, 'list_widgets', { status: 'x', limit: 2 });
    const c = first.page.next_cursor ?? (await call(mock, 'list_widgets', { limit: 2 })).page.next_cursor;
    const good = await call(mock, 'list_widgets', { limit: 2 });
    const cur = good.page.next_cursor as string;
    const flip = (x: string) => `${x.slice(0, 5)}${x[5] === 'A' ? 'B' : 'A'}${x.slice(6)}`;
    for (const [args, tool] of [
      [{ limit: 2, cursor: flip(cur) }, 'list_widgets'],
      [{ limit: 2, cursor: cur }, 'list_gizmos'],
    ] as const) {
      const e = await call(mock, tool, args);
      expect(e.error).toMatchObject({ code: 'invalid_args', retry: 'after_fix', fields: [{ field: 'cursor' }] });
      expect(e.error.message).toMatch(/nothing was called/);
      expect(e.error.next).toEqual([{ tool, args: { limit: args.limit } }]);
    }
    // other query arguments (B5): the first suggestion continues the cursor with its own arguments, the second starts over
    const other3 = await call(mock, 'list_widgets', { limit: 3, cursor: cur, fields: ['id'] });
    expect(other3.error).toMatchObject({ code: 'invalid_args', fields: [{ field: 'cursor' }] });
    expect(other3.error.message).toMatch(/issued for other arguments \(limit\); nothing was called/);
    // the 600-char error budget keeps the first suggestion (the cursor is long); the page-1 call is the second when it fits
    expect(other3.error.next[0]).toEqual({ tool: 'list_widgets', args: { limit: 2, fields: ['id'], cursor: cur } });
    expect(other3.error.next.slice(1)).toEqual(other3.error.next.length > 1 ? [{ tool: 'list_widgets', args: { limit: 3, fields: ['id'] } }] : []);
    const cont = await call(mock, other3.error.next[0].tool, other3.error.next[0].args);
    expect(cont.ok).toBe(true);
    expect(cont.data.data.map((x: any) => x.id)).not.toContain(good.data.data[0].id);
    const other = rawMcp(`${s.url}/mcp/paging/mock`, await keyFor(s, 'paging', 'mock', ['tools:read']), { headers: V2 });
    await other.initialize();
    expect((await call(other, 'list_widgets', { limit: 2, cursor: cur })).error).toMatchObject({ code: 'invalid_args', fields: [{ field: 'cursor' }] });
    expect((await call(mock, 'list_widgets', { limit: 2, cursor: 'c_garbage' })).error.fields[0].problem).toMatch(/not a page.next_cursor/);
    void c;
  });

  it('fields: per-item projection on lists (not bound into the cursor), default set from the overlay; clipped objects name the fields and the call that returns them', async () => {
    const def = await call(mock, 'list_widgets', { limit: 2 });
    expect(Object.keys(def.data.data[0]).sort()).toEqual(['id', 'name', 'status']);
    const only = await call(mock, 'list_widgets', { limit: 2, fields: ['id', 'color'] });
    expect(Object.keys(only.data.data[0]).sort()).toEqual(['color', 'id']);
    const next = await call(mock, 'list_widgets', { limit: 2, fields: ['id', 'color'], cursor: only.page.next_cursor });
    expect(next.ok).toBe(true);
    // the cursor binds the query, not the projection (B5): dropping or changing fields keeps the cursor valid
    const dropped = await call(mock, 'list_widgets', { limit: 2, cursor: only.page.next_cursor });
    expect(dropped.ok, JSON.stringify(dropped.error)).toBe(true);
    expect(dropped.data.data.map((x: any) => x.id)).toEqual(next.data.data.map((x: any) => x.id));
    expect(Object.keys(dropped.data.data[0]).sort()).toEqual(['id', 'name', 'status']);
    const bad = await call(mock, 'list_widgets', { fields: 'id' });
    expect(bad.error).toMatchObject({ code: 'invalid_args', fields: [{ field: 'fields' }], next: [{ tool: 'list_widgets', args: {} }] });

    const created = await call(mock, 'create_note', { title: 'Long', body: `Lorem ipsum ${'dolor sit amet '.repeat(60)}`.trim(), author: 'ada' });
    const clipped = await call(mock, 'get_note', { note_id: created.data.id });
    expect(clipped.truncated).toMatchObject({ fields: ['body'], next: { tool: 'get_note', args: { note_id: created.data.id, fields: ['body'] } } });
    expect(clipped.data.title).toBe('Long');
    const full = await call(mock, clipped.truncated.next.tool, clipped.truncated.next.args);
    expect(full.truncated).toBeNull();
    expect(full.data).toEqual({ body: created.data.body });
  });

  it('B5 (P6: apps_list_accounts_for_plan, codespaces_list_for_authenticated_user): fields and a default limit added to a next_cursor call keep the cursor', async () => {
    // P6, list_accounts_for_plan_1313 (tool, contract 2): {plan_id, limit: 100} → Neurouter cut → the agent added
    // fields: ["login"] to the next call and got invalid_args; error.next dropped the cursor (page 1 again)
    const first = await call(mock, 'list_notes', {});
    expect(first.page).toMatchObject({ count: 4, has_more: true });
    const second = await call(mock, 'list_notes', { cursor: first.page.next_cursor, fields: ['id'] });
    expect(second.ok, JSON.stringify(second.error)).toBe(true);
    expect(second.data.map((x: any) => Object.keys(x))).toEqual([['id'], ['id'], ['id'], ['id']]);
    expect(second.data.map((x: any) => x.id)).not.toContain(first.data[0].id);
    // codespaces (r2): the agent added limit: 30 (the default) and fields; list_widgets' default limit is 5
    const w = await call(mock, 'list_widgets', {});
    const w2 = await call(mock, 'list_widgets', { cursor: w.page.next_cursor, limit: 5, fields: ['id', 'name'] });
    expect(w2.ok, JSON.stringify(w2.error)).toBe(true);
    expect(w2.data.data.map((x: any) => x.id)).not.toContain(w.data.data[0].id);
  });

  it('code mode: ops.pages iterates every page with the same cursors (minimal; P4 adds .pages())', async () => {
    const r = await call(mock, 'run_script', { code: 'items = ops.pages(fn="paging.list_charges", args={"limit": 6}, max_items=100)\nreturn [len(items), len(set([x["id"] for x in items]))]' });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data).toEqual([20, 20]);
    expect(r.state.script_calls).toBe(4);
    const capped = await call(mock, 'run_script', { code: 'return len(ops.pages(fn="paging.list_gadgets", max_items=7))' });
    expect(capped.data).toBe(7);
    const notList = await call(mock, 'run_script', { code: 'return ops.pages(fn="paging.get_note", args={"note_id": "x"})' });
    expect(notList.ok).toBe(false);
  });
});
