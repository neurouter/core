import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, importPetstore, type TestContext } from '../../../test/fakes/app-context.js';

describe('servers / specs / builds API', () => {
  let t: TestContext;
  let server: any;
  beforeAll(async () => {
    t = await createTestContext();
    server = await importPetstore(t);
  }, 60_000);
  afterAll(async () => t?.close());

  it('creates from pasted content (202 + job) with a mock environment and a lint-only readiness', async () => {
    expect(server).toMatchObject({ slug: 'petstore', kind: 'openapi', specFormat: 'openapi-3.0', visibleToolCount: 19, managedBy: 'console' });
    expect(server.environments.map((e: any) => e.slug)).toEqual(['mock']);
    expect(server.readiness).toMatchObject({ confidence: 'preliminary', runId: null });
    const list = await t.json(t.admin, { url: '/api/servers' }, 200);
    expect(list.items).toHaveLength(1);
  });

  it('409 on a taken slug, 422 spec_unsupported for Swagger 2.0', async () => {
    const dup = await t.as(t.admin, { method: 'POST', url: '/api/servers', payload: { slug: 'petstore', name: 'x', source: { content: 'openapi: 3.0.0\ninfo: {title: x, version: "1"}\npaths: {}' } } });
    expect(dup.statusCode).toBe(409);
    const sw = await t.as(t.admin, { method: 'POST', url: '/api/servers', payload: { slug: 'swag', name: 'x', source: { content: 'swagger: "2.0"\ninfo: {title: x, version: "1"}\npaths: {}' } } });
    expect(sw.statusCode).toBe(422);
    expect(JSON.parse(sw.body).code).toBe('spec_unsupported');
  });

  it('server detail, update, builds, stubs, specs, connect, ops tools, readiness', async () => {
    const d = await t.json(t.admin, { url: `/api/servers/${server.id}` }, 200);
    expect(d.latestBuild.visibleCount).toBe(19);
    const upd = await t.json(t.admin, { method: 'PATCH', url: `/api/servers/${server.id}`, payload: { description: 'Pets', exposure: { discovery: 'search' } } }, 200);
    expect(upd.exposure.discovery).toBe('search');
    const builds = await t.json(t.admin, { url: `/api/servers/${server.id}/builds` }, 200);
    expect(builds.items[0].environments).toContain('mock');
    const bd = await t.json(t.admin, { url: `/api/builds/${builds.items[0].id}` }, 200);
    expect(bd.lint.score).toBeGreaterThan(0);
    const stubs = await t.json(t.admin, { url: `/api/builds/${builds.items[0].id}/stubs` }, 200);
    expect(stubs.namespaces[0].pyi).toContain('def get_pet_by_id');
    const specs = await t.json(t.admin, { url: `/api/servers/${server.id}/specs` }, 200);
    expect(specs.items[0].rev).toBe(1);
    const dl = await t.as(t.admin, { url: `/api/specs/${specs.items[0].id}/content` });
    expect(dl.body).toContain('openapi');
    const conn = await t.json(t.admin, { url: `/api/servers/${server.id}/connect` }, 200);
    expect(conn.mcpUrl).toBe('http://console.test/mcp/petstore/mock');
    expect(conn.clients.map((x: any) => x.id)).toEqual(['claude-code', 'cursor', 'vscode', 'http']);
    const ops = await t.json(t.admin, { method: 'PUT', url: `/api/servers/${server.id}/ops-tools`, payload: { whoami: false } }, 200);
    expect(ops.items.find((o: any) => o.name === 'neurouter_whoami').enabled).toBe(false);
    const r = await t.json(t.admin, { url: `/api/servers/${server.id}/readiness` }, 200);
    expect(r.confidence).toBe('preliminary');
  });

  it('spec preview → create from preview (201)', async () => {
    const { readFile } = await import('node:fs/promises');
    const content = await readFile((await import('../../../test/fakes/app-context.js')).PETSTORE, 'utf8');
    const acc = await t.json(t.admin, { method: 'POST', url: '/api/spec-previews', payload: { source: { content } } }, 202);
    const p = await t.json(t.admin, { url: `/api/spec-previews/${acc.previewId}` }, 200);
    expect(p).toMatchObject({ status: 'ready', counts: { tools: 19 } });
    const upd = await t.json(t.admin, { method: 'PATCH', url: `/api/spec-previews/${acc.previewId}`, payload: { slug: 'pets2', overlayOps: [{ op: 'set', selector: 'operationId:deletePet', field: 'hidden', value: true }] } }, 200);
    expect(upd.counts.hiddenByDefault).toBe(1);
    const created = await t.json(t.admin, { method: 'POST', url: '/api/servers', payload: { previewId: acc.previewId, slug: 'pets2', name: 'Pets 2' } }, 201);
    expect(created.visibleToolCount).toBe(18);
    expect(created.publishedOverlay.rev).toBe(1);
  });

  it('viewer can read but not write; anonymous is 401', async () => {
    const v = await t.user('viewer@test.dev', 'viewer');
    expect((await t.as(v, { url: '/api/servers' })).statusCode).toBe(200);
    const w = await t.as(v, { method: 'PATCH', url: `/api/servers/${server.id}`, payload: { description: 'x' } });
    expect(w.statusCode).toBe(403);
    expect(JSON.parse(w.body).reason).toBe('capability');
    expect((await t.as(null, { url: '/api/servers' })).statusCode).toBe(401);
    const csrf = await t.s.app.inject({ method: 'PATCH', url: `/api/servers/${server.id}`, payload: { description: 'x' }, headers: { cookie: t.admin.cookie } });
    expect(JSON.parse(csrf.body).reason).toBe('csrf');
  });

  it('delete needs the slug', async () => {
    const list = await t.json(t.admin, { url: '/api/servers' }, 200);
    const p2 = list.items.find((x: any) => x.slug === 'pets2');
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/servers/${p2.id}?confirm=nope` })).statusCode).toBe(422);
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/servers/${p2.id}?confirm=pets2` })).statusCode).toBe(204);
  });
});
