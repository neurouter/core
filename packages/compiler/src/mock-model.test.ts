import { describe, expect, it } from 'vitest';
import { handleMockRequest } from './mock/handler.js';
import type { OpenApiMockModel } from './mock/model.js';
import { exampleFits, generateValue, seededFaker, stringFits } from './mock/generate.js';
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
  it('seeds 20 items deterministically per (namespace seed, resource), whatever the namespace name or scope', async () => {
    const m = await model();
    const a = await handleMockRequest(m, new MockStore(), 'ns', { method: 'GET', path: '/projects/p1/notes?per_page=100' });
    const b = await handleMockRequest(m, new MockStore(), 'other', { method: 'GET', path: '/projects/p1/notes?per_page=100' });
    expect(a.status).toBe(200);
    expect(a.body).toHaveLength(20);
    expect(b.body).toEqual(a.body);
    const c = await handleMockRequest(m, new MockStore({ seed: 7 }), 'ns', { method: 'GET', path: '/projects/p1/notes?per_page=100' });
    expect(c.body).not.toEqual(a.body);
    // another scope (or another spelling of it) reads the same items: eval tasks generated from samples in
    // the default scope still match when the agent names the scope differently
    const other = await handleMockRequest(m, new MockStore(), 'eval:run:1', { method: 'GET', path: '/projects/P2/notes?per_page=100' });
    expect(other.body).toEqual(a.body);
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

describe('mock string generation', () => {
  it('honours a minLength above the 24-character cap (GitHub commit SHAs: minLength 40, maxLength 64)', () => {
    const ctx = { faker: seededFaker(1), defs: {}, depth: 0, index: 2 };
    const v = generateValue({ type: 'string', minLength: 40, maxLength: 64, pattern: '^([0-9a-fA-F]{40}(?:[0-9a-fA-F]{24})?)$' }, 'commit_sha', ctx) as string;
    expect(v.length).toBeGreaterThanOrEqual(40);
  });
});

describe('mock values satisfy their schema', () => {
  const ctx = (seed = 1, index = 1) => ({ faker: seededFaker(seed), defs: {}, depth: 0, index });

  it('ignores spec examples that violate the schema (GitHub quotes some date-time examples)', () => {
    const date = { type: 'string', format: 'date-time', examples: ['"2007-10-29T02:42:39.000-07:00"'] };
    expect(exampleFits(date, date.examples[0])).toBe(false);
    expect(exampleFits(date, '2007-10-29T02:42:39.000-07:00')).toBe(true);
    for (let seed = 1; seed < 20; seed++) expect(stringFits(date, generateValue(date, 'date', ctx(seed)) as string)).toBe(true);
    expect(generateValue({ type: 'string', format: 'email', examples: ['octocat@github.com'] }, 'email', ctx())).toBe('octocat@github.com');
  });

  it('honours formats, lengths, patterns, enums and numeric bounds', () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ type: 'string', format: 'uuid' }, 'id'],
      [{ type: 'string', format: 'uri' }, 'html_url'],
      [{ type: 'string', format: 'email' }, 'contact'],
      [{ type: 'string', format: 'date' }, 'due_on'],
      [{ type: 'string', format: 'ipv4' }, 'ip'],
      [{ type: 'string', maxLength: 5 }, 'description'],
      [{ type: 'string', minLength: 30 }, 'name'],
      [{ type: 'string', pattern: '^[a-z]{3}_[0-9]{4}$' }, 'title'],
      [{ type: 'string', maxLength: 3, pattern: '^[A-Z]+$' }, 'state'],
    ];
    for (const [schema, name] of cases)
      for (let seed = 1; seed < 15; seed++) {
        const v = generateValue(schema, name, ctx(seed));
        expect(typeof v === 'string' && stringFits(schema, v), `${JSON.stringify(schema)} → ${JSON.stringify(v)}`).toBe(true);
      }
    for (let seed = 1; seed < 15; seed++) {
      expect(['a', 'b']).toContain(generateValue({ type: 'string', enum: ['a', 'b'] }, 'state', ctx(seed)));
      const n = generateValue({ type: 'integer', minimum: 10, maximum: 12 }, 'count', ctx(seed)) as number;
      expect(n >= 10 && n <= 12 && Number.isInteger(n)).toBe(true);
      const m = generateValue({ type: 'number', exclusiveMinimum: 0, multipleOf: 0.5, maximum: 3 }, 'amount', ctx(seed)) as number;
      expect(m > 0 && m <= 3 && (m * 2) % 1 === 0).toBe(true);
    }
  });

  it('keeps required fields of deep and recursive objects, and respects minItems/uniqueItems', () => {
    const node = { type: 'object', required: ['name', 'child'], properties: { name: { type: 'string' }, note: { type: 'string' }, child: { anyOf: [{ $ref: '#/$defs/Node' }, { type: 'null' }] } } };
    const v = generateValue({ $ref: '#/$defs/Node' }, 'node', { ...ctx(), defs: { Node: node } }) as Record<string, unknown>;
    let cur: Record<string, unknown> | null = v;
    let depth = 0;
    while (cur) {
      expect(typeof cur.name).toBe('string');
      expect('child' in cur).toBe(true);
      cur = cur.child as Record<string, unknown> | null;
      depth++;
    }
    expect(depth).toBeGreaterThan(1);
    const deep = generateValue({ type: 'array', minItems: 2, uniqueItems: true, items: { type: 'string', enum: ['x', 'y', 'z'] } }, 'tags', { ...ctx(), depth: 6 }) as string[];
    expect(deep.length).toBe(2);
    expect(new Set(deep).size).toBe(2);
  });

  it('prefers null over an omitted (too large) part of a nullable field', () => {
    const s = { anyOf: [{ 'x-neurouter-omitted': 'cash_balance', 'x-neurouter-omitted-type': 'object' }, { type: 'null' }] };
    expect(generateValue(s, 'cash_balance', ctx())).toBeNull();
    expect(generateValue({ 'x-neurouter-omitted': 'customer', 'x-neurouter-omitted-type': 'object' }, 'customer', ctx())).toEqual({});
  });
});

describe('mock data is the same for eval generation and eval runs', () => {
  it('samples (gen namespace, default scope) equal what an eval attempt reads with another scope spelling', async () => {
    const m = (await compileFile(GITHUB_SUBSET)).mockModel as OpenApiMockModel;
    const store = new MockStore();
    const samples = await sampleEntities(m, store, 'gen:key:samples-1', 3);
    const issues = samples.find((x) => x.resource === '/repos/{owner}/{repo}/issues')!;
    const run = await handleMockRequest(m, new MockStore(), 'eval:run-1:task-1', { method: 'GET', path: '/repos/octocat/Hello-World/issues?per_page=3' });
    const strip = (it: Record<string, unknown>) => ({ ...it, owner: undefined, repo: undefined });
    expect((run.body as Array<Record<string, unknown>>).map(strip)).toEqual(issues.items.map(strip));
  });

  it('answers actions (no resource) the same in every namespace and for any case of the path params', async () => {
    const m = (await compileFile(GITHUB_SUBSET)).mockModel as OpenApiMockModel;
    const ops = m.operations.filter((o) => o.kind === 'action' && o.method === 'GET' && o.responseSchema);
    expect(ops.length).toBeGreaterThan(0);
    for (const op of ops) {
      const path = op.pathTemplate.replace(/\{[^}]+\}/g, 'Abc');
      const a = await handleMockRequest(m, new MockStore(), 'gen:x', { method: 'GET', path });
      const b = await handleMockRequest(m, new MockStore(), 'eval:y', { method: 'GET', path: path.toLowerCase() });
      expect(b.body).toEqual(a.body);
    }
  });
});
