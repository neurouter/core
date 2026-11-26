import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { bootServer, keyFor, mcpClient, REPO_ROOT, resetPg } from '../fakes/server.js';

type Txt = Array<{ type: string; text: string }>;
const text = (r: { content: unknown }) => (r.content as Txt).map((c) => c.text).join('\n');

/** A tiny real HTTP API returning 100 items (shaping/truncation over the HTTP invoker). */
const upstreamTraceparents: string[] = [];

function fakeApi(): Promise<{ server: Server; port: number }> {
  const items = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, name: `item ${i + 1}`, secret_note: 'x' }));
  const server = createServer((req, res) => {
    upstreamTraceparents.push(String(req.headers.traceparent ?? ''));
    if (req.url?.startsWith('/items')) {
      res.writeHead(200, { 'content-type': 'application/json', 'x-ratelimit-remaining': '99' });
      res.end(JSON.stringify(items));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{"message":"not found"}');
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })));
}

const ITEMS_SPEC = (port: number) => `openapi: 3.0.3
info: { title: Items, version: "1" }
servers: [{ url: "http://127.0.0.1:${port}" }]
paths:
  /items:
    get:
      operationId: listItems
      summary: List all items in the catalog with their names
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema: { type: array, items: { type: object, properties: { id: { type: integer }, name: { type: string } } } }
`;

const PG = process.env.NEUROUTER_TEST_PG_URL;

describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('context, discovery, confirmation and code mode (M3 + M4 acceptance, %s)', (_dialect, pgUrl) => {
  let s: RunningServer;
  let api: { server: Server; port: number };
  let dir: string;

  beforeAll(async () => {
    api = await fakeApi();
    dir = mkdtempSync(join(tmpdir(), 'nr-it-'));
    writeFileSync(join(dir, 'items.yaml'), ITEMS_SPEC(api.port));
    writeFileSync(join(dir, 'items.overlay.yaml'), 'overlay: 1\ntools:\n  "operationId:listItems":\n    response:\n      maxItems: 50\n      exclude: ["[].secret_note"]\n');
    writeFileSync(join(dir, 'petsmall.overlay.yaml'), 'overlay: 1\ntools:\n  "operationId:getPetById":\n    response:\n      maxBytes: 256\n');
    const subset = resolve(REPO_ROOT, 'examples/github/github-subset.json');
    const curated = resolve(REPO_ROOT, 'examples/github/curated.overlay.yaml');
    writeFileSync(
      join(dir, 'neurouter.yaml'),
      `version: 1
settings: { codeMode: { enabled: true } }
servers:
  - slug: ghraw
    name: GitHub (raw)
    spec: { path: ${subset} }
    environments: []
  - slug: github
    name: GitHub
    spec: { path: ${subset} }
    overlay: ${curated}
    environments:
      - slug: prod
        kind: prod
        baseUrl: "mock:"
        writes: { enabled: true, confirm: elicit }
        codeMode: true
      - slug: strict
        kind: prod
        baseUrl: "mock:"
        writes: { enabled: true, confirm: deny_without_elicitation }
        codeMode: true
      - slug: qa
        kind: qa
        baseUrl: "mock:"
        writes: { enabled: true, confirm: elicit }
        codeMode: true
  - slug: items
    name: Items
    spec: { path: ${join(dir, 'items.yaml')} }
    overlay: ${join(dir, 'items.overlay.yaml')}
    environments:
      - slug: dev
        kind: dev
        baseUrl: http://127.0.0.1:${api.port}
        allowHttp: true
  - slug: petstore
    name: Petstore
    spec: { path: ${resolve(REPO_ROOT, 'examples/petstore/openapi.yaml')} }
    environments:
      - slug: dev
        kind: dev
        baseUrl: "mock:"
        writes: { enabled: true }
        limits: { code: { cpuTimeSec: 1, wallTimeSec: 10 } }
  - slug: petsmall
    name: Petstore (tiny maxBytes)
    spec: { path: ${resolve(REPO_ROOT, 'examples/petstore/openapi.yaml')} }
    overlay: ${join(dir, 'petsmall.overlay.yaml')}
    environments:
      - slug: dev
        kind: dev
        baseUrl: "mock:"
        codeMode: true
`,
    );
    const dbUrl = pgUrl ? await resetPg(pgUrl, 'nr_it_ctx') : '';
    s = await bootServer({ NEUROUTER_CONFIG: join(dir, 'neurouter.yaml'), UPSTREAM_ALLOW_PRIVATE_NETWORKS: 'true', ...(dbUrl ? { DATABASE_URL: dbUrl } : {}) });
  }, 90_000);
  afterAll(async () => {
    await s?.close();
    api?.server.close();
  });

  it('tools/call is traced: caller trace id kept, gateway span id on the audit row, a client span hop sent upstream', async () => {
    const c = await mcpClient(s, 'items', 'dev', await keyFor(s, 'items', 'dev', ['tools:read']));
    const caller = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';
    const r = await c.callTool({ name: 'list_items', arguments: {}, _meta: { traceparent: caller } });
    expect(r.isError, text(r)).toBeFalsy();
    const sent = upstreamTraceparents.at(-1)!;
    expect(sent).toMatch(/^00-4bf92f3577b34da6a3ce929d0e0e4736-[0-9a-f]{16}-01$/);
    expect(sent).not.toContain('00f067aa0ba902b7');
    await s.services.auditStore.flush();
    const row = await s.services.dbs.audit.db.selectFrom('audit_log').select(['trace_id', 'span_id']).where('tool_name', '=', 'list_items').orderBy('ts', 'desc').executeTakeFirstOrThrow();
    expect(row.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(row.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(sent.split('-')[2]).not.toBe(row.span_id); // the upstream hop is a child span of the gateway span
    // without a caller context the gateway starts a trace (audit rows still get trace and span ids)
    await c.callTool({ name: 'list_items', arguments: {} });
    expect(upstreamTraceparents.at(-1)).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    await c.close();
  });

  it('raw GitHub (48 tools, discovery auto) lists pinned + search_tools + call_tool; search ranks issues_create first', async () => {
    const c = await mcpClient(s, 'ghraw', 'mock', await keyFor(s, 'ghraw', 'mock', ['tools:read', 'tools:write']));
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['search_tools', 'call_tool', 'neurouter_begin_task', 'neurouter_end_task', 'neurouter_report_unmet_need']));
    expect(names).not.toContain('issues_list_for_repo');
    const r = await c.callTool({ name: 'search_tools', arguments: { query: 'create an issue', format: 'json' } });
    const tools = (r.structuredContent as { tools: Array<{ name: string }> }).tools;
    expect(tools[0]!.name).toBe('issues_create');
    const empty = await c.callTool({ name: 'search_tools', arguments: { query: 'zzzz qqqq xxxx' } });
    expect(JSON.stringify(empty._meta)).toContain('neurouter_report_unmet_need');
    const created = await c.callTool({ name: 'call_tool', arguments: { name: 'issues_create', arguments: { owner: 'octocat', repo: 'hello-world', title: 'Bug' } } });
    expect(created.isError, text(created)).toBeFalsy();
    await c.close();
  });

  it('publishing an overlay changes tools/list (no restart)', async () => {
    const c = await mcpClient(s, 'ghraw', 'mock', await keyFor(s, 'ghraw', 'mock', ['tools:read']));
    const svc = s.services;
    const srv = (await svc.servers.bySlug(DEFAULT_TENANT_ID, 'ghraw'))!;
    await svc.servers.publishOverlay(DEFAULT_TENANT_ID, srv.id, readFileSync(resolve(REPO_ROOT, 'examples/github/curated.overlay.yaml'), 'utf8').replaceAll('github.', 'ghraw.'), { message: 'curate', source: 'console', createdBy: null, basedOnRev: null });
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('list_issues'); // 41 visible ≤ 40? → curated has pins; full discovery when ≤ 40, else search
    await c.close();
  });

  it('shaping cuts a 100-item list to 50 with a working result handle (real HTTP upstream)', async () => {
    const c = await mcpClient(s, 'items', 'dev', await keyFor(s, 'items', 'dev', ['tools:read']));
    const r = await c.callTool({ name: 'list_items', arguments: {} });
    expect(r.isError, text(r)).toBeFalsy();
    const items = (r.structuredContent as { items: Array<Record<string, unknown>> }).items;
    expect(items).toHaveLength(50);
    expect(items[0]).not.toHaveProperty('secret_note');
    const meta = r._meta as Record<string, unknown>;
    const handle = meta['dev.neurouter/result-handle'] as string;
    expect(handle).toMatch(/^rh_/);
    expect(meta['dev.neurouter/truncated']).toMatchObject({ totalItems: 100 });
    expect(text(r)).toContain('Showing 50 of 100 items');
    const page = await c.callTool({ name: 'neurouter_read_result', arguments: { handle, offset: 50, limit: 50 } });
    const p = page.structuredContent as { items: Array<{ id: number }>; next_offset: number | null; total: number };
    expect(p.items[0]!.id).toBe(51);
    expect(p.total).toBe(100);
    expect(p.next_offset).toBeNull();
    await c.close();
  });

  it.each(['modern'] as const)('prod write with an elicitation-capable %s client: decline blocks, accept executes', async (era) => {
    const key = await keyFor(s, 'github', 'prod', ['tools:read', 'tools:write']);
    let asked = '';
    const no = await mcpClient(s, 'github', 'prod', key, { era, elicitation: true, onElicit: (m) => ((asked = m), { approve: false }) });
    const r1 = await no.callTool({ name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'Prod bug' } });
    expect(asked, text(r1)).toContain('in PROD?');
    expect(r1.isError).toBe(true);
    expect(text(r1)).toMatch(/declined/);
    await no.close();
    const yes = await mcpClient(s, 'github', 'prod', key, { era, elicitation: true, onElicit: () => ({ approve: true }) });
    const r2 = await yes.callTool({ name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'Prod bug' } });
    expect(r2.isError, text(r2)).toBeFalsy();
    await yes.close();
    // a client without elicitation cannot write on prod; `elicit` hands back the planned change, unexecuted
    const plain = await mcpClient(s, 'github', 'prod', key, { era });
    const r3 = await plain.callTool({ name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'x' } });
    expect(r3.isError).toBe(true);
    expect(text(r3)).toContain('Not executed: this client cannot ask the user to confirm writes in PROD');
    expect((r3._meta as Record<string, unknown>)['dev.neurouter/planned-changes']).toEqual([expect.objectContaining({ tool: 'create_issue', method: 'POST', arguments: expect.objectContaining({ title: 'x' }) })]);
    await plain.close();
    await s.services.auditStore.flush();
    const rows = await s.services.dbs.audit.db.selectFrom('audit_log').select(['decision', 'confirm']).where('tool_name', '=', 'create_issue').execute();
    expect(rows.map((r) => r.decision)).toEqual(expect.arrayContaining(['denied_confirmation', 'confirmed']));
  });

  it('prod write from a 2025-era (stateless legacy) client is refused as unconfirmable', async () => {
    const key = await keyFor(s, 'github', 'prod', ['tools:read', 'tools:write']);
    const c = await mcpClient(s, 'github', 'prod', key, { era: 'legacy', elicitation: true });
    const r = await c.callTool({ name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'x' } });
    expect(text(r)).toContain('cannot ask the user to confirm writes in PROD');
    await c.close();
  });

  it('deny_without_elicitation refuses outright (no planned change); both modes prompt eliciting clients', async () => {
    const key = await keyFor(s, 'github', 'strict', ['tools:read', 'tools:write']);
    const plain = await mcpClient(s, 'github', 'strict', key, { era: 'modern' });
    const r = await plain.callTool({ name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'x' } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/^This client cannot ask the user to confirm writes in PROD; create_issue was not called/);
    expect(r._meta ?? {}).not.toHaveProperty(['dev.neurouter/planned-changes']);
    await plain.close();
    let asked = '';
    const eliciting = await mcpClient(s, 'github', 'strict', key, { era: 'modern', elicitation: true, onElicit: (m) => ((asked = m), { approve: true }) });
    const ok = await eliciting.callTool({ name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'y' } });
    expect(ok.isError, text(ok)).toBeFalsy();
    expect(asked).toContain('in PROD?');
    await eliciting.close();
  });

  it('run_script on prod from a client that cannot elicit: elicit returns the dry-run plan unexecuted, deny refuses', async () => {
    const code = `github.add_labels(owner="octocat", repo="hello-world", issue_number=1, body={"labels": ["prod-x"]})\nreturn "done"`;
    const c = await mcpClient(s, 'github', 'prod', await keyFor(s, 'github', 'prod', ['tools:read', 'tools:write', 'code:run']), { era: 'modern' });
    const r = await c.callTool({ name: 'run_script', arguments: { code } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain('Not executed');
    expect((r._meta as Record<string, unknown>)['dev.neurouter/planned-changes']).toEqual([expect.objectContaining({ tool: 'add_labels' })]);
    const labels = await c.callTool({ name: 'call_tool', arguments: { name: 'list_issue_labels', arguments: { owner: 'octocat', repo: 'hello-world', issue_number: 1 } } });
    expect(text(labels)).not.toContain('prod-x');
    await c.close();
    const d = await mcpClient(s, 'github', 'strict', await keyFor(s, 'github', 'strict', ['tools:read', 'tools:write', 'code:run']), { era: 'modern' });
    const r2 = await d.callTool({ name: 'run_script', arguments: { code } });
    expect(text(r2)).toContain('the script was not run');
    expect(r2._meta ?? {}).not.toHaveProperty(['dev.neurouter/planned-changes']);
    await d.close();
  });

  it('confirm set on a non-prod environment is honoured, listed in tools/list and reported by whoami', async () => {
    const key = await keyFor(s, 'github', 'qa', ['tools:read', 'tools:write']);
    const c = await mcpClient(s, 'github', 'qa', key, { era: 'modern' });
    const tools = (await c.listTools()).tools;
    const create = tools.find((t) => t.name === 'create_issue');
    if (create) expect(create._meta?.['dev.neurouter/confirm']).toBe('elicit');
    const who = await c.callTool({ name: 'neurouter_whoami', arguments: {} });
    expect((who.structuredContent as { writes: { confirm: string; client_can_confirm: boolean } }).writes).toMatchObject({ confirm: 'elicit', client_can_confirm: false });
    const r = await c.callTool({ name: 'call_tool', arguments: { name: 'create_issue', arguments: { owner: 'octocat', repo: 'hello-world', title: 'z' } } });
    expect(text(r)).toContain('cannot ask the user to confirm writes in the qa environment');
    await c.close();
  });

  it('X-Neurouter-Exposure works for normal API keys (console code-mode-only snippets) and respects code-mode availability', async () => {
    const both = await mcpClient(s, 'github', 'mock', await keyFor(s, 'github', 'mock', ['tools:read', 'code:run']));
    expect((await both.listTools()).tools.map((t) => t.name)).toContain('list_issues');
    await both.close();
    const codeOnly = await mcpClient(s, 'github', 'mock', await keyFor(s, 'github', 'mock', ['tools:read', 'code:run']), { headers: { 'X-Neurouter-Exposure': 'code' } });
    const names = (await codeOnly.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['run_script', 'search_tools']));
    expect(names).not.toContain('list_issues');
    await codeOnly.close();
    // without code:run, code mode is unavailable: the header falls back to tools
    const noCode = await mcpClient(s, 'github', 'mock', await keyFor(s, 'github', 'mock', ['tools:read']), { headers: { 'X-Neurouter-Exposure': 'code' } });
    const n2 = (await noCode.listTools()).tools.map((t) => t.name);
    expect(n2).not.toContain('run_script');
    expect(n2).toContain('list_issues');
    await noCode.close();
  });

  it('run_script: one call lists 30 issues and labels the stale ones; dry_run plans without writing', async () => {
    const key = await keyFor(s, 'github', 'mock', ['tools:read', 'tools:write', 'code:run']);
    const c = await mcpClient(s, 'github', 'mock', key);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('run_script');
    // python stubs say how to call them (namespace prefix)
    const found = text(await c.callTool({ name: 'search_tools', arguments: { query: 'list issues', format: 'python' } }));
    expect(found).toMatch(/^# In run_script call these as github\.<name>\(\.\.\.\), e\.g\. github\.\w+\(\.\.\.\)/);
    expect(found).toContain('def list_issues(');
    const code = `issues = github.list_issues(owner="octocat", repo="hello-world", state="open", limit=30)
stale = [i for i in issues if ops.days_since(i["updated_at"]) > 0]
for i in stale[:3]:
    github.add_labels(owner="octocat", repo="hello-world", issue_number=i["number"], body={"labels": ["stale"]})
return {"checked": len(issues), "labelled": [i["number"] for i in stale[:3]]}`;
    const dry = await c.callTool({ name: 'run_script', arguments: { code, mode: 'dry_run' } });
    expect(dry.isError, text(dry)).toBeFalsy();
    const ds = dry.structuredContent as { status: string; planned_changes: Array<{ tool: string }>; result: { labelled: number[] } };
    expect(ds.status).toBe('ok');
    expect(ds.planned_changes.length).toBe(ds.result.labelled.length);
    expect(ds.planned_changes[0]?.tool).toBe('add_labels');
    const labelsBefore = await c.callTool({ name: 'list_issue_labels', arguments: { owner: 'octocat', repo: 'hello-world', issue_number: ds.result.labelled[0] } });
    const run = await c.callTool({ name: 'run_script', arguments: { code } });
    const rs = run.structuredContent as { status: string; result: { checked: number }; stats: { toolCalls: number } };
    expect(rs.status, text(run)).toBe('ok');
    expect(rs.stats.toolCalls).toBe(1 + ds.result.labelled.length);
    expect(text(labelsBefore)).not.toContain('"stale"');
    await c.close();
  });

  it('run_script rejects imports at line 1, catches wrong kwargs before any call, stops infinite loops', async () => {
    const c = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read', 'code:run']));
    const imp = await c.callTool({ name: 'run_script', arguments: { code: 'import os\nreturn 1' } });
    expect(imp.structuredContent).toMatchObject({ status: 'rejected', error: { line: 1 } });
    const typ = await c.callTool({ name: 'run_script', arguments: { code: 'return petstore.get_pet_by_id(pet_identifier=1)' } });
    expect((typ.structuredContent as { status: string; stats: { toolCalls: number } }).status).toBe('type_error');
    expect((typ.structuredContent as { stats: { toolCalls: number } }).stats.toolCalls).toBe(0);
    const loop = await c.callTool({ name: 'run_script', arguments: { code: 'while True:\n    pass' } });
    expect((loop.structuredContent as { status: string }).status).toBe('limit_exceeded');
    const ok = await c.callTool({ name: 'run_script', arguments: { code: 'p = petstore.get_pet_by_id(pet_id=1)\nreturn p["id"]' } });
    expect(ok.structuredContent).toMatchObject({ status: 'ok', result: 1 });
    await c.close();
  }, 60_000);

  it('run_script reads whole tool results where tool mode gets the maxBytes preview; unsupported built-ins get a hint', async () => {
    const c = await mcpClient(s, 'petsmall', 'dev', await keyFor(s, 'petsmall', 'dev', ['tools:read', 'code:run']));
    // tool mode: the overlay 256-byte cap gives the documented preview object
    const tool = await c.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 1 } });
    expect(tool.structuredContent).toMatchObject({ $truncated: true });
    // in a script the same call is the whole value (fields readable, no {$truncated, preview})
    const r = await c.callTool({ name: 'run_script', arguments: { code: 'p = petsmall.get_pet_by_id(pet_id=1)\nreturn {"id": p["id"], "has_name": "name" in p, "kind": str(type(p)), "truncated": "$truncated" in p}' } });
    expect(r.structuredContent, text(r)).toMatchObject({ status: 'ok', result: { id: 1, has_name: true, kind: "<class 'dict'>", truncated: false } });
    const m = await c.callTool({ name: 'run_script', arguments: { code: 'return list(map(str, [1, 2]))' } });
    const err = (m.structuredContent as { status: string; error: { hint?: string } });
    expect(err.status).toBe('type_error');
    expect(err.error.hint).toContain('map is not available in scripts: use a list comprehension');
    expect(err.error.hint).toContain('iter, next');
    const it = await c.callTool({ name: 'run_script', arguments: { code: 'xs = iter([3, 4])\nreturn [next(xs), next(xs, None), next(xs, "end")]' } });
    expect(it.structuredContent).toMatchObject({ status: 'ok', result: [3, 4, 'end'] });
    await c.close();
  }, 60_000);

  it('ops: begin → call → script → unmet need → end produces one task with all items', async () => {
    const c = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read', 'code:run']));
    const b = await c.callTool({ name: 'neurouter_begin_task', arguments: { goal: 'Find pet 1' } });
    const taskId = (b.structuredContent as { task_id: string }).task_id;
    await c.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 1 } });
    await c.callTool({ name: 'run_script', arguments: { code: 'return petstore.get_pet_by_id(pet_id=2)["id"]' } });
    const n1 = await c.callTool({ name: 'neurouter_report_unmet_need', arguments: { intent: 'Book a vet appointment for my pet' } });
    const n2 = await c.callTool({ name: 'neurouter_report_unmet_need', arguments: { intent: 'book vet appointment for pet' } });
    expect((n2.structuredContent as { group_id: string }).group_id).toBe((n1.structuredContent as { group_id: string }).group_id);
    const e = await c.callTool({ name: 'neurouter_end_task', arguments: { outcome: 'success' } });
    expect(e.structuredContent).toMatchObject({ task_id: taskId });
    await s.services.auditStore.flush();
    const rows = await s.services.dbs.audit.db.selectFrom('audit_log').select(['kind', 'tool_name', 'via', 'script_run_id']).where('task_id', '=', taskId).orderBy('seq').execute();
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(['ops_call', 'tool_call', 'script_run']));
    expect(rows.some((r) => r.via === 'script' && r.script_run_id)).toBe(true);
    const task = await s.services.dbs.main.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirstOrThrow();
    expect(task).toMatchObject({ status: 'closed', outcome: 'success', framing: 'explicit' });
    await c.close();
  }, 60_000);
});
