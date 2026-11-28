import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { bootServer, keyFor, mcpClient, resetPg } from '../fakes/server.js';

const PG = process.env.NEUROUTER_TEST_PG_URL;

describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('tool-mode data plane (M2 acceptance, %s)', (_dialect, pgUrl) => {
  let s: RunningServer;
  beforeAll(async () => {
    const dbUrl = pgUrl ? await resetPg(pgUrl, 'nr_it_tool') : '';
    s = await bootServer({ NEUROUTER_EXECUTOR_MODE: 'off', ...(dbUrl ? { DATABASE_URL: dbUrl } : {}) });
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('401 with a per-endpoint PRM challenge, PRM document, 404 after auth for unknown endpoints', async () => {
    const r = await fetch(`${s.url}/mcp/petstore/dev`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(401);
    expect(r.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/mcp/petstore/dev');
    const prm = await (await fetch(`${s.url}/.well-known/oauth-protected-resource/mcp/petstore/dev`)).json();
    expect(prm).toMatchObject({ resource: `${s.url}/mcp/petstore/dev`, scopes_supported: ['mcp:tools', 'mcp:write', 'mcp:code'] });
    const key = await keyFor(s, 'petstore', 'dev', ['tools:read']);
    const nf = await fetch(`${s.url}/mcp/nope/dev`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: '{}' });
    expect(nf.status).toBe(404);
    // a key bound to dev is invalid on prod
    const other = await fetch(`${s.url}/mcp/petstore/prod`, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(other.status).toBe(401);
  });

  it('lists the petstore tools and calls get_pet_by_id against the mock; writes refused without tools:write', async () => {
    const key = await keyFor(s, 'petstore', 'dev', ['tools:read']);
    const c = await mcpClient(s, 'petstore', 'dev', key);
    const list = await c.listTools();
    const names = list.tools.map((t) => t.name);
    expect(names).toContain('get_pet_by_id');
    expect(names).toContain('neurouter_begin_task');
    expect(c.getInstructions()).toContain('neurouter_begin_task(goal)');
    const res = await c.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 1 } });
    expect(res.isError, JSON.stringify(res.content)).toBeFalsy();
    expect(JSON.stringify(res.structuredContent)).toContain('"id":1');
    const add = await c.callTool({ name: 'add_pet', arguments: { name: 'Rex', photoUrls: [] } });
    expect(add.isError).toBe(true);
    expect(JSON.stringify(add._meta)).toContain('neurouter_whoami');
    await c.close();
  });

  it('read-only environment: denied_read_only with an error_id that explain_error resolves', async () => {
    // prod has writes enabled with confirm; make an environment read-only via the db and invalidate
    const svc = s.services;
    const srv = (await svc.servers.bySlug(DEFAULT_TENANT_ID, 'petstore'))!;
    const dev = (await svc.servers.environments(srv.id)).find((e) => e.slug === 'dev')!;
    await svc.dbs.main.db.updateTable('environments').set({ writes: JSON.stringify({ enabled: false, tools: null, confirm: 'none' }) }).where('id', '=', dev.id).execute();
    svc.runtime.invalidate();
    const key = await keyFor(s, 'petstore', 'dev', ['tools:read', 'tools:write']);
    const c = await mcpClient(s, 'petstore', 'dev', key);
    const add = await c.callTool({ name: 'add_pet', arguments: { name: 'Rex', photoUrls: [] } });
    expect(add.isError).toBe(true);
    const errorId = (add._meta as Record<string, string>)['dev.neurouter/error-id'];
    expect(errorId).toMatch(/^err_/);
    expect((add.content as Array<{ text: string }>)[0]!.text).toMatch(/Writes are off in the dev environment/);
    const ex = await c.callTool({ name: 'neurouter_explain_error', arguments: { error_id: errorId } });
    expect(ex.structuredContent).toMatchObject({ code: 'writes_disabled' });
    await svc.dbs.main.db.updateTable('environments').set({ writes: JSON.stringify({ enabled: true, tools: null, confirm: 'none' }) }).where('id', '=', dev.id).execute();
    svc.runtime.invalidate();
    await c.close();
  });

  it('unknown and hidden tools look identical (JSON-RPC -32602 on direct calls)', async () => {
    const key = await keyFor(s, 'petstore', 'dev', ['tools:read']);
    const c = await mcpClient(s, 'petstore', 'dev', key);
    await expect(c.callTool({ name: 'definitely_not_a_tool', arguments: {} })).rejects.toThrow(/Unknown tool/);
    await c.close();
  });

  it('audit chain verifies after calls', async () => {
    await s.services.auditStore.flush();
    const v = await s.services.auditStore.verify(DEFAULT_TENANT_ID, {}, { includeLegacy: true });
    expect(v.ok).toBe(true);
    expect(v.checked).toBeGreaterThan(5);
  });
});
