import { describe, expect, it } from 'vitest';
import { handleMockRequest } from './mock/handler.js';
import type { OpenApiMockModel } from './mock/model.js';
import { mockDataVersionOf, MOCK_DATA_VERSION, withMockDataVersion } from './mock/generate.js';
import { MemoryMockStateStore } from './mock/store.js';
import { compileText } from './test/fixtures.js';

/** A Stripe-like spec: list envelopes, bare `$ref` item schemas, deepObject range filters, id cursors, a nested collection. */
const STRIPE_LIKE = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Pay', version: '1' },
  paths: {
    '/v1/topups': {
      get: {
        operationId: 'GetTopups',
        parameters: [
          { name: 'amount', in: 'query', style: 'deepObject', explode: true, schema: { anyOf: [{ type: 'object', properties: { gt: { type: 'integer' }, gte: { type: 'integer' }, lt: { type: 'integer' }, lte: { type: 'integer' } } }, { type: 'integer' }] } },
          { name: 'status', in: 'query', schema: { type: 'string', enum: ['failed', 'pending', 'succeeded'] } },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 10, maximum: 100 } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
          { name: 'ending_before', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { object: { type: 'string' }, data: { type: 'array', items: { $ref: '#/components/schemas/topup' } }, has_more: { type: 'boolean' } } } } } } },
      },
    },
    '/v1/topups/{topup}': { get: { operationId: 'GetTopup', parameters: [{ name: 'topup', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/topup' } } } } } } },
    '/v1/terminal/configurations': {
      get: {
        operationId: 'GetConfigurations',
        parameters: [{ name: 'is_account_default', in: 'query', schema: { type: 'boolean' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/config' } }, has_more: { type: 'boolean' } } } } } } },
      },
    },
    '/v1/terminal/configurations/{configuration}': { get: { operationId: 'GetConfiguration', parameters: [{ name: 'configuration', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { anyOf: [{ $ref: '#/components/schemas/config' }] } } } } } } },
    '/v1/charges/{charge}/topups': { get: { operationId: 'GetChargeTopups', parameters: [{ name: 'charge', in: 'path', required: true, schema: { type: 'string' } }, { name: 'limit', in: 'query', schema: { type: 'integer' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/topup' } }, has_more: { type: 'boolean' } } } } } } } } },
    '/v1/charges/{charge}/topups/{topup}': { get: { operationId: 'GetChargeTopup', parameters: [{ name: 'charge', in: 'path', required: true, schema: { type: 'string' } }, { name: 'topup', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/topup' } } } } } } },
    '/users/{username}/repos': {
      get: {
        operationId: 'ListRepos',
        parameters: [
          { name: 'username', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['created', 'updated', 'full_name'] } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'per_page', in: 'query', schema: { type: 'integer', default: 30 } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/repo' } } } } } },
      },
    },
    '/repos/{owner}/{repo}': { get: { operationId: 'GetRepo', parameters: [{ name: 'owner', in: 'path', required: true, schema: { type: 'string' } }, { name: 'repo', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/repo' } } } } } } },
  },
  components: {
    schemas: {
      topup: { type: 'object', properties: { id: { type: 'string' }, amount: { type: 'integer' }, currency: { type: 'string' }, created: { type: 'integer' }, status: { type: 'string', enum: ['failed', 'pending', 'succeeded'] }, description: { type: 'string', nullable: true } } },
      config: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' }, is_account_default: { type: 'boolean', nullable: true } } },
      repo: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' }, description: { type: 'string' }, updated_at: { type: 'string', format: 'date-time' }, owner: { type: 'object', properties: { login: { type: 'string' }, name: { type: 'string' } } } } },
    },
  },
});

async function setup() {
  const m = (await compileText(STRIPE_LIKE)).mockModel as OpenApiMockModel;
  const store = new MemoryMockStateStore();
  const get = async (path: string, ns = 'env') => (await handleMockRequest(m, store, ns, { method: 'GET', path })) as { status: number; body: Record<string, unknown> & { data: Array<Record<string, unknown>> } };
  return { m, get };
}

describe('mock fidelity (0.2.2)', () => {
  it('resolves bare $ref item schemas: stable `id` field and filters (Stripe Terminal configurations)', async () => {
    const { m, get } = await setup();
    expect(m.resources['/v1/terminal/configurations']).toMatchObject({ idField: 'id', idType: 'string' });
    const r = await get('/v1/terminal/configurations?is_account_default=false');
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.data.every((c) => c.is_account_default === false)).toBe(true);
    expect(String(r.body.data[0]!.id)).toMatch(/^configuration_\d+$/);
    expect((await get(`/v1/terminal/configurations/${String(r.body.data[0]!.id)}`)).body.id).toBe(r.body.data[0]!.id);
  });

  it('honours range filters (amount[gte]), enum equality, the limit default and id cursors with has_more', async () => {
    const { m, get } = await setup();
    const op = m.operations.find((o) => o.pathTemplate === '/v1/topups' && o.method === 'GET')!;
    expect(op.rangeFilters).toEqual({ amount: 'amount' });
    expect(op.paging).toMatchObject({ limit: 'limit', defaultLimit: 10, maxLimit: 100, startingAfter: 'starting_after', endingBefore: 'ending_before' });
    const all = (await get('/v1/topups?limit=100')).body.data;
    expect(all).toHaveLength(20);
    const cut = [...all.map((t) => Number(t.amount))].sort((a, b) => a - b)[10]!;
    const high = (await get(`/v1/topups?limit=100&amount[gte]=${cut}`)).body.data;
    expect(high.length).toBe(all.filter((t) => Number(t.amount) >= cut).length);
    expect(high.every((t) => Number(t.amount) >= cut)).toBe(true);
    const failed = (await get('/v1/topups?status=failed&limit=100')).body.data;
    expect(failed.every((t) => t.status === 'failed')).toBe(true);
    const first = await get('/v1/topups');
    expect(first.body.data).toHaveLength(10);
    expect(first.body.has_more).toBe(true);
    const next = await get(`/v1/topups?starting_after=${String(first.body.data[9]!.id)}`);
    expect(next.body.data[0]!.id).toBe(all[10]!.id);
    expect(next.body.has_more).toBe(false);
    const prev = await get(`/v1/topups?ending_before=${String(all[10]!.id)}&limit=3`);
    expect(prev.body.data.map((t) => t.id)).toEqual(all.slice(7, 10).map((t) => t.id));
    expect((await get('/v1/topups?starting_after=nope')).status).toBe(400);
  });

  it('sorts (sort + direction; dates descending by default) and pages (page/per_page)', async () => {
    const { get } = await setup();
    const asc = (await get('/users/octocat/repos?sort=updated&direction=asc&per_page=100')).body as unknown as Array<Record<string, string>>;
    const desc = (await get('/users/octocat/repos?sort=updated&per_page=100')).body as unknown as Array<Record<string, string>>;
    const times = (xs: Array<Record<string, string>>) => xs.map((r) => Date.parse(r.updated_at!));
    expect(times(asc)).toEqual([...times(asc)].sort((a, b) => a - b));
    expect(times(desc)).toEqual([...times(desc)].sort((a, b) => b - a));
    const p2 = (await get('/users/octocat/repos?per_page=5&page=2')).body as unknown as Array<Record<string, unknown>>;
    expect(p2.map((r) => r.id)).toEqual([6, 7, 8, 9, 10]);
  });

  it('data version 2: realistic values, newest first; nested collections share the canonical objects', async () => {
    const { get } = await setup();
    const repos = (await get('/users/octocat/repos?per_page=100')).body as unknown as Array<Record<string, unknown>>;
    expect(String(repos[1]!.name)).toMatch(/^[a-z]+-[a-z]+$/);
    expect(String((repos[1]!.owner as Record<string, unknown>).name)).toMatch(/^[A-Z][a-z'.-]+( [A-Z][a-z'.-]+)+/);
    const topups = (await get('/v1/topups?limit=100')).body.data;
    expect(topups.every((t) => /^[a-z]{3}$/.test(String(t.currency)))).toBe(true);
    expect(topups.every((t) => Number(t.amount) >= 500 && Number(t.amount) % 50 === 0)).toBe(true);
    const created = topups.map((t) => Number(t.created));
    expect(created).toEqual([...created].sort((a, b) => b - a));
    const nested = (await get('/v1/charges/ch_1/topups/topup_3')).body;
    const top = (await get('/v1/topups/topup_3')).body;
    expect(nested.amount).toBe(top.amount);
    expect(nested.created).toBe(top.created);
  });

  it('data version 1 (`dv1` namespaces) keeps the 0.2.1 values: what frozen 0.2.1 suites name', async () => {
    const { get } = await setup();
    const v1 = (await get('/v1/topups?limit=100', 'eval:x:dv1:t')).body.data;
    const v2 = (await get('/v1/topups?limit=100', 'eval:x:t')).body.data;
    expect(v1.map((t) => t.id)).toEqual(v2.map((t) => t.id));
    expect(v1.some((t) => Number(t.amount) <= 100)).toBe(true);
    expect(mockDataVersionOf('eval:run:dv1:key')).toBe(1);
    expect(mockDataVersionOf('env')).toBe(MOCK_DATA_VERSION);
    expect(withMockDataVersion('gen:k:gt-1', 1)).toBe('gen:k:dv1:gt-1');
    expect(withMockDataVersion('gen:k:gt-1', 2)).toBe('gen:k:gt-1');
  });
});
