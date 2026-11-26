import { buildSchema, introspectionFromSchema } from 'graphql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/fakes/app-context.js';

/** A synthetic schema the size of a real business API: 120 queries, 240 mutations, nested inputs, enums, connections. */
function bigSchemaSdl(): string {
  const parts: string[] = ['enum Status { ACTIVE ARCHIVED DRAFT }', 'type PageInfo { hasNextPage: Boolean! endCursor: String }'];
  const q: string[] = [];
  const m: string[] = [];
  for (let i = 0; i < 120; i++) {
    parts.push(`"Entity ${i}" type Entity${i} { id: ID! name: String status: Status createdAt: String owner: Entity${(i + 1) % 120} tags: [String!] }`);
    parts.push(`type Entity${i}Edge { node: Entity${i} cursor: String! } type Entity${i}Connection { edges: [Entity${i}Edge!]! pageInfo: PageInfo! }`);
    parts.push(`input Entity${i}Input { name: String! status: Status meta: Meta${i}Input }`, `input Meta${i}Input { key: String! value: String }`);
    q.push(`"Get entity ${i}" entity${i}(id: ID!): Entity${i}`, `"List entities ${i}" entities${i}(first: Int, after: String): Entity${i}Connection!`);
    m.push(`"Create entity ${i}" createEntity${i}(input: Entity${i}Input!): Entity${i}`, `deleteEntity${i}(id: ID!): Boolean`);
  }
  return `${parts.join('\n')}\ntype Query { ${q.join('\n')} }\ntype Mutation { ${m.join('\n')} }`;
}

const INTROSPECTION = JSON.stringify({ data: introspectionFromSchema(buildSchema(bigSchemaSdl())) });

interface Seen {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

describe('console GraphQL endpoint import (specs.preview { graphqlEndpoint })', () => {
  let t: TestContext;
  const seen: Seen[] = [];
  beforeAll(async () => {
    const fake = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
      const url = String(input);
      seen.push({ url, method: init.method ?? 'GET', headers: new Headers(init.headers), body: String(init.body ?? '') });
      if (url.startsWith('https://down.test')) throw new Error('getaddrinfo ENOTFOUND down.test');
      if (url.startsWith('https://blocked.test')) throw new Error('Blocked: blocked.test resolves to a forbidden address');
      if (url.startsWith('https://locked.test')) return new Response('{"errors":[{"message":"GraphQL introspection is not allowed"}]}', { status: 200, headers: { 'content-type': 'application/json' } });
      if (url.startsWith('https://auth.test')) {
        if (new Headers(init.headers).get('authorization') !== 'Bearer t0ken') return new Response('{"errors":[{"message":"unauthorized"}]}', { status: 401 });
      }
      // some servers answer 406 unless the Accept list has a wildcard (seen in production)
      if (url.startsWith('https://strict.test') && !new Headers(init.headers).get('accept')?.includes('*/*')) return new Response('{"errors":[{"message":"406 Unsupported API version"}]}', { status: 406 });
      if (url.startsWith('https://gone.test')) return new Response('{"errors":[{"message":"no such route"}]}', { status: 404 });
      if (url.startsWith('https://html.test')) return new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } });
      return new Response(INTROSPECTION, { status: 200, headers: { 'content-type': 'application/json' } });
    };
    process.env.GQL_TOKEN = 'Bearer t0ken'; // env:NAME references read the process env (like upstream credentials)
    t = await createTestContext({}, { outboundFetch: fake as never });
  }, 60_000);
  afterAll(async () => {
    delete process.env.GQL_TOKEN;
    await t?.close();
  });

  const preview = (source: Record<string, unknown>) => t.as(t.admin, { method: 'POST', url: '/api/spec-previews', payload: { source } });

  it('introspects with one POST, compiles the schema and creates a server with a mock environment', async () => {
    const r = await preview({ graphqlEndpoint: 'https://api.example.test/graphql' });
    expect(r.statusCode).toBe(202);
    const call = seen.at(-1)!;
    expect(call).toMatchObject({ url: 'https://api.example.test/graphql', method: 'POST' });
    expect(JSON.parse(call.body).query).toContain('__schema');
    const p = await t.json(t.admin, { url: `/api/spec-previews/${JSON.parse(r.body).previewId}` }, 200);
    expect(p).toMatchObject({ status: 'ready', kind: 'graphql', format: 'graphql-introspection', operationCount: 480, counts: { tools: 480, writeTools: 240 } });
    expect(p.name).toBe('api.example.test GraphQL');
    expect(p.slug).toBe('api-example-test-graphql');
    expect(p.diagnostics.filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);
    const created = await t.json(t.admin, { method: 'POST', url: '/api/servers', payload: { previewId: p.id, slug: 'gql-big', name: 'Big GraphQL' } }, 201);
    expect(created).toMatchObject({ kind: 'graphql', specFormat: 'graphql-introspection', visibleToolCount: 480 });
    expect(created.environments.map((e: { slug: string }) => e.slug)).toEqual(['mock']);
    expect(created.specSource.url).toBe('https://api.example.test/graphql');
  });

  it('sends an Accept list servers that answer 406 to plain application/json accept', async () => {
    expect((await preview({ graphqlEndpoint: 'https://strict.test/graphql' })).statusCode).toBe(202);
  });

  it('sends one-off headers with the introspection request and never stores them', async () => {
    const r = await preview({ graphqlEndpoint: 'https://auth.test/graphql', headers: [{ name: 'Authorization', value: 'Bearer t0ken' }] });
    expect(r.statusCode).toBe(202);
    expect(seen.at(-1)!.headers.get('authorization')).toBe('Bearer t0ken');
    const p = await t.json(t.admin, { url: `/api/spec-previews/${JSON.parse(r.body).previewId}` }, 200);
    const created = await t.json(t.admin, { method: 'POST', url: '/api/servers', payload: { previewId: p.id, slug: 'gql-auth', name: 'Auth GraphQL' } }, 201);
    const db = t.s.services.dbs.main.db;
    const row = await db.selectFrom('servers').select(['spec_source']).where('id', '=', created.id).executeTakeFirstOrThrow();
    const previews = await db.selectFrom('spec_previews').select(['state']).execute();
    const revs = await db.selectFrom('spec_revisions').select(['source_url']).where('server_id', '=', created.id).execute();
    expect(JSON.stringify([row, previews, revs])).not.toContain('t0ken');
    expect(JSON.parse(String(row.spec_source))).toMatchObject({ graphqlEndpoint: 'https://auth.test/graphql', format: 'graphql-introspection' });
  });

  it('a headerRef (env:NAME) is resolved on the server and kept for re-imports, which introspect again', async () => {
    const r = await preview({ graphqlEndpoint: 'https://auth.test/v2/graphql', headerRef: { name: 'Authorization', secretRef: 'env:GQL_TOKEN' } });
    expect(r.statusCode).toBe(202);
    const p = await t.json(t.admin, { url: `/api/spec-previews/${JSON.parse(r.body).previewId}` }, 200);
    const created = await t.json(t.admin, { method: 'POST', url: '/api/servers', payload: { previewId: p.id, slug: 'gql-ref', name: 'Ref GraphQL' } }, 201);
    const before = seen.length;
    const re = await t.as(t.admin, { method: 'POST', url: `/api/servers/${created.id}/specs`, payload: {} });
    expect(re.statusCode).toBe(202);
    expect(seen.length).toBe(before + 1);
    expect(seen.at(-1)).toMatchObject({ url: 'https://auth.test/v2/graphql', method: 'POST' });
    expect(seen.at(-1)!.headers.get('authorization')).toBe('Bearer t0ken');
    const bad = await preview({ graphqlEndpoint: 'https://auth.test/graphql', headerRef: { name: 'Authorization', secretRef: 'secret:tok' } });
    expect(bad.statusCode).toBe(422);
  });

  it.each([
    ['https://down.test/graphql', 'unreachable'],
    ['https://blocked.test/graphql', 'blocked_host'],
    ['https://locked.test/graphql', 'introspection_disabled'],
    ['https://auth.test/graphql', 'unauthorized'],
    ['https://html.test/graphql', 'not_graphql'],
    ['https://gone.test/graphql', 'upstream_status'],
  ])('%s → 502 spec_fetch_failed (%s) and nothing is stored', async (url, reason) => {
    const n = (await t.s.services.dbs.main.db.selectFrom('spec_previews').select('id').execute()).length;
    const r = await preview({ graphqlEndpoint: url });
    expect(r.statusCode).toBe(502);
    expect(JSON.parse(r.body)).toMatchObject({ code: 'spec_fetch_failed', reason });
    expect((await t.s.services.dbs.main.db.selectFrom('spec_previews').select('id').execute()).length).toBe(n);
  });
});
