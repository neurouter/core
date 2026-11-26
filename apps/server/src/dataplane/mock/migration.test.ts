import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sql, type Kysely } from 'kysely';
import { Migrator } from 'kysely/migration';
import { MemoryMockStateStore, type MockResource } from '@neurouter/compiler';
import { DbMockStateStore } from './db-store.js';
import { createDatabases, migrateAll, type Databases } from '../../kernel/db/index.js';
import { StaticMigrationProvider } from '../../kernel/db/migrator.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { pgliteKysely } from '../../test/fakes/pglite.js';
import { AUDIT_MIGRATIONS, MAIN_MIGRATIONS, MIGRATION_TABLES } from '../../kernel/db/migrations/index.js';
import { m0009_mock_state } from '../../kernel/db/migrations/main/0009_mock_state.js';

const DIMS = 384;
const PET: MockResource = { key: '/pet', name: 'pet', idField: 'id', idType: 'integer', scopeParams: [], defaultScope: {}, itemSchema: { type: 'object', properties: { id: { type: 'integer' }, name: { type: 'string' } } } };
const V011_MAIN = ['0001_core', '0002_servers', '0003_auth', '0004_ops', '0005_evals'];

/** Migrates like v0.1.1 did: main 0001–0005, audit 0006–0007. */
async function migrateV011(dbs: Databases): Promise<void> {
  const ctx = { dialect: dbs.main.dialect, embeddingDims: DIMS };
  const sets = [
    { db: dbs.main.db, list: MAIN_MIGRATIONS.filter((m) => V011_MAIN.includes(m.name)), t: MIGRATION_TABLES.main },
    { db: dbs.audit.db, list: AUDIT_MIGRATIONS, t: MIGRATION_TABLES.audit },
  ];
  for (const s of sets) {
    const res = await new Migrator({ db: s.db as Kysely<unknown>, provider: new StaticMigrationProvider(s.list, ctx), migrationTableName: s.t.table, migrationLockTableName: s.t.lock }).migrateToLatest();
    if (res.error) throw res.error;
  }
}

describe('migration 0009_mock_state', () => {
  let dir: string | null = null;
  let dbs: Databases | null = null;
  afterEach(async () => {
    await dbs?.close();
    dbs = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('upgrades a v0.1.1 SQLite database (0001–0007 with data) to latest', async () => {
    dir = mkdtempSync(join(tmpdir(), 'nr-mig-0009-'));
    const url = `sqlite:${join(dir, 'neurouter.db')}`;
    dbs = createDatabases({ databaseUrl: url });
    await migrateV011(dbs);
    const now = Date.now();
    await dbs.main.db.insertInto('users').values({ id: 'u1', email: 'admin@example.com', role: 'admin', created_at: now, updated_at: now }).execute();
    await dbs.close();

    // a later release opens the same file and migrates to latest
    dbs = createDatabases({ databaseUrl: url });
    expect(await migrateAll(dbs, { embeddingDims: DIMS })).toEqual({ main: ['0009_mock_state'], audit: [] });
    expect(await dbs.main.db.selectFrom('users').select(['id', 'email', 'role']).execute()).toEqual([{ id: 'u1', email: 'admin@example.com', role: 'admin' }]);
    const ns = { tenantId: '00000000-0000-7000-8000-0000000000a1', environmentId: '00000000-0000-7000-8000-0000000000e1', name: 'env' };
    const store = new DbMockStateStore(dbs.main.db, () => now);
    expect(await store.list(ns, PET, {})).toEqual(await new MemoryMockStateStore().list(ns, PET, {}));
    expect(await migrateAll(dbs, { embeddingDims: DIMS })).toEqual({ main: [], audit: [] });
  });

  it('applies, rolls back and re-applies on Postgres (PGlite; the full chain needs pgvector, which PGlite lacks)', async () => {
    const pg = await pgliteKysely<MainDB>();
    try {
      const ctx = { dialect: 'postgres' as const, embeddingDims: DIMS };
      await sql`create table users (id uuid primary key, email text not null)`.execute(pg.db);
      await sql`insert into users values ('00000000-0000-7000-8000-000000000001', 'a@example.com')`.execute(pg.db);
      await m0009_mock_state.up(pg.db, ctx);
      const tables = async () => (await sql<{ t: string }>`select table_name as t from information_schema.tables where table_schema = 'public' order by 1`.execute(pg.db)).rows.map((r) => r.t);
      expect(await tables()).toEqual(['mock_collections', 'mock_items', 'mock_namespaces', 'users']);
      const cols = (await sql<{ c: string; d: string }>`select column_name as c, data_type as d from information_schema.columns where table_name = 'mock_items' order by ordinal_position`.execute(pg.db)).rows;
      expect(Object.fromEntries(cols.map((x) => [x.c, x.d]))).toMatchObject({ tenant_id: 'uuid', environment_id: 'uuid', ord: 'bigint', body: 'text', updated_at: 'bigint' });
      // tenant_id has no default: an insert without it fails
      await expect(sql`insert into mock_namespaces (environment_id, namespace, seed, kind, created_at, last_used_at) values ('00000000-0000-7000-8000-000000000002', 'env', 1, 'env', 1, 1)`.execute(pg.db)).rejects.toThrow(/tenant_id/);
      await expect(sql`insert into mock_namespaces values ('00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', ${'x'.repeat(221)}, 1, 'env', 1, 1, null)`.execute(pg.db)).rejects.toThrow(/check/i);
      await m0009_mock_state.down(pg.db, ctx);
      expect(await tables()).toEqual(['users']);
      await m0009_mock_state.up(pg.db, ctx);
      const store = new DbMockStateStore(pg.db, () => 1);
      expect(await store.list({ tenantId: '00000000-0000-7000-8000-000000000001', environmentId: '00000000-0000-7000-8000-000000000002', name: 'env' }, PET, {})).toHaveLength(20);
    } finally {
      await pg.close();
    }
  });
});
