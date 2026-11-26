import { buildSchema, introspectionFromSchema } from 'graphql';
import { describe, expect, it } from 'vitest';
import type { GraphqlBinding } from '@neurouter/shared';
import { compileFile, compileText, COUNTRIES, read } from './test/fixtures.js';

const CONNECTION_SDL = `
type Query {
  "List users with cursor pagination."
  users(first: Int = 10, after: String): UserConnection!
  "Get a user."
  user(id: ID!): User
}
type Mutation { "Create a user." createUser(input: NewUser!): User deleteUser(id: ID!): Boolean }
type Subscription { userAdded: User }
input NewUser { name: String!, role: Role = MEMBER }
enum Role { ADMIN MEMBER }
type User { id: ID! name: String! role: Role! manager: User posts(first: Int!): [Post!]! }
type Post { id: ID! title: String! }
type UserConnection { edges: [UserEdge!]! pageInfo: PageInfo! totalCount: Int! }
type UserEdge { cursor: String! node: User! }
type PageInfo { hasNextPage: Boolean! endCursor: String startCursor: String }
`;

describe('GraphQL pipeline', () => {
  it('compiles the countries SDL', async () => {
    const r = await compileFile(COUNTRIES, undefined, 'countries');
    expect(r.format).toBe('graphql-sdl');
    expect(r.ok).toBe(true);
    expect(r.tools.map((t) => t.name)).toEqual(['continents', 'continent', 'countries', 'country', 'languages', 'language', 'suggest_capital']);
    const country = r.tools.find((t) => t.name === 'country')!;
    expect(country.kind).toBe('graphql');
    expect(country.key).toBe('graphql:Query.country');
    expect(country.inputSchema).toMatchObject({ properties: { code: { type: 'string' } }, required: ['code'] });
    const b = country.binding as GraphqlBinding;
    expect(b.document).toMatch(/^query country\(\$code: ID!\) \{\n {2}country\(code: \$code\) \{/);
    expect(b.resultPath).toEqual(['country']);
    expect(b.endpointPath).toBe('/graphql');
    expect(r.tools.find((t) => t.name === 'suggest_capital')!.risk.write).toBe(true);
    expect(r.mockModel?.kind).toBe('graphql');
  });

  it('accepts introspection JSON', async () => {
    const json = JSON.stringify({ data: introspectionFromSchema(buildSchema(read(COUNTRIES).toString())) });
    const r = await compileText(json);
    expect(r.format).toBe('graphql-introspection');
    expect(r.tools).toHaveLength(7);
  });

  it('honours selection depth, connections, required-arg fields and subscriptions', async () => {
    const r = await compileText(CONNECTION_SDL);
    expect(r.diagnostics.some((d) => d.code === 'subscriptions_skipped')).toBe(true);
    const users = r.tools.find((t) => t.name === 'users')!;
    const doc = (users.binding as GraphqlBinding).document;
    expect(doc).toContain('edges {');
    expect(doc).toContain('node {');
    expect(doc).toContain('pageInfo { hasNextPage endCursor }');
    expect(doc).not.toContain('posts'); // required arg → not auto-selected
    expect(users.inputSchema).toMatchObject({ properties: { first: { type: 'integer', default: 10 }, after: { type: 'string' } } });
    const user = r.tools.find((t) => t.name === 'user')!;
    const ud = (user.binding as GraphqlBinding).document;
    expect(ud).toContain('manager {'); // depth 2 includes one nested object level
    const create = r.tools.find((t) => t.name === 'create_user')!;
    expect(create.inputSchema.properties).toMatchObject({ input: { type: 'object', properties: { role: { enum: ['ADMIN', 'MEMBER'] } }, required: ['name'] } });
    expect(r.tools.find((t) => t.name === 'delete_user')!.risk.destructive).toBe(true);
    const shallow = await compileText(CONNECTION_SDL);
    expect(shallow.tools).toHaveLength(4);
  });

  it('depth 1 selects only scalars', async () => {
    const { compile } = await import('./compile.js');
    const r = await compile({ spec: { bytes: new TextEncoder().encode(CONNECTION_SDL), graphql: { selectionDepth: 1 } }, namespace: 'g' });
    const doc = (r.tools.find((t) => t.name === 'user')!.binding as GraphqlBinding).document;
    expect(doc).not.toContain('manager');
    expect(doc).toContain('role');
  });

  it('reports invalid SDL as spec_invalid', async () => {
    const r = await compileText('type Query { broken: Nope }');
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]!.code).toBe('spec_invalid');
  });
});
