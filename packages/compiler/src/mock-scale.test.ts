import { describe, expect, it } from 'vitest';
import { handleMockRequest, MOCK_PAGING_HEADER } from './mock/handler.js';
import type { OpenApiMockModel } from './mock/model.js';
import { mockScaleOf, mockScaleSegment, normalizeMockScale, SEED_ITEMS, withMockDataVersion, withMockScale } from './mock/generate.js';
import { MemoryMockStateStore, seedItems, seedItemsFor } from './mock/store.js';
import { compileText } from './test/fixtures.js';

/** Stripe-like (id cursors, a nested collection), GitHub-like (page/per_page, nested per repo and per pull) and a cursor list. */
const SPEC = JSON.stringify({
  openapi: '3.0.0',
  info: { title: 'Scale', version: '1' },
  paths: {
    '/v1/charges': {
      get: {
        operationId: 'GetCharges',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/charge' } }, has_more: { type: 'boolean' } } } } } } },
      },
    },
    '/v1/charges/{charge}/refunds': {
      get: {
        operationId: 'GetChargeRefunds',
        parameters: [
          { name: 'charge', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/refund' } }, has_more: { type: 'boolean' } } } } } } },
      },
    },
    '/v1/charges/{charge}': { get: { operationId: 'GetCharge', parameters: [{ name: 'charge', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/charge' } } } } } } },
    '/v1/charges/{charge}/refunds/{refund}': { get: { operationId: 'GetChargeRefund', parameters: [{ name: 'charge', in: 'path', required: true, schema: { type: 'string' } }, { name: 'refund', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/refund' } } } } } } },
    '/repos/{owner}/{repo}/pulls/{pull_number}': { get: { operationId: 'GetPull', parameters: [{ name: 'owner', in: 'path', required: true, schema: { type: 'string' } }, { name: 'repo', in: 'path', required: true, schema: { type: 'string' } }, { name: 'pull_number', in: 'path', required: true, schema: { type: 'integer' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/pull' } } } } } } },
    '/items/{id}': { get: { operationId: 'GetItem', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/item' } } } } } } },
    '/v1/refunds': {
      get: {
        operationId: 'GetRefunds',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer' } },
          { name: 'starting_after', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array', items: { $ref: '#/components/schemas/refund' } }, has_more: { type: 'boolean' } } } } } } },
      },
    },
    '/v1/refunds/{refund}': { get: { operationId: 'GetRefund', parameters: [{ name: 'refund', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/refund' } } } } } } },
    '/repos/{owner}/{repo}/pulls': {
      get: {
        operationId: 'ListPulls',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'per_page', in: 'query', schema: { type: 'integer', default: 30 } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/pull' } } } } } },
      },
    },
    '/repos/{owner}/{repo}/pulls/{pull_number}/reviews': {
      get: {
        operationId: 'ListReviews',
        parameters: [
          { name: 'owner', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'repo', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'pull_number', in: 'path', required: true, schema: { type: 'integer' } },
          { name: 'per_page', in: 'query', schema: { type: 'integer', default: 30 } },
          { name: 'page', in: 'query', schema: { type: 'integer' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/review' } } } } } },
      },
    },
    '/items': {
      get: {
        operationId: 'ListItems',
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 25 } },
          { name: 'cursor', in: 'query', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'object', properties: { items: { type: 'array', items: { $ref: '#/components/schemas/item' } }, next_cursor: { type: 'string', nullable: true } } } } } } },
      },
    },
  },
  components: {
    schemas: {
      charge: { type: 'object', properties: { id: { type: 'string' }, amount: { type: 'integer' }, status: { type: 'string', enum: ['failed', 'pending', 'succeeded'] }, created: { type: 'integer' } } },
      refund: { type: 'object', properties: { id: { type: 'string' }, amount: { type: 'integer' }, charge: { type: 'string' } } },
      pull: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, state: { type: 'string', enum: ['open', 'closed'] }, created_at: { type: 'string', format: 'date-time' } } },
      review: { type: 'object', properties: { id: { type: 'integer' }, state: { type: 'string', enum: ['APPROVED', 'COMMENTED'] } } },
      item: { type: 'object', properties: { id: { type: 'string' }, name: { type: 'string' } } },
    },
  },
});

async function setup(seed?: number) {
  const m = (await compileText(SPEC)).mockModel as OpenApiMockModel;
  const store = new MemoryMockStateStore(seed === undefined ? {} : { seed });
  const get = async (ns: string, path: string, headers?: Record<string, string>) => {
    const r = await handleMockRequest(m, store, ns, { method: 'GET', path, ...(headers ? { headers } : {}) });
    expect(r.status).toBe(200);
    return r as { status: number; headers: Record<string, string>; body: any };
  };
  return { m, store, get };
}

async function stripeAll(get: Awaited<ReturnType<typeof setup>>['get'], ns: string, path: string) {
  const out: Array<Record<string, unknown>> = [];
  let after = '';
  for (let i = 0; i < 50; i++) {
    const b = (await get(ns, `${path}?limit=100${after ? `&starting_after=${after}` : ''}`)).body;
    out.push(...b.data);
    if (!b.has_more) return out;
    after = String(b.data[b.data.length - 1].id);
  }
  throw new Error('paging did not end');
}

async function githubAll(get: Awaited<ReturnType<typeof setup>>['get'], ns: string, path: string) {
  const out: Array<Record<string, unknown>> = [];
  for (let page = 1; page < 50; page++) {
    const r = await get(ns, `${path}?per_page=100&page=${page}`);
    out.push(...r.body);
    if (!r.headers.link) return out;
  }
  throw new Error('paging did not end');
}

describe('mock scale (long-workflow evals)', () => {
  it('parses, normalizes and round-trips the namespace segment', () => {
    expect(normalizeMockScale(undefined)).toBeNull();
    expect(normalizeMockScale(200)).toEqual({ items: 200 });
    expect(normalizeMockScale({ items: 100, resources: { 'runner-group': 3, review: [0, 2], refund: [2, 2] } })).toEqual({ items: 100, resources: { runner_group: 3, review: [0, 2], refund: 2 } });
    expect(() => normalizeMockScale({ items: 5000 })).toThrow(/0..1000/);
    expect(() => normalizeMockScale({ resources: { review: [3, 1] } })).toThrow(/min, max/);
    expect(() => normalizeMockScale('big')).toThrow();
    const scale = { items: 200, resources: { review: [0, 2] as [number, number], issue: 150 } };
    expect(mockScaleSegment(scale)).toBe('ms200-issue-150-review-0to2');
    const ns = withMockScale(withMockDataVersion('eval:0b6f7c1e-0000-4000-8000-000000000000:task_n200_gpt_tool_1', 1), scale);
    expect(ns).toBe('eval:0b6f7c1e-0000-4000-8000-000000000000:ms200-issue-150-review-0to2:dv1:task_n200_gpt_tool_1');
    expect(mockScaleOf(ns)).toEqual(scale);
    expect(mockScaleOf('tenant/env/gen:k:ms20:gt-1')).toEqual({ items: 20 });
    expect(mockScaleOf('eval:run:task_ms200_tool')).toBeNull();
    expect(withMockScale('eval:run:key', null)).toBe('eval:run:key');
  });

  it('default namespaces keep the 20 seed items (unchanged), a scaled one seeds 20 / 100 / 200 and its first 20 top-level items equal the default', async () => {
    const { m, get } = await setup();
    const charges = Object.values(m.resources).find((r) => r.key === '/v1/charges')!;
    expect(seedItems(charges, {}, 42)).toEqual(seedItemsFor(charges, {}, 42, 'env'));
    expect(seedItems(charges, {}, 42)).toHaveLength(SEED_ITEMS);
    const base = await stripeAll(get, 'env', '/v1/charges');
    expect(base).toHaveLength(20);
    for (const n of [20, 100, 200]) {
      const all = await stripeAll(get, `gen:k:ms${n}`, '/v1/charges');
      expect(all).toHaveLength(n);
      expect(new Set(all.map((c) => c.id)).size).toBe(n);
      expect(all.slice(0, 20)).toEqual(base);
    }
  });

  it('Stripe paging across 200 items: limit capped at 100, starting_after and has_more', async () => {
    const { get } = await setup();
    const ns = 'gen:k:ms200';
    const p1 = (await get(ns, '/v1/charges?limit=1000')).body;
    expect(p1.data).toHaveLength(100);
    expect(p1.has_more).toBe(true);
    const p2 = (await get(ns, `/v1/charges?limit=100&starting_after=${p1.data[99].id}`)).body;
    expect(p2.data).toHaveLength(100);
    expect(p2.has_more).toBe(false);
    expect(p2.data[0].id).toBe('charge_101');
    // the default (unscaled) namespace keeps its old maximum
    expect((await get('env', '/v1/charges?limit=1000')).body.data).toHaveLength(20);
  });

  it('GitHub paging across 200 items: per_page capped at 100, page and the next link', async () => {
    const { get } = await setup();
    const ns = 'gen:k:ms200';
    const p1 = await get(ns, '/repos/octocat/hello-world/pulls?per_page=500');
    expect(p1.body).toHaveLength(100);
    expect(p1.headers.link).toContain('page=2');
    const p2 = await get(ns, '/repos/octocat/hello-world/pulls?per_page=100&page=2');
    expect(p2.body.map((p: { number: number }) => p.number)[0]).toBe(101);
    expect(p2.headers.link).toBeUndefined();
    expect(await githubAll(get, ns, '/repos/octocat/hello-world/pulls')).toHaveLength(200);
  });

  it('cursor lists (contract-2 next-page tokens) walk 100 and 200 items', async () => {
    const { get } = await setup();
    for (const n of [100, 200]) {
      const seen: string[] = [];
      let cursor = '';
      for (let i = 0; i < 20; i++) {
        const b = (await get(`gen:k:ms${n}`, `/items?limit=100${cursor ? `&cursor=${cursor}` : ''}`, { [MOCK_PAGING_HEADER]: 'tokens' })).body;
        expect(b.items.length).toBeLessThanOrEqual(100);
        seen.push(...b.items.map((x: { id: string }) => x.id));
        if (!b.next_cursor) break;
        cursor = b.next_cursor;
      }
      expect(seen).toHaveLength(n);
      expect(new Set(seen).size).toBe(n);
    }
  });

  it('nested collections scale too: per-resource counts and ranges, a separate seed per scope (case-insensitive)', async () => {
    const { m, get } = await setup();
    expect(m.resources['/v1/charges/{charge}/refunds']?.seedKey).toBe('/v1/refunds');
    const ns = withMockScale('gen:k', { items: 200, resources: { refund: [1, 4], review: [0, 2] } });
    const charges = await stripeAll(get, ns, '/v1/charges');
    const counts = [];
    for (const c of charges) {
      const refunds = await stripeAll(get, ns, `/v1/charges/${String(c.id)}/refunds`);
      counts.push(refunds.length);
      expect(refunds.every((r) => r.charge === c.id)).toBe(true);
    }
    expect(Math.min(...counts)).toBe(1);
    expect(Math.max(...counts)).toBe(4);
    // linked to /v1/refunds: each charge lists its own subset of the canonical refunds (same state as retrieve);
    // the top-level collection keeps `items` (overrides apply to scoped collections)
    expect(await stripeAll(get, ns, '/v1/refunds')).toHaveLength(200);
    const one = (await get(ns, '/v1/charges/charge_1/refunds')).body.data;
    const canon = (await get(ns, `/v1/refunds/${one[0].id}`)).body;
    expect(canon.amount).toBe(one[0].amount);
    const a = (await get(ns, '/v1/charges/charge_1/refunds')).body.data;
    const b = (await get(ns, '/v1/charges/charge_2/refunds')).body.data;
    expect(a.map((r: { id: string }) => r.id)).not.toEqual(b.map((r: { id: string }) => r.id));
    const reviews = [];
    for (let n = 1; n <= 30; n++) reviews.push((await get(ns, `/repos/octocat/Hello-World/pulls/${n}/reviews`)).body.length);
    expect(new Set(reviews)).toEqual(new Set([0, 1, 2]));
    // owner/repo spelled differently: the same collection
    expect((await get(ns, '/repos/OctoCat/hello-world/pulls?per_page=5')).body).toEqual((await get(ns, '/repos/octocat/Hello-World/pulls?per_page=5')).body);
    // an issue-scale override leaves other resources at `items`
    expect(await githubAll(get, ns, '/repos/octocat/other/pulls')).toHaveLength(200);
  });

  it('is deterministic: two stores, the same namespace scale, the same data', async () => {
    const one = await setup();
    const two = await setup();
    const ns = 'gen:a:ms100-review-0to2';
    expect(await stripeAll(one.get, ns, '/v1/charges')).toEqual(await stripeAll(two.get, 'eval:b:ms100-review-0to2:x', '/v1/charges'));
    expect((await one.get(ns, '/repos/octocat/r/pulls/7/reviews')).body).toEqual((await two.get(ns, '/repos/octocat/r/pulls/7/reviews')).body);
    const other = await setup(7);
    expect(await stripeAll(other.get, ns, '/v1/charges')).not.toEqual(await stripeAll(one.get, ns, '/v1/charges'));
  });
});
