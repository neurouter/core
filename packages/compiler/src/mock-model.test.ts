import { describe, expect, it } from 'vitest';
import { handleMockRequest } from './mock/handler.js';
import type { OpenApiMockModel } from './mock/model.js';
import { MemoryMockStateStore, MOCK_MAX_ITEMS, MockStore, sampleEntities, type MockNs } from './mock/store.js';
import { compileFile, compileText, COUNTRIES, GITHUB_SUBSET, NOTES_SPEC, PETSTORE } from './test/fixtures.js';

async function model(text = NOTES_SPEC) {
  return (await compileText(text)).mockModel as OpenApiMockModel;
}

describe('mock model', () => {
  it('infers resources, scopes, id fields and operation kinds', async () => {
    const m = await model();
    expect(Object.keys(m.resources)).toEqual(['/projects/{project}/notes']);
    expect(m.resources['/projects/{project}/notes']).toMatchObject({ name: 'note', idField: 'id', idType: 'integer', scopeParams: ['project'] });
    const kinds = Object.fromEntries(m.operations.map((o) => [`${o.method} ${o.pathTemplate}`, o.kind]));
    expect(kinds).toEqual({
      'GET /projects/{project}/notes/{note_id}': 'read',
      'PATCH /projects/{project}/notes/{note_id}': 'update',
      'DELETE /projects/{project}/notes/{note_id}': 'delete',
      'GET /projects/{project}/notes': 'list',
      'POST /projects/{project}/notes': 'create',
    });
    const list = m.operations.find((o) => o.kind === 'list')!;
    expect(list.filters).toEqual({ state: 'state' });
    expect(list.paging).toEqual({ limit: 'per_page', page: 'page' });
  });

  it('infers Petstore resources incl. list aliases and string ids', async () => {
    const m = (await compileFile(PETSTORE)).mockModel as OpenApiMockModel;
    expect(Object.keys(m.resources).sort()).toEqual(['/pet', '/store/order', '/user']);
    expect(m.resources['/user']).toMatchObject({ idField: 'username', idType: 'string' });
    expect(m.operations.find((o) => o.pathTemplate === '/pet/findByStatus')).toMatchObject({ kind: 'list', resource: '/pet', filters: { status: 'status' } });
    expect(m.operations.find((o) => o.method === 'PUT' && o.pathTemplate === '/pet')).toMatchObject({ kind: 'replace', bodyId: true });
  });

  it('matches GitHub item ids by suffix (issue_number → number)', async () => {
    const m = (await compileFile(GITHUB_SUBSET)).mockModel as OpenApiMockModel;
    expect(m.resources['/repos/{owner}/{repo}/issues']).toMatchObject({ idField: 'number', scopeParams: ['owner', 'repo'] });
    expect(m.resources['/repos/{owner}/{repo}/pulls']).toMatchObject({ idField: 'number' });
  });
});

describe('mock handler', () => {
  it('seeds 20 items deterministically per scope', async () => {
    const m = await model();
    const a = await handleMockRequest(m, new MockStore(), 'ns', { method: 'GET', path: '/projects/p1/notes?per_page=100' });
    const b = await handleMockRequest(m, new MockStore(), 'other', { method: 'GET', path: '/projects/p1/notes?per_page=100' });
    expect(a.status).toBe(200);
    expect(a.body).toHaveLength(20);
    expect(b.body).toEqual(a.body);
    const c = await handleMockRequest(m, new MockStore({ seed: 7 }), 'ns', { method: 'GET', path: '/projects/p1/notes?per_page=100' });
    expect(c.body).not.toEqual(a.body);
    const other = await handleMockRequest(m, new MockStore(), 'ns', { method: 'GET', path: '/projects/p2/notes?per_page=100' });
    expect(other.body).not.toEqual(a.body);
    expect((a.body as Array<{ id: number }>).map((x) => x.id)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('supports CRUD, 404, 422, filters and pagination', async () => {
    const m = await model();
    const s = new MockStore({ now: () => Date.parse('2026-02-01T00:00:00Z') });
    const call = (method: string, path: string, body?: unknown) => handleMockRequest(m, s, 'ns', { method, path, body });
    const created = await call('POST', '/projects/p/notes', { title: 'Hello' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ id: 21, title: 'Hello', updated_at: '2026-02-01T00:00:00.000Z' });
    expect((await call('GET', '/projects/p/notes/21')).body).toMatchObject({ title: 'Hello' });
    expect((await call('PATCH', '/projects/p/notes/21', { state: 'closed' })).body).toMatchObject({ id: 21, title: 'Hello', state: 'closed', updated_at: '2026-02-01T00:00:00.000Z' });
    expect((await call('DELETE', '/projects/p/notes/21')).status).toBe(204);
    expect((await call('GET', '/projects/p/notes/21')).status).toBe(404);
    expect((await call('GET', '/projects/p/notes/21')).body).toMatchObject({ title: 'Not Found', status: 404 });
    expect((await call('POST', '/projects/p/notes', { body: 'no title' })).status).toBe(422);
    expect((await call('POST', '/projects/p/notes', { title: 5 })).status).toBe(422);
    const page1 = (await call('GET', '/projects/p/notes?per_page=5&page=1')).body as Array<{ id: number }>;
    const page2 = await call('GET', '/projects/p/notes?per_page=5&page=2');
    expect(page1.map((x) => x.id)).toEqual([1, 2, 3, 4, 5]);
    expect((page2.body as Array<{ id: number }>).map((x) => x.id)).toEqual([6, 7, 8, 9, 10]);
    expect(page2.headers.link).toContain('rel="next"');
    const open = (await call('GET', '/projects/p/notes?state=open&per_page=100')).body as Array<{ state: string }>;
    expect(open.length).toBeGreaterThan(0);
    expect(open.every((n) => n.state === 'open')).toBe(true);
    expect((await call('PUT', '/projects/p/notes/1')).status).toBe(405);
    expect((await call('GET', '/nowhere')).status).toBe(404);
  });

  it('keeps namespaces apart and resets them', async () => {
    const m = await model();
    const s = new MockStore();
    await handleMockRequest(m, s, 'a', { method: 'DELETE', path: '/projects/p/notes/1' });
    expect((await handleMockRequest(m, s, 'a', { method: 'GET', path: '/projects/p/notes/1' })).status).toBe(404);
    expect((await handleMockRequest(m, s, 'b', { method: 'GET', path: '/projects/p/notes/1' })).status).toBe(200);
    s.resetNamespace('a');
    expect((await handleMockRequest(m, s, 'a', { method: 'GET', path: '/projects/p/notes/1' })).status).toBe(200);
  });

  it('evicts least recently used namespaces and expires idle ones', async () => {
    const m = await model();
    let now = 0;
    const s = new MockStore({ maxNamespaces: 2, idleTtlMs: 1000, now: () => now });
    for (const ns of ['a', 'b', 'c']) await handleMockRequest(m, s, ns, { method: 'GET', path: '/projects/p/notes/1' });
    expect(s.namespaces()).toEqual(['b', 'c']);
    await handleMockRequest(m, s, 'b', { method: 'DELETE', path: '/projects/p/notes/1' });
    now = 5000;
    expect((await handleMockRequest(m, s, 'b', { method: 'GET', path: '/projects/p/notes/1' })).status).toBe(200);
  });

  it('serves Petstore operations including list aliases and actions', async () => {
    const m = (await compileFile(PETSTORE)).mockModel!;
    const s = new MockStore();
    const sold = await handleMockRequest(m, s, 'ns', { method: 'GET', path: '/pet/findByStatus', query: { status: 'sold' } });
    expect((sold.body as Array<{ status: string }>).every((p) => p.status === 'sold')).toBe(true);
    const put = await handleMockRequest(m, s, 'ns', { method: 'PUT', path: '/pet', body: { id: 2, name: 'Rex', photoUrls: [] } });
    expect(put.body).toMatchObject({ id: 2, name: 'Rex' });
    expect((await handleMockRequest(m, s, 'ns', { method: 'GET', path: '/user/user_3' })).status).toBe(200);
    expect((await handleMockRequest(m, s, 'ns', { method: 'GET', path: '/store/inventory' })).status).toBe(200);
  });

  it('points integer references (Order.petId) at seeded items, not at the spec example 198772', async () => {
    const m = (await compileFile(PETSTORE)).mockModel!;
    const s = new MockStore();
    for (const id of [1, 2, 3]) {
      const order = (await handleMockRequest(m, s, 'ns', { method: 'GET', path: `/store/order/${id}` })).body as { petId: number };
      expect(order.petId).toBeGreaterThanOrEqual(1);
      expect(order.petId).toBeLessThanOrEqual(20);
      expect((await handleMockRequest(m, s, 'ns', { method: 'GET', path: `/pet/${order.petId}` })).status).toBe(200);
    }
  });

  it('provides sample entities for eval generation', async () => {
    const m = (await compileFile(GITHUB_SUBSET)).mockModel as OpenApiMockModel;
    const samples = await sampleEntities(m, new MockStore(), 'ns');
    const issues = samples.find((x) => x.resource === '/repos/{owner}/{repo}/issues')!;
    expect(issues.scope).toEqual({ owner: 'octocat', repo: 'hello-world' });
    expect(issues.items).toHaveLength(3);
  });

  it('mocks GraphQL statelessly with seeded data', async () => {
    const r = await compileFile(COUNTRIES);
    const doc = (r.tools.find((t) => t.name === 'country')!.binding as { document: string }).document;
    const req = { method: 'POST', path: '/graphql', body: { query: doc, variables: { code: 'FI' } } };
    const a = await handleMockRequest(r.mockModel!, new MockStore(), 'ns', req);
    const b = await handleMockRequest(r.mockModel!, new MockStore(), 'ns', req);
    expect(a.status).toBe(200);
    expect((a.body as { data: { country: { languages: unknown[] } } }).data.country.languages).toHaveLength(5);
    expect(b.body).toEqual(a.body);
    const bad = await handleMockRequest(r.mockModel!, new MockStore(), 'ns', { method: 'POST', path: '/graphql', body: { query: '{ nope }' } });
    expect((bad.body as { errors: unknown[] }).errors.length).toBeGreaterThan(0);
  });
});

describe('MemoryMockStateStore (async MockStateStore over MockStore)', () => {
  const ns = (tenantId: string, environmentId: string, name = 'env'): MockNs => ({ tenantId, environmentId, name });
  const get = (m: OpenApiMockModel, s: MemoryMockStateStore, n: MockNs, path: string) => handleMockRequest(m, s, n, { method: 'GET', path });

  it('gives the same answers as a bare namespace string (back compat)', async () => {
    const m = await model();
    const fixed = () => Date.parse('2026-02-01T00:00:00Z');
    const legacy = new MockStore({ now: fixed });
    const wrapped = new MemoryMockStateStore({ now: fixed });
    const env = ns('t1', 'e1');
    for (const req of [
      { method: 'POST', path: '/projects/p/notes', body: { title: 'x', state: 'open' } },
      { method: 'PATCH', path: '/projects/p/notes/2', body: { title: 'y' } },
      { method: 'DELETE', path: '/projects/p/notes/3' },
      { method: 'GET', path: '/projects/p/notes?per_page=100' },
    ])
      expect(await handleMockRequest(m, wrapped, env, req)).toEqual(await handleMockRequest(m, legacy, 'env:e1', req));
  });

  it('keeps tenants and environments apart for the same namespace name', async () => {
    const m = await model();
    const s = new MemoryMockStateStore();
    await handleMockRequest(m, s, ns('t1', 'e1'), { method: 'DELETE', path: '/projects/p/notes/1' });
    expect((await get(m, s, ns('t1', 'e1'), '/projects/p/notes/1')).status).toBe(404);
    expect((await get(m, s, ns('t2', 'e1'), '/projects/p/notes/1')).status).toBe(200);
    expect((await get(m, s, ns('t1', 'e2'), '/projects/p/notes/1')).status).toBe(200);
    await s.reset(ns('t1', 'e1'));
    expect((await get(m, s, ns('t1', 'e1'), '/projects/p/notes/1')).status).toBe(200);
  });

  it('caps a collection at MOCK_MAX_ITEMS (507 mock_collection_full) and items at 64 KiB (413)', async () => {
    const m = await model();
    const s = new MemoryMockStateStore();
    const n = ns('t1', 'e1');
    for (let i = 20; i < MOCK_MAX_ITEMS; i++) expect((await handleMockRequest(m, s, n, { method: 'POST', path: '/projects/p/notes', body: { title: `n${i}` } })).status).toBe(201);
    const full = await handleMockRequest(m, s, n, { method: 'POST', path: '/projects/p/notes', body: { title: 'one too many' } });
    expect(full).toMatchObject({ status: 507, body: { code: 'mock_collection_full' } });
    await handleMockRequest(m, s, n, { method: 'DELETE', path: '/projects/p/notes/1' });
    expect((await handleMockRequest(m, s, n, { method: 'POST', path: '/projects/p/notes', body: { title: 'fits again' } })).body).toMatchObject({ id: MOCK_MAX_ITEMS + 1 });
    const big = await handleMockRequest(m, s, n, { method: 'PATCH', path: '/projects/p/notes/2', body: { title: 'x'.repeat(70_000) } });
    expect(big).toMatchObject({ status: 413, body: { code: 'mock_item_too_large' } });
    expect(((await get(m, s, n, '/projects/p/notes/2')).body as { title: string }).title).not.toHaveLength(70_000);
  });
});
