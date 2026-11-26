import { sql, type Kysely } from 'kysely';
import { collectionFull, collectionKeyOf, collectionSeed, DEFAULT_SEED, itemJson, MOCK_MAX_ITEMS, SEED_ITEMS, seedItems, type MockNs, type MockResource, type MockScope, type MockStateStore } from '@neurouter/compiler';
import type { MainDB } from '../../kernel/db/schema.js';
import { parseJsonColumn } from '../../kernel/lib/json.js';

type Obj = Record<string, unknown>;
type NsKind = 'env' | 'eval' | 'gen';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Eval attempt namespaces live 1 h after their last use, generation/preview ones 24 h (spec §7.4). */
const TTL: Record<NsKind, number | null> = { env: null, eval: HOUR, gen: DAY };
/** Environment namespaces idle longer than this are collected (they reseed lazily on next use). */
export const ENV_IDLE_MS = 30 * DAY;
/** `last_used_at` / `expires_at` are refreshed at most this often per collection (saves a write per read). */
const TOUCH_MS = 5 * 60_000;

export function namespaceKind(name: string): NsKind {
  return name === 'env' ? 'env' : name.startsWith('eval:') ? 'eval' : 'gen';
}

class NotFound extends Error {}

/**
 * Mock state in the database (multi-tenancy spec §7): every instance sees the same mock world and
 * a reset is visible everywhere. SQLite and Postgres. Every statement carries `tenant_id` (set on
 * insert, filtered on select/update/delete); write transactions start with a write so SQLite takes
 * its write lock up front (busy_timeout applies) and Postgres row locks serialize id allocation.
 */
export class DbMockStateStore implements MockStateStore {
  readonly seed: number;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: () => number,
    opts: { seed?: number } = {},
  ) {
    this.seed = opts.seed ?? DEFAULT_SEED;
  }

  now(): number {
    return this.clock();
  }

  /** The collection's key, seeding it (namespace row + 20 items) on first use. */
  private async ensure(ns: MockNs, r: MockResource, scope: MockScope): Promise<string> {
    const key = collectionKeyOf(r, scope);
    const row = await this.db
      .selectFrom('mock_collections')
      .select('last_used_at')
      .where('tenant_id', '=', ns.tenantId)
      .where('environment_id', '=', ns.environmentId)
      .where('namespace', '=', ns.name)
      .where('collection_key', '=', key)
      .executeTakeFirst();
    const now = this.clock();
    if (row) {
      if (now - row.last_used_at > TOUCH_MS) await this.touch(ns, key, now);
      return key;
    }
    const kind = namespaceKind(ns.name);
    const ttl = TTL[kind];
    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('mock_namespaces')
        .values({ tenant_id: ns.tenantId, environment_id: ns.environmentId, namespace: ns.name, seed: this.seed, kind, created_at: now, last_used_at: now, expires_at: ttl === null ? null : now + ttl })
        .onConflict((oc) => oc.columns(['tenant_id', 'environment_id', 'namespace']).doNothing())
        .execute();
      const nsRow = await trx.selectFrom('mock_namespaces').select('seed').where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).executeTakeFirstOrThrow();
      const items = seedItems(r, scope, Number(nsRow.seed)).map((it) => ({ it, ...itemJson(r, it) }));
      // only the inserter seeds; a concurrent first reader waits on the PK (PG) or the writer lock (SQLite)
      const inserted = await trx
        .insertInto('mock_collections')
        .values({
          tenant_id: ns.tenantId,
          environment_id: ns.environmentId,
          namespace: ns.name,
          collection_key: key,
          seed: collectionSeed(r, Number(nsRow.seed)),
          next_id: SEED_ITEMS + 1,
          item_count: items.length,
          bytes: items.reduce((n, x) => n + x.bytes, 0),
          created_at: now,
          last_used_at: now,
        })
        .onConflict((oc) => oc.columns(['tenant_id', 'environment_id', 'namespace', 'collection_key']).doNothing())
        .returning('collection_key')
        .executeTakeFirst();
      if (!inserted || !items.length) return;
      await trx
        .insertInto('mock_items')
        .values(items.map((x, i) => ({ tenant_id: ns.tenantId, environment_id: ns.environmentId, namespace: ns.name, collection_key: key, item_id: String(x.it[r.idField]), ord: i + 1, body: x.json, bytes: x.bytes, updated_at: now })))
        .execute();
    });
    return key;
  }

  /** Marks the collection and its namespace used (env GC) and slides an eval/gen namespace's expiry. */
  private async touch(ns: MockNs, key: string, now: number): Promise<void> {
    const ttl = TTL[namespaceKind(ns.name)];
    await this.db.updateTable('mock_collections').set({ last_used_at: now }).where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).where('collection_key', '=', key).execute();
    await this.db
      .updateTable('mock_namespaces')
      .set({ last_used_at: now, ...(ttl === null ? {} : { expires_at: now + ttl }) })
      .where('tenant_id', '=', ns.tenantId)
      .where('environment_id', '=', ns.environmentId)
      .where('namespace', '=', ns.name)
      .execute();
  }

  async list(ns: MockNs, r: MockResource, scope: MockScope): Promise<Obj[]> {
    const key = await this.ensure(ns, r, scope);
    const rows = await this.db
      .selectFrom('mock_items')
      .select('body')
      .where('tenant_id', '=', ns.tenantId)
      .where('environment_id', '=', ns.environmentId)
      .where('namespace', '=', ns.name)
      .where('collection_key', '=', key)
      .orderBy('ord')
      .execute();
    return rows.map((x) => parseJsonColumn<Obj>(x.body)!);
  }

  async get(ns: MockNs, r: MockResource, scope: MockScope, id: string): Promise<Obj | null> {
    const key = await this.ensure(ns, r, scope);
    const row = await this.db
      .selectFrom('mock_items')
      .select('body')
      .where('tenant_id', '=', ns.tenantId)
      .where('environment_id', '=', ns.environmentId)
      .where('namespace', '=', ns.name)
      .where('collection_key', '=', key)
      .where('item_id', '=', id)
      .executeTakeFirst();
    return row ? parseJsonColumn<Obj>(row.body) : null;
  }

  async create(ns: MockNs, r: MockResource, scope: MockScope, make: (id: number) => Obj): Promise<Obj> {
    for (let attempt = 0; ; attempt++) {
      const key = await this.ensure(ns, r, scope);
      try {
        return await this.db.transaction().execute(async (trx) => {
          const now = this.clock();
          // the row lock (PG) / write lock (SQLite) serializes id allocation per collection
          const got = await trx
            .updateTable('mock_collections')
            .set({ next_id: sql`next_id + 1`, item_count: sql`item_count + 1`, last_used_at: now })
            .where('tenant_id', '=', ns.tenantId)
            .where('environment_id', '=', ns.environmentId)
            .where('namespace', '=', ns.name)
            .where('collection_key', '=', key)
            .where('item_count', '<', MOCK_MAX_ITEMS)
            .returning('next_id')
            .executeTakeFirst();
          if (!got) {
            const exists = await trx.selectFrom('mock_collections').select('item_count').where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).where('collection_key', '=', key).executeTakeFirst();
            if (exists) throw collectionFull(r);
            throw new NotFound(); // reset in between: reseed and retry
          }
          const id = Number(got.next_id) - 1;
          const item = make(id);
          const { json, bytes } = itemJson(r, item);
          await trx.insertInto('mock_items').values({ tenant_id: ns.tenantId, environment_id: ns.environmentId, namespace: ns.name, collection_key: key, item_id: String(item[r.idField]), ord: id, body: json, bytes, updated_at: now }).execute();
          await trx.updateTable('mock_collections').set({ bytes: sql`bytes + ${bytes}` }).where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).where('collection_key', '=', key).execute();
          return item;
        });
      } catch (err) {
        if (!(err instanceof NotFound) || attempt >= 2) throw err;
      }
    }
  }

  async put(ns: MockNs, r: MockResource, scope: MockScope, id: string, next: Obj): Promise<boolean> {
    const key = await this.ensure(ns, r, scope);
    const { json, bytes } = itemJson(r, next);
    try {
      await this.db.transaction().execute(async (trx) => {
        const now = this.clock();
        await trx
          .updateTable('mock_collections')
          .set({
            bytes: sql`bytes + ${bytes} - coalesce((select i.bytes from mock_items i where i.tenant_id = ${ns.tenantId} and i.environment_id = ${ns.environmentId} and i.namespace = ${ns.name} and i.collection_key = ${key} and i.item_id = ${id}), ${bytes})`,
            last_used_at: now,
          })
          .where('tenant_id', '=', ns.tenantId)
          .where('environment_id', '=', ns.environmentId)
          .where('namespace', '=', ns.name)
          .where('collection_key', '=', key)
          .execute();
        const res = await trx
          .updateTable('mock_items')
          .set({ body: json, bytes, updated_at: now })
          .where('tenant_id', '=', ns.tenantId)
          .where('environment_id', '=', ns.environmentId)
          .where('namespace', '=', ns.name)
          .where('collection_key', '=', key)
          .where('item_id', '=', id)
          .executeTakeFirst();
        if (Number(res.numUpdatedRows) === 0) throw new NotFound();
      });
      return true;
    } catch (err) {
      if (err instanceof NotFound) return false;
      throw err;
    }
  }

  async remove(ns: MockNs, r: MockResource, scope: MockScope, id: string): Promise<boolean> {
    const key = await this.ensure(ns, r, scope);
    return this.db.transaction().execute(async (trx) => {
      const gone = await trx
        .deleteFrom('mock_items')
        .where('tenant_id', '=', ns.tenantId)
        .where('environment_id', '=', ns.environmentId)
        .where('namespace', '=', ns.name)
        .where('collection_key', '=', key)
        .where('item_id', '=', id)
        .returning('bytes')
        .executeTakeFirst();
      if (!gone) return false;
      await trx
        .updateTable('mock_collections')
        .set({ item_count: sql`item_count - 1`, bytes: sql`bytes - ${gone.bytes}`, last_used_at: this.clock() })
        .where('tenant_id', '=', ns.tenantId)
        .where('environment_id', '=', ns.environmentId)
        .where('namespace', '=', ns.name)
        .where('collection_key', '=', key)
        .execute();
      return true;
    });
  }

  /** The namespace's seed: the one it was reset with, else the store seed. */
  async seedOf(ns: MockNs): Promise<number> {
    const row = await this.db.selectFrom('mock_namespaces').select('seed').where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).executeTakeFirst();
    return row ? Number(row.seed) : this.seed;
  }

  async reset(ns: MockNs, seed?: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('mock_items').where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).execute();
      await trx.deleteFrom('mock_collections').where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).execute();
      await trx.deleteFrom('mock_namespaces').where('tenant_id', '=', ns.tenantId).where('environment_id', '=', ns.environmentId).where('namespace', '=', ns.name).execute();
      if (seed === undefined) return;
      const now = this.clock();
      const kind = namespaceKind(ns.name);
      const ttl = TTL[kind];
      await trx.insertInto('mock_namespaces').values({ tenant_id: ns.tenantId, environment_id: ns.environmentId, namespace: ns.name, seed, kind, created_at: now, last_used_at: now, expires_at: ttl === null ? null : now + ttl }).execute();
    });
  }

  /**
   * GC (`mock.gc` job): deletes expired eval/gen namespaces and environment namespaces idle for
   * `ENV_IDLE_MS`, children first, stopping before a batch exceeds `maxRows` deleted rows (one
   * collection is ≤ 1,001 rows). `more`: call again, the batch stopped early.
   */
  async gc(maxRows = 5000): Promise<{ namespaces: number; rows: number; more: boolean }> {
    const now = this.clock();
    // tenant-scope: system-job
    const expired = await this.db
      .selectFrom('mock_namespaces')
      .select(['tenant_id', 'environment_id', 'namespace'])
      .where((eb) => eb.or([eb('expires_at', '<=', now), eb.and([eb('kind', '=', 'env'), eb('last_used_at', '<', now - ENV_IDLE_MS)])]))
      .limit(200)
      .execute();
    let rows = 0;
    let namespaces = 0;
    for (const ns of expired) {
      const colls = await this.db
        .selectFrom('mock_collections')
        .select(['collection_key', 'item_count'])
        .where('tenant_id', '=', ns.tenant_id)
        .where('environment_id', '=', ns.environment_id)
        .where('namespace', '=', ns.namespace)
        .execute();
      for (const c of colls) {
        if (rows > 0 && rows + c.item_count + 1 > maxRows) return { namespaces, rows, more: true };
        await this.db.transaction().execute(async (trx) => {
          const items = await trx.deleteFrom('mock_items').where('tenant_id', '=', ns.tenant_id).where('environment_id', '=', ns.environment_id).where('namespace', '=', ns.namespace).where('collection_key', '=', c.collection_key).executeTakeFirst();
          await trx.deleteFrom('mock_collections').where('tenant_id', '=', ns.tenant_id).where('environment_id', '=', ns.environment_id).where('namespace', '=', ns.namespace).where('collection_key', '=', c.collection_key).execute();
          rows += Number(items.numDeletedRows) + 1;
        });
      }
      if (rows >= maxRows) return { namespaces, rows, more: true };
      await this.db.deleteFrom('mock_namespaces').where('tenant_id', '=', ns.tenant_id).where('environment_id', '=', ns.environment_id).where('namespace', '=', ns.namespace).execute();
      rows += 1;
      namespaces += 1;
    }
    return { namespaces, rows, more: expired.length === 200 };
  }
}
