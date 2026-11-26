import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { compile, handleMockRequest, MemoryMockStateStore, MOCK_MAX_ITEMS, type MockNs, type MockResource, type OpenApiMockModel } from '@neurouter/compiler';
import { m0009_mock_state } from '../../kernel/db/migrations/main/0009_mock_state.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { newId } from '../../kernel/lib/ids.js';
import { pgliteKysely } from '../../test/fakes/pglite.js';
import { createTestDatabases } from '../../test/fakes/test-db.js';
import { DbMockStateStore, ENV_IDLE_MS } from './db-store.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const HOUR = 3_600_000;

async function petstore(): Promise<OpenApiMockModel> {
  return (await compile({ spec: { bytes: readFileSync(resolve(REPO, 'examples/petstore/openapi.yaml')) }, namespace: 'api' })).mockModel as OpenApiMockModel;
}

describe.each(['sqlite', 'pglite'] as const)('DbMockStateStore on %s', (dialect) => {
  let db: Kysely<MainDB>;
  let close: () => Promise<void>;
  let model: OpenApiMockModel;
  let pet: MockResource;
  let now = Date.parse('2026-03-01T00:00:00Z');
  const clock = () => now;
  let store: DbMockStateStore;
  const ns = (name = 'env', tenantId = T1, environmentId = E1): MockNs => ({ tenantId, environmentId, name });
  const T1 = newId();
  const T2 = newId();
  const E1 = newId();
  const E2 = newId();
  const call = (n: MockNs, method: string, path: string, body?: unknown) => handleMockRequest(model, store, n, { method, path, ...(body !== undefined ? { body } : {}) });
  const collection = (n: MockNs) =>
    db.selectFrom('mock_collections').selectAll().where('tenant_id', '=', n.tenantId).where('environment_id', '=', n.environmentId).where('namespace', '=', n.name).where('collection_key', '=', '/pet|').executeTakeFirstOrThrow();
  const count = async (table: 'mock_items' | 'mock_collections' | 'mock_namespaces', n: MockNs) =>
    Number((await db.selectFrom(table).select((eb) => eb.fn.countAll().as('c')).where('tenant_id', '=', n.tenantId).where('environment_id', '=', n.environmentId).where('namespace', '=', n.name).executeTakeFirstOrThrow()).c);

  beforeAll(async () => {
    if (dialect === 'sqlite') {
      const dbs = await createTestDatabases();
      db = dbs.main.db;
      close = () => dbs.close();
    } else {
      const pg = await pgliteKysely<MainDB>();
      await m0009_mock_state.up(pg.db, { dialect: 'postgres', embeddingDims: 384 });
      ({ db, close } = pg);
    }
    model = await petstore();
    pet = model.resources['/pet']!;
    store = new DbMockStateStore(db, clock);
  }, 60_000);
  afterAll(async () => close?.());

  it('seeds lazily: exactly the items the memory store holds, with a namespace row', async () => {
    const n = ns('env');
    expect(await count('mock_namespaces', n)).toBe(0);
    const items = await store.list(n, pet, {});
    expect(items).toEqual(await new MemoryMockStateStore().list(n, pet, {}));
    expect(items).toHaveLength(20);
    const c = await collection(n);
    expect(c).toMatchObject({ next_id: 21, item_count: 20 });
    expect(await db.selectFrom('mock_namespaces').select(['kind', 'expires_at', 'seed']).where('tenant_id', '=', T1).where('environment_id', '=', E1).where('namespace', '=', 'env').executeTakeFirst()).toEqual({ kind: 'env', expires_at: null, seed: 42 });
    expect(await store.get(n, pet, {}, '7')).toEqual(items[6]);
    expect(await store.get(n, pet, {}, '999')).toBeNull();
  });

  it('allocates unique sequential ids under N parallel creates and keeps the counters right', async () => {
    const n = ns('eval:' + newId() + ':parallel');
    const N = 40;
    const made = await Promise.all(Array.from({ length: N }, (_, i) => call(n, 'POST', '/pet', { name: `p${i}`, photoUrls: [] })));
    expect(made.every((r) => r.status === 200)).toBe(true);
    const ids = made.map((r) => (r.body as { id: number }).id).sort((a, b) => a - b);
    expect(ids).toEqual(Array.from({ length: N }, (_, i) => 21 + i));
    const c = await collection(n);
    expect(c).toMatchObject({ next_id: 21 + N, item_count: 20 + N });
    const listed = await store.list(n, pet, {});
    expect(listed.map((x) => x.id)).toEqual(Array.from({ length: 20 + N }, (_, i) => i + 1));
    const bytes = await db.selectFrom('mock_items').select((eb) => eb.fn.sum<number>('bytes').as('b')).where('tenant_id', '=', n.tenantId).where('environment_id', '=', n.environmentId).where('namespace', '=', n.name).executeTakeFirstOrThrow();
    expect(Number(c.bytes)).toBe(Number(bytes.b));
  });

  it('update is last-writer-wins, delete decrements the counters, bytes stay consistent', async () => {
    const n = ns('eval:' + newId() + ':crud');
    expect((await call(n, 'PUT', '/pet', { id: 2, name: 'A', photoUrls: [] })).status).toBe(200);
    await Promise.all([call(n, 'PUT', '/pet', { id: 3, name: 'B1', photoUrls: [] }), call(n, 'PUT', '/pet', { id: 3, name: 'B2', photoUrls: [] })]);
    expect(['B1', 'B2']).toContain(((await store.get(n, pet, {}, '3')) as { name: string }).name);
    expect((await store.get(n, pet, {}, '2'))!.name).toBe('A');
    expect((await call(n, 'DELETE', '/pet/4')).status).toBe(204);
    expect((await call(n, 'DELETE', '/pet/4')).status).toBe(404);
    expect(await store.put(n, pet, {}, '4', { id: 4 })).toBe(false);
    const c = await collection(n);
    expect(c.item_count).toBe(19);
    const sum = await db.selectFrom('mock_items').select((eb) => eb.fn.sum<number>('bytes').as('b')).where('tenant_id', '=', n.tenantId).where('environment_id', '=', n.environmentId).where('namespace', '=', n.name).executeTakeFirstOrThrow();
    expect(Number(c.bytes)).toBe(Number(sum.b));
  });

  it('caps a collection at 1,000 items (507 mock_collection_full) and an item at 64 KiB (413), changing nothing', async () => {
    const n = ns('eval:' + newId() + ':cap');
    await store.list(n, pet, {});
    await db.updateTable('mock_collections').set({ item_count: MOCK_MAX_ITEMS - 1 }).where('tenant_id', '=', n.tenantId).where('environment_id', '=', n.environmentId).where('namespace', '=', n.name).execute();
    expect((await call(n, 'POST', '/pet', { name: 'last', photoUrls: [] })).status).toBe(200);
    const full = await call(n, 'POST', '/pet', { name: 'too many', photoUrls: [] });
    expect(full).toMatchObject({ status: 507, body: { code: 'mock_collection_full' } });
    const before = await collection(n);
    const big = await call(n, 'POST', '/pet', { name: 'x'.repeat(70_000), photoUrls: [] });
    expect(big.status).toBe(507); // full wins (checked first)
    await call(n, 'DELETE', '/pet/1');
    const tooBig = await call(n, 'POST', '/pet', { name: 'x'.repeat(70_000), photoUrls: [] });
    expect(tooBig).toMatchObject({ status: 413, body: { code: 'mock_item_too_large' } });
    const after = await collection(n);
    expect({ next_id: after.next_id, item_count: after.item_count }).toEqual({ next_id: before.next_id, item_count: before.item_count - 1 });
    expect((await call(n, 'PUT', '/pet', { id: 2, name: 'y'.repeat(70_000), photoUrls: [] })).status).toBe(413);
  });

  it('reset drops the namespace (reseeds on next use) and can change the seed', async () => {
    const n = ns('env', T1, E2);
    await call(n, 'DELETE', '/pet/1');
    expect((await call(n, 'GET', '/pet/1')).status).toBe(404);
    await store.reset(n);
    expect(await count('mock_items', n)).toBe(0);
    expect((await call(n, 'GET', '/pet/1')).status).toBe(200);
    const seeded42 = await store.list(n, pet, {});
    await store.reset(n, 7);
    const seeded7 = await store.list(n, pet, {});
    expect(seeded7).toEqual(await new MemoryMockStateStore({ seed: 7 }).list(n, pet, {}));
    expect(seeded7).not.toEqual(seeded42);
  });

  it('isolates the same namespace name across tenants and environments', async () => {
    const cells = [ns('env', T2, E1), ns('env', T2, E2), ns('isolation', T1, E1), ns('isolation', T2, E1)];
    await call(cells[0]!, 'DELETE', '/pet/5');
    await call(cells[0]!, 'PUT', '/pet', { id: 6, name: 'tenant-2 env-1', photoUrls: [] });
    await call(cells[0]!, 'POST', '/pet', { name: 'only in T2/E1', photoUrls: [] });
    for (const other of cells.slice(1)) {
      expect((await call(other, 'GET', '/pet/5')).status).toBe(200);
      expect(((await call(other, 'GET', '/pet/6')).body as { name: string }).name).not.toBe('tenant-2 env-1');
      expect((await call(other, 'GET', '/pet/21')).status).toBe(404);
    }
    await store.reset(cells[1]!);
    expect((await call(cells[0]!, 'GET', '/pet/5')).status).toBe(404);
    expect((await call(cells[0]!, 'GET', '/pet/21')).status).toBe(200);
  });

  it('GC deletes expired eval (1 h) and gen (24 h) namespaces and env namespaces idle > 30 days, in bounded batches', async () => {
    const t = newId();
    const evalNs = ns(`eval:${newId()}:gc`, t, E1);
    const genNs = ns(`gen:${newId()}:gc`, t, E1);
    const envNs = ns('env', t, E1);
    // start from an empty table: everything the earlier tests left is long expired/idle by then
    const start = now + 400 * 24 * HOUR;
    now = start;
    while ((await store.gc()).more);
    // tenant-scope: system-job
    expect(Number((await db.selectFrom('mock_namespaces').select((eb) => eb.fn.countAll().as('c')).executeTakeFirstOrThrow()).c)).toBe(0);
    for (const n of [evalNs, genNs, envNs]) {
      await store.list(n, pet, {});
      await store.list(n, model.resources['/user']!, {});
      await store.list(n, model.resources['/store/order']!, {});
    }
    const rows = async (n: MockNs) => (await count('mock_items', n)) + (await count('mock_collections', n)) + (await count('mock_namespaces', n));
    expect(await rows(evalNs)).toBe(3 * 21 + 1);

    now = start + HOUR + 1;
    // batch limit 30: one 21-row collection per call
    const first = await store.gc(30);
    expect(first).toMatchObject({ rows: 21, more: true });
    let more = true;
    while (more) more = (await store.gc(30)).more;
    expect(await rows(evalNs)).toBe(0);
    expect(await rows(genNs)).toBe(64);

    now = start + 24 * HOUR + 1;
    await store.gc();
    expect(await rows(genNs)).toBe(0);
    expect(await rows(envNs)).toBe(64);

    // use refreshes last_used_at (throttled), so an active env namespace survives
    now = start + 20 * 24 * HOUR;
    await store.list(envNs, pet, {});
    now = start + 20 * 24 * HOUR + ENV_IDLE_MS - 1;
    await store.gc();
    expect(await rows(envNs)).toBe(64);
    now += 2;
    await store.gc();
    expect(await rows(envNs)).toBe(0);
    // and it reseeds lazily
    expect(await store.list(envNs, pet, {})).toHaveLength(20);
  });

  it('slides the expiry of an eval namespace that is still in use', async () => {
    const n = ns(`eval:${newId()}:busy`);
    const start = now;
    await store.list(n, pet, {});
    now = start + 50 * 60_000;
    await store.list(n, pet, {});
    now = start + HOUR + 10 * 60_000;
    await store.gc();
    expect(await count('mock_items', n)).toBe(20);
    now = start;
  });
});
