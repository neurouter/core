/**
 * Upgrade of an existing v0.1.1 database (migrations 0001–0007, unchanged since the v0.1.1 tag) to the
 * tenancy P0/P0b schema (0008_tenant_scope, 0009_mock_state) and eval origin (0010_eval_origin). Runs on a SQLite file always, on
 * Postgres when NEUROUTER_TEST_PG_URL is set (CI), and the 0008 data migration on PGlite (PGlite has no
 * pgvector, so the full chain can't run there).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql, type Kysely } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createDatabases, migrateAll, type Databases } from '../index.js';
import { createMigrator } from '../migrator.js';
import { SettingsService } from '../../settings/settings.service.js';
import { INSTANCE_SCOPE_ID } from '../../tenancy/index.js';
import { systemClock } from '../../lib/clock.js';
import { m0008_tenant_scope } from './main/0008_tenant_scope.js';
import { pgliteKysely } from '../../../test/fakes/pglite.js';
import { resetPg } from '../../../test/fakes/server.js';
import { startServer } from '../../../server.js';

const PG = process.env.NEUROUTER_TEST_PG_URL;
const DIMS = 384;
const V011_MAIN_LAST = '0005_evals';

/** Migrates like a v0.1.1 binary: main up to 0005, audit 0006–0007. */
async function migrateLikeV011(dbs: Databases): Promise<void> {
  const ctx = { embeddingDims: DIMS };
  const main = await createMigrator(dbs.main.db as Kysely<unknown>, 'main', { ...ctx, dialect: dbs.main.dialect }).migrateTo(V011_MAIN_LAST);
  if (main.error) throw main.error;
  const audit = await createMigrator(dbs.audit.db as Kysely<unknown>, 'audit', { ...ctx, dialect: dbs.audit.dialect }).migrateToLatest();
  if (audit.error) throw audit.error;
}

const USER = '00000000-0000-7000-8000-00000000a001';
const CLIENT = '00000000-0000-7000-8000-00000000c001';

/** Rows as a v0.1.1 install has them: `tenant_id` left to the column default everywhere. */
async function seedV011(db: Kysely<any>): Promise<void> {
  const now = Date.now();
  const json = (v: unknown) => JSON.stringify(v);
  await db.insertInto('users').values({ id: USER, email: 'admin@localhost', name: 'Local admin', role: 'admin', role_source: 'bootstrap', created_at: now, updated_at: now }).execute();
  await db.insertInto('settings').values([
    { key: 'installId', value: json('install-v011'), updated_at: now },
    { key: 'codeLimitsCap', value: json({ maxToolCalls: 7, wallTimeSec: 7, cpuTimeSec: 7, maxMemoryMb: 64, maxConcurrentCalls: 1, maxResultBytes: 1000 }), updated_at: now },
    { key: 'firstAdminSignedIn', value: json(true), updated_at: now },
    { key: 'orgName', value: json('Acme'), updated_at: now },
    { key: 'evalModel', value: json('gpt-old'), updated_by: USER, updated_at: now },
  ]).execute();
  await db.insertInto('oauth_clients').values({ id: CLIENT, client_id: 'nrc_legacy', registration_type: 'preregistered', client_name: 'Legacy', redirect_uris: json(['http://127.0.0.1/cb']), grant_types: json(['authorization_code']), response_types: json(['code']), token_endpoint_auth_method: 'none', status: 'blocked', created_at: now, updated_at: now }).execute();
}

async function assertUpgraded(dbs: Databases): Promise<void> {
  const db = dbs.main.db;
  // instance keys copied to INSTANCE_SCOPE_ID; the originals stay (an older binary still reads them after a rollback)
  const rows = await db.selectFrom('settings').select(['tenant_id', 'key']).orderBy('key').orderBy('tenant_id').execute();
  const scopeOf = (k: string) => rows.filter((r) => r.key === k).map((r) => r.tenant_id).sort();
  expect(scopeOf('installId')).toEqual([INSTANCE_SCOPE_ID, DEFAULT_TENANT_ID].sort());
  expect(scopeOf('codeLimitsCap')).toEqual([INSTANCE_SCOPE_ID, DEFAULT_TENANT_ID].sort());
  expect(scopeOf('firstAdminSignedIn')).toEqual([INSTANCE_SCOPE_ID, DEFAULT_TENANT_ID].sort());
  expect(scopeOf('orgName')).toEqual([DEFAULT_TENANT_ID]);
  const settings = new SettingsService(db, systemClock);
  expect(await settings.get('installId')).toBe('install-v011');
  expect((await settings.get('codeLimitsCap')).maxToolCalls).toBe(7);
  expect(await settings.get('firstAdminSignedIn')).toBe(true);
  expect(await settings.get('orgName', DEFAULT_TENANT_ID)).toBe('Acme');
  expect(await settings.get('evalModel', DEFAULT_TENANT_ID)).toBe('gpt-old');
  // existing data untouched; new tables present and empty
  expect(await db.selectFrom('users').select(['id', 'tenant_id', 'role']).execute()).toEqual([{ id: USER, tenant_id: DEFAULT_TENANT_ID, role: 'admin' }]);
  expect((await db.selectFrom('oauth_clients').select('status').where('id', '=', CLIENT).executeTakeFirstOrThrow()).status).toBe('blocked');
  expect(await db.selectFrom('oauth_client_blocks').selectAll().execute()).toEqual([]);
  expect(await db.selectFrom('mock_namespaces').selectAll().execute()).toEqual([]);
}

describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('upgrade a v0.1.1 database (%s)', (dialect, pgUrl) => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('applies exactly 0008, 0009 and 0010, keeps data, and the new server boots on it', async () => {
    let url: string;
    if (dialect === 'postgres') url = await resetPg(pgUrl, 'nr_upgrade_v011');
    else {
      const dir = mkdtempSync(join(tmpdir(), 'nr-upgrade-'));
      dirs.push(dir);
      url = `sqlite:${join(dir, 'neurouter.db')}`;
    }
    let dbs = createDatabases({ databaseUrl: url });
    await migrateLikeV011(dbs);
    await seedV011(dbs.main.db as Kysely<any>);
    await dbs.close();

    dbs = createDatabases({ databaseUrl: url });
    expect(await migrateAll(dbs, { embeddingDims: DIMS })).toEqual({ main: ['0008_tenant_scope', '0009_mock_state', '0010_eval_origin', '0011_eval_cache_tokens', '0012_task_state', '0013_eval_limits'], audit: [] });
    expect(await migrateAll(dbs, { embeddingDims: DIMS })).toEqual({ main: [], audit: [] });
    await assertUpgraded(dbs);
    await dbs.close();

    // a v0.2 server starts on the upgraded database: same install id (audit genesis), bootstrap admin still in the default tenant
    const s = await startServer({ env: { NODE_ENV: 'test', DATABASE_URL: url, PUBLIC_URL: 'http://upgrade.test', EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'off', LOG_LEVEL: 'error', EMBEDDINGS_DIMS: String(DIMS) }, listen: false, jobs: false, loadDotenv: false, services: { defaultMetrics: false } });
    try {
      expect(await s.services.settings.get('installId')).toBe('install-v011');
      expect((await s.services.tenancy.defaultTenant())?.id).toBe(DEFAULT_TENANT_ID);
      expect(await s.services.tenancy.roleOf(DEFAULT_TENANT_ID, USER)).toBe('admin');
      const boot = await s.services.users.ensureBootstrapAdmin();
      expect(boot.id).toBe(USER);
    } finally {
      await s.close();
    }
  }, 60_000);
});

describe('0008_tenant_scope on PGlite (data migration only; no pgvector for the full chain)', () => {
  it('creates oauth_client_blocks and copies instance settings, idempotently', async () => {
    const { db, close } = await pgliteKysely<any>();
    try {
      const tenant = sql.lit(DEFAULT_TENANT_ID);
      // the v0.1.1 DDL of the two tables 0008 touches (0001_core / 0003_auth, Postgres types)
      await db.schema.createTable('settings').addColumn('tenant_id', 'uuid', (c) => c.notNull().defaultTo(tenant)).addColumn('key', 'text', (c) => c.notNull()).addColumn('value', 'jsonb', (c) => c.notNull()).addColumn('updated_by', 'uuid').addColumn('updated_at', 'bigint', (c) => c.notNull()).addPrimaryKeyConstraint('pk_settings', ['tenant_id', 'key']).execute();
      await db.schema.createTable('oauth_clients').addColumn('id', 'uuid', (c) => c.primaryKey()).execute();
      await db.insertInto('settings').values([
        { key: 'installId', value: JSON.stringify('i-pg'), updated_at: 1 },
        { key: 'dcrEnabled', value: JSON.stringify(false), updated_at: 1 },
        { key: 'orgName', value: JSON.stringify('Acme'), updated_at: 1 },
      ]).execute();
      await m0008_tenant_scope.up(db, { dialect: 'postgres', embeddingDims: DIMS });
      const rows = await db.selectFrom('settings').select(['tenant_id', 'key']).orderBy('key').orderBy('tenant_id').execute();
      expect(rows).toEqual([
        { tenant_id: INSTANCE_SCOPE_ID, key: 'dcrEnabled' },
        { tenant_id: DEFAULT_TENANT_ID, key: 'dcrEnabled' },
        { tenant_id: INSTANCE_SCOPE_ID, key: 'installId' },
        { tenant_id: DEFAULT_TENANT_ID, key: 'installId' },
        { tenant_id: DEFAULT_TENANT_ID, key: 'orgName' },
      ]);
      await db.insertInto('oauth_clients').values({ id: CLIENT }).execute();
      await db.insertInto('oauth_client_blocks').values({ tenant_id: DEFAULT_TENANT_ID, client_id: CLIENT, created_by: null, created_at: 1 }).execute();
      await expect(db.insertInto('oauth_client_blocks').values({ tenant_id: DEFAULT_TENANT_ID, client_id: CLIENT, created_by: null, created_at: 2 }).execute()).rejects.toThrow();
      // down + up again (dev rollback path)
      await m0008_tenant_scope.down(db, { dialect: 'postgres', embeddingDims: DIMS });
      expect((await db.selectFrom('settings').select('tenant_id').where('tenant_id', '=', INSTANCE_SCOPE_ID).execute()).length).toBe(0);
      await m0008_tenant_scope.up(db, { dialect: 'postgres', embeddingDims: DIMS });
      expect((await db.selectFrom('settings').select('tenant_id').where('tenant_id', '=', INSTANCE_SCOPE_ID).execute()).length).toBe(2);
    } finally {
      await close();
    }
  });
});
