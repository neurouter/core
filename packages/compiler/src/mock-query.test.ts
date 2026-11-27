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
    // the same objects (0.3.2: both lists newest first by created, which reorders the version-1 values)
    expect(v1.map((t) => String(t.id)).sort()).toEqual(v2.map((t) => String(t.id)).sort());
    expect(v1.some((t) => Number(t.amount) <= 100)).toBe(true);
    expect(mockDataVersionOf('eval:run:dv1:key')).toBe(1);
    expect(mockDataVersionOf('env')).toBe(MOCK_DATA_VERSION);
    expect(withMockDataVersion('gen:k:gt-1', 1)).toBe('gen:k:dv1:gt-1');
    expect(withMockDataVersion('gen:k:gt-1', 2)).toBe('gen:k:gt-1');
  });
});

/**
 * 0.3.2: the P6 Stripe failures on mock data v1 (the stored suites' version), with the real paths and descriptions.
 * retrieve_first_refund_for_charge: `GET /v1/charges/demo/refunds` listed refund_1 with amount 17,
 * `GET /v1/refunds/refund_1` returned amount 99 (and charge "TLrT3yX"). retrieve_newest_event:
 * `GET /v1/events?limit=1` returned event_1 (created 60) while event_8 (created 93) was the newest.
 */
const STRIPE_P6 = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Stripe subset', version: '1' },
  paths: {
    '/v1/charges/{charge}/refunds': {
      get: {
        operationId: 'GetChargesChargeRefunds',
        description: 'You can see a list of the refunds belonging to a specific charge. Note that the 10 most recent refunds are always available by default on the charge object. If you need more than those 10, you can use this API method and the <code>limit</code> and <code>starting_after</code> parameters to page through additional refunds.',
        parameters: [
          { name: 'charge', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
          { name: 'ending_before', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { object: { type: 'string', enum: ['list'] }, data: { type: 'array', items: { $ref: '#/components/schemas/refund' } }, has_more: { type: 'boolean' }, url: { type: 'string' } } } } } } },
      },
    },
    '/v1/charges/{charge}/refunds/{refund}': { get: { operationId: 'GetChargesChargeRefundsRefund', parameters: [{ name: 'charge', in: 'path', required: true, schema: { type: 'string' } }, { name: 'refund', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/refund' } } } } } } },
    '/v1/refunds': {
      get: {
        operationId: 'GetRefunds',
        description: 'Returns a list of all refunds you created. We return the refunds in sorted order, with the most recent refunds appearing first. The 10 most recent refunds are always available by default on the Charge object.',
        parameters: [
          { name: 'charge', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
          { name: 'ending_before', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { object: { type: 'string', enum: ['list'] }, data: { type: 'array', items: { $ref: '#/components/schemas/refund' } }, has_more: { type: 'boolean' }, url: { type: 'string' } } } } } } },
      },
      post: { operationId: 'PostRefunds', requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { charge: { type: 'string' }, amount: { type: 'integer' } } } } } }, responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/refund' } } } } } },
    },
    '/v1/refunds/{refund}': { get: { operationId: 'GetRefundsRefund', parameters: [{ name: 'refund', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/refund' } } } } } } },
    '/v1/events': {
      get: {
        operationId: 'GetEvents',
        description: 'List events, going back up to 30 days. Each event data is rendered according to Stripe API version at its creation time, specified in event object api_version attribute (not according to your current Stripe API version or Stripe-Version header).',
        parameters: [
          { name: 'type', in: 'query', schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
          { name: 'ending_before', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { object: { type: 'string', enum: ['list'] }, data: { type: 'array', items: { $ref: '#/components/schemas/event' } }, has_more: { type: 'boolean' }, url: { type: 'string' } } } } } } },
      },
    },
    '/v1/events/{id}': { get: { operationId: 'GetEventsId', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/event' } } } } } } },
    '/repos/{owner}/{repo}/issues': {
      get: {
        operationId: 'issues/list-for-repo',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { type: 'string', enum: ['created', 'updated', 'comments'], default: 'created' } },
          { name: 'direction', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'], default: 'desc' } },
          { name: 'per_page', in: 'query', schema: { type: 'integer', default: 30 } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/issue' } } } } } },
      },
    },
    '/repos/{owner}/{repo}/issues/{issue_number}': { get: { operationId: 'issues/get', parameters: [{ name: 'owner', in: 'path', required: true, schema: { type: 'string' } }, { name: 'repo', in: 'path', required: true, schema: { type: 'string' } }, { name: 'issue_number', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/issue' } } } } } } },
  },
  components: {
    schemas: {
      refund: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string', enum: ['refund'] }, amount: { type: 'integer' }, charge: { type: 'string', nullable: true }, created: { type: 'integer' }, currency: { type: 'string' }, status: { type: 'string', nullable: true } } },
      event: { type: 'object', properties: { id: { type: 'string' }, object: { type: 'string', enum: ['event'] }, type: { type: 'string' }, created: { type: 'integer' } } },
      issue: { type: 'object', properties: { id: { type: 'integer' }, number: { type: 'integer' }, title: { type: 'string' }, created_at: { type: 'string', format: 'date-time' } } },
    },
  },
});

describe('0.3.2 mock fixes: one state per entity; newest-first lists (P6 Stripe failures, data version 1)', () => {
  const DV1 = 'eval:p6:dv1:a';
  async function p6(overlay?: string) {
    const m = (await compileText(STRIPE_P6, overlay)).mockModel as OpenApiMockModel;
    const store = new MemoryMockStateStore();
    const call = async (method: string, path: string, body?: unknown) => (await handleMockRequest(m, store, DV1, { method, path, ...(body ? { body } : {}) })) as { status: number; body: Record<string, any> };
    return { m, get: (path: string) => call('GET', path), call };
  }

  it('retrieve_first_refund_for_charge: the refund listed under a charge is the refund GET /v1/refunds/{id} returns', async () => {
    const { get } = await p6();
    const first = (await get('/v1/charges/demo/refunds')).body.data[0];
    const one = (await get(`/v1/refunds/${first.id}`)).body;
    expect({ amount: one.amount, status: one.status, created: one.created }).toEqual({ amount: first.amount, status: first.status, created: first.created });
    // the scope it was listed under is part of its state
    expect(first.charge).toBe('demo');
    expect(one.charge).toBe('demo');
    expect((await get(`/v1/charges/demo/refunds/${first.id}`)).body).toEqual(one);
    // every listed refund, and the top-level list, agree with retrieve
    const listed = (await get('/v1/charges/demo/refunds?limit=100')).body.data;
    for (const r of listed) expect((await get(`/v1/refunds/${r.id}`)).body).toEqual(r);
    const top = (await get('/v1/refunds?limit=100')).body.data;
    for (const r of top) expect(listed.find((x) => x.id === r.id) ?? r).toEqual(r);
  });

  it('a refund created under the top level and retrieved under its charge is one object', async () => {
    const { get, call } = await p6();
    const made = (await call('POST', '/v1/refunds', { charge: 'demo', amount: 1234 })).body;
    expect((await get(`/v1/refunds/${made.id}`)).body.amount).toBe(1234);
  });

  it('retrieve_newest_event: Stripe lists are newest first by created (vendor convention; GET /v1/events has no hint)', async () => {
    const { m, get } = await p6();
    expect(m.operations.find((o) => o.pathTemplate === '/v1/events' && o.method === 'GET')!.defaultOrder).toMatchObject({ field: 'created', direction: 'desc' });
    const all = (await get('/v1/events?limit=100')).body.data;
    const created = all.map((e: Record<string, number>) => e.created);
    expect(created).toEqual([...created].sort((a: number, b: number) => b - a));
    const newest = (await get('/v1/events?limit=1')).body.data[0];
    expect(newest.created).toBe(Math.max(...created));
    // starting_after pages through the same order
    const page2 = (await get(`/v1/events?limit=5&starting_after=${all[4].id}`)).body.data;
    expect(page2.map((e: { id: string }) => e.id)).toEqual(all.slice(5, 10).map((e: { id: string }) => e.id));
    for (const p of ['/v1/refunds', '/v1/charges/demo/refunds']) {
      const c = (await get(`${p}?limit=100`)).body.data.map((r: Record<string, number>) => r.created);
      expect(c).toEqual([...c].sort((a: number, b: number) => b - a));
    }
  });

  it('GitHub where documented: sort default "created" with direction default "desc" orders without query params', async () => {
    const { get } = await p6();
    const issues = (await get('/repos/octocat/hello-world/issues?per_page=100')).body as unknown as Array<{ created_at: string }>;
    const t = issues.map((i) => Date.parse(i.created_at));
    expect(t).toEqual([...t].sort((a, b) => b - a));
  });

  it('per-overlay override: mock.order "none" keeps insertion order, "<field> asc" sorts ascending', async () => {
    const none = await p6('overlay: 1\ntools:\n  "operationId:GetEvents":\n    mock: { order: none }\n');
    expect((await none.get('/v1/events?limit=100')).body.data.map((e: { id: string }) => e.id).slice(0, 3)).toEqual(['event_1', 'event_2', 'event_3']);
    const asc = await p6('overlay: 1\ntools:\n  "operationId:GetEvents":\n    mock: { order: created asc }\n');
    const c = (await asc.get('/v1/events?limit=100')).body.data.map((e: Record<string, number>) => e.created);
    expect(c).toEqual([...c].sort((a: number, b: number) => a - b));
  });
});

describe('0.3.2 mock fixes on the real Stripe shape: item schemas inlined, named only by their title', () => {
  it('retrieve_first_refund_for_charge with inline `title: "Refund"` schemas (no $ref): one state per refund', async () => {
    // the compiled Stripe tools carry the item schema inline with its title; matching only `$ref` / `x-schema-name`
    // never linked /v1/charges/{charge}/refunds to /v1/refunds (P6: 17 listed, 99 retrieved)
    const spec = JSON.parse(STRIPE_P6) as { paths: Record<string, Record<string, any>>; components: { schemas: Record<string, any> } };
    const refund = { title: 'Refund', ...spec.components.schemas.refund };
    for (const [path, ops] of Object.entries(spec.paths)) {
      if (!/refunds/.test(path)) continue;
      for (const op of Object.values(ops)) {
        const content = op.responses['200'].content['application/json'];
        if (content.schema.$ref) content.schema = refund;
        else content.schema.properties.data.items = refund;
      }
    }
    const m = (await compileText(JSON.stringify(spec))).mockModel as OpenApiMockModel;
    expect(m.resources['/v1/charges/{charge}/refunds']!.seedKey).toBe('/v1/refunds');
    const store = new MemoryMockStateStore();
    const get = async (path: string) => (await handleMockRequest(m, store, 'eval:p6:dv1:a', { method: 'GET', path })).body as Record<string, any>;
    const first = (await get('/v1/charges/demo/refunds')).data[0];
    expect(await get(`/v1/refunds/${first.id}`)).toEqual(first);
  });
});
