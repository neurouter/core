/**
 * Upgrade of an existing v0.1.1 database (migrations 0001–0007, unchanged since the v0.1.1 tag) to the
 * tenancy P0/P0b schema (0008_tenant_scope, 0009_mock_state), eval origin (0010_eval_origin) and the
 * tenancy model (0014_tenancy, 0015_audit_tenant_chains; P1), and of a 0.3.x database (everything
 * before 0014/0015, written by the app) to P1: memberships, owners, and that existing API keys, OAuth
 * tokens and `/mcp/{server}/{env}` URLs keep working. Runs on a SQLite file always, on
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
import { createMigrator, migrateDown } from '../migrator.js';
import { hmacSha256 } from '../../lib/crypto.js';
import { newId } from '../../lib/ids.js';
import { consoleOn, importPetstore } from '../../../test/fakes/app-context.js';
import { SettingsService } from '../../settings/settings.service.js';
import { INSTANCE_SCOPE_ID } from '../../tenancy/index.js';
import { systemClock } from '../../lib/clock.js';
import { m0008_tenant_scope } from './main/0008_tenant_scope.js';
import { m0014_tenancy } from './main/0014_tenancy.js';
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
  const audit = await createMigrator(dbs.audit.db as Kysely<unknown>, 'audit', { ...ctx, dialect: dbs.audit.dialect }).migrateTo('0007_metrics');
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
  // 0014: one membership per user (bootstrap → owner); the default tenant is an `org` on the `oss` plan
  expect(await db.selectFrom('memberships').select(['tenant_id', 'user_id', 'role', 'role_source', 'status']).execute()).toEqual([{ tenant_id: DEFAULT_TENANT_ID, user_id: USER, role: 'owner', role_source: 'bootstrap', status: 'active' }]);
  expect(await db.selectFrom('tenants').select(['slug', 'kind', 'status', 'plan']).execute()).toEqual([{ slug: 'default', kind: 'org', status: 'active', plan: 'oss' }]);
  // 0015: the (empty) legacy audit chain is closed at seq 0
  expect(await dbs.audit.db.selectFrom('audit_chain_heads').select(['tenant_id', 'seq']).execute()).toEqual([{ tenant_id: '00000000-0000-0000-0000-000000000000', seq: 0 }]);
}

describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('upgrade a v0.1.1 database (%s)', (dialect, pgUrl) => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('applies every migration since v0.1.1, keeps data, and the new server boots on it', async () => {
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
    expect(await migrateAll(dbs, { embeddingDims: DIMS })).toEqual({ main: ['0008_tenant_scope', '0009_mock_state', '0010_eval_origin', '0011_eval_cache_tokens', '0012_task_state', '0013_eval_limits', '0014_tenancy'], audit: ['0015_audit_tenant_chains'] });
    expect(await migrateAll(dbs, { embeddingDims: DIMS })).toEqual({ main: [], audit: [] });
    await assertUpgraded(dbs);
    await dbs.close();

    // a v0.2 server starts on the upgraded database: same install id (audit genesis), bootstrap admin still in the default tenant
    const s = await startServer({ env: { NODE_ENV: 'test', DATABASE_URL: url, PUBLIC_URL: 'http://upgrade.test', EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'off', LOG_LEVEL: 'error', EMBEDDINGS_DIMS: String(DIMS) }, listen: false, jobs: false, loadDotenv: false, services: { defaultMetrics: false } });
    try {
      expect(await s.services.settings.get('installId')).toBe('install-v011');
      expect((await s.services.tenancy.defaultTenant())?.id).toBe(DEFAULT_TENANT_ID);
      // 0014: the bootstrap admin owns the default tenant
      expect(await s.services.tenancy.roleOf(DEFAULT_TENANT_ID, USER)).toBe('owner');
      const boot = await s.services.users.ensureBootstrapAdmin();
      expect(boot.id).toBe(USER);
    } finally {
      await s.close();
    }
  }, 60_000);
});

/** A stateless MCP `tools/list` through the HTTP route (no listener needed). */
async function toolsList(s: Awaited<ReturnType<typeof startServer>>, path: string, token: string) {
  const r = await s.app.inject({ method: 'POST', url: path, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' } });
  return { status: r.statusCode, hasTools: r.body.includes('"tools"') };
}

describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('upgrade a 0.3.x database to the tenancy model (%s)', (dialect, pgUrl) => {
  const dirs: string[] = [];
  afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
  });

  it('keeps API keys, OAuth tokens and /mcp/{server}/{env}; every user gets a membership and the tenant an owner', async () => {
    let url: string;
    if (dialect === 'postgres') url = await resetPg(pgUrl, 'nr_upgrade_p1');
    else {
      const dir = mkdtempSync(join(tmpdir(), 'nr-upgrade-p1-'));
      dirs.push(dir);
      url = `sqlite:${join(dir, 'neurouter.db')}`;
    }
    const env = { NODE_ENV: 'test', DATABASE_URL: url, PUBLIC_URL: 'http://upgrade.test', EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'off', LOG_LEVEL: 'error', EMBEDDINGS_DIMS: String(DIMS), HASH_PEPPER: 'u'.repeat(40), NEUROUTER_LOCAL_LINK: 'false' } as const;
    const boot = () => startServer({ env, listen: false, jobs: false, loadDotenv: false, services: { defaultMetrics: false } });

    // 1. a running install with an operator, a viewer, a server, an API key and an OAuth token
    let s = await boot();
    const t = await consoleOn(s);
    const viewer = await t.user('viewer@upgrade.test', 'viewer');
    const server = await importPetstore(t);
    const db0 = s.services.dbs.main.db;
    const mock = await db0.selectFrom('environments').select(['id', 'tenant_id']).where('server_id', '=', server.id).where('slug', '=', 'mock').executeTakeFirstOrThrow();
    const key = await t.json(t.admin, { method: 'POST', url: '/api/keys', payload: { name: 'ci', serverId: server.id, environmentId: mock.id, scopes: ['tools:read'] } }, 201);
    const now = Date.now();
    const clientId = newId();
    await db0.insertInto('oauth_clients').values({ id: clientId, client_id: 'nrc_upgrade', registration_type: 'preregistered', client_name: 'Upgrade client', redirect_uris: '["http://127.0.0.1/cb"]', grant_types: '["authorization_code"]', response_types: '["code"]', token_endpoint_auth_method: 'none', status: 'active', created_at: now, updated_at: now }).execute();
    const access = `nrk_at_${'a'.repeat(43)}`;
    await db0.insertInto('oauth_tokens').values({ id: newId(), tenant_id: mock.tenant_id, token_hash: hmacSha256(env.HASH_PEPPER, access), kind: 'access', client_id: clientId, user_id: viewer.id, server_id: server.id, environment_id: mock.id, scopes: 'mcp:tools', resource: 'http://upgrade.test/mcp/petstore/mock', family_id: newId(), expires_at: now + 3_600_000, created_at: now }).execute();
    expect(await toolsList(s, '/mcp/petstore/mock', key.token)).toEqual({ status: 200, hasTools: true });
    expect(await toolsList(s, '/mcp/petstore/mock', access)).toEqual({ status: 200, hasTools: true });
    await t.close();

    // 2. back to the 0.3.x schema: roll back 0014/0015 (the audit rows are dropped: they were chained per tenant already)
    const dbs = createDatabases({ databaseUrl: url });
    await dbs.audit.db.deleteFrom('audit_log').execute();
    await dbs.audit.db.deleteFrom('audit_checkpoints').execute();
    expect(await migrateDown(dbs.audit.db as Kysely<unknown>, 'audit', { embeddingDims: DIMS, dialect: dbs.audit.dialect })).toEqual(['0015_audit_tenant_chains']);
    expect(await migrateDown(dbs.main.db as Kysely<unknown>, 'main', { embeddingDims: DIMS, dialect: dbs.main.dialect })).toEqual(['0014_tenancy']);
    const users = await dbs.main.db.selectFrom('users').select(['email', 'role', 'role_source']).orderBy('email').execute();
    expect(users).toEqual([
      { email: 'admin@localhost', role: 'admin', role_source: 'bootstrap' },
      { email: 'admin@test.dev', role: 'admin', role_source: 'local' },
      { email: 'viewer@upgrade.test', role: 'viewer', role_source: 'local' },
    ]);
    await dbs.close();

    // 3. the P1 server on the 0.3.x database
    s = await boot();
    try {
      const db = s.services.dbs.main.db;
      const ms = await db.selectFrom('memberships as m').innerJoin('users as u', 'u.id', 'm.user_id').select(['u.email', 'm.role', 'm.tenant_id']).orderBy('u.email').execute();
      // the bootstrap admin becomes the owner; other users keep their role (spec §2.2)
      expect(ms).toEqual([
        { email: 'admin@localhost', role: 'owner', tenant_id: DEFAULT_TENANT_ID },
        { email: 'admin@test.dev', role: 'admin', tenant_id: DEFAULT_TENANT_ID },
        { email: 'viewer@upgrade.test', role: 'viewer', tenant_id: DEFAULT_TENANT_ID },
      ]);
      expect(await toolsList(s, '/mcp/petstore/mock', key.token)).toEqual({ status: 200, hasTools: true });
      expect(await toolsList(s, '/mcp/petstore/mock', access)).toEqual({ status: 200, hasTools: true });
      // the 3-segment route exists only on a multi-tenant deployment
      expect((await toolsList(s, '/mcp/default/petstore/mock', key.token)).status).toBe(404);
      // the console works for both users, with their membership roles
      const t2 = await consoleOn(s);
      const me = await t2.json(t2.admin, { url: '/api/me' }, 200);
      expect(me.user.role).toBe('admin');
      expect(me.tenant).toMatchObject({ id: DEFAULT_TENANT_ID, role: 'admin' });
      expect((await t2.json(t2.admin, { url: '/api/members' }, 200)).items.map((m: { email: string; role: string }) => `${m.email}:${m.role}`)).toEqual(['admin@localhost:owner', 'admin@test.dev:admin', 'viewer@upgrade.test:viewer']);
      // an admin can't manage members (owner-only), but can invite
      expect((await t2.as(t2.admin, { method: 'PATCH', url: `/api/members/${viewer.id}`, payload: { role: 'admin' } })).statusCode).toBe(403);
      expect((await t2.as(t2.admin, { method: 'POST', url: '/api/members/invites', payload: { email: 'new@upgrade.test', role: 'viewer' } })).statusCode).toBe(201);
      // a fresh audit row chains per tenant after the upgrade
      await s.services.auditStore.flush();
      expect(await s.services.auditStore.verify(DEFAULT_TENANT_ID, {}, { includeLegacy: true })).toMatchObject({ ok: true });
    } finally {
      await s.close();
    }
  }, 90_000);
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

describe('0014_tenancy on PGlite (Postgres DDL and data migration; no pgvector for the full chain)', () => {
  it('drops tenant_id defaults, makes emails global, one active DEK per tenant, and builds memberships and identities', async () => {
    const { db, close } = await pgliteKysely<any>();
    try {
      const tenant = sql.lit(DEFAULT_TENANT_ID);
      const B = '00000000-0000-7000-8000-0000000000b2';
      // the 0.3.x DDL of the tables 0014 touches (0001_core, Postgres types), plus one tenant table with a default
      await db.schema.createTable('tenants').addColumn('id', 'uuid', (c) => c.primaryKey()).addColumn('slug', 'text', (c) => c.notNull()).addColumn('name', 'text', (c) => c.notNull()).addColumn('created_at', 'bigint', (c) => c.notNull()).addUniqueConstraint('uq_tenants_slug', ['slug']).execute();
      await db.schema
        .createTable('users')
        .addColumn('id', 'uuid', (c) => c.primaryKey())
        .addColumn('tenant_id', 'uuid', (c) => c.notNull().defaultTo(tenant).references('tenants.id'))
        .addColumn('email', 'text', (c) => c.notNull())
        .addColumn('name', 'text', (c) => c.notNull().defaultTo(''))
        .addColumn('oidc_issuer', 'text')
        .addColumn('oidc_subject', 'text')
        .addColumn('role', 'text', (c) => c.notNull().defaultTo('viewer'))
        .addColumn('role_source', 'text', (c) => c.notNull().defaultTo('local'))
        .addColumn('status', 'text', (c) => c.notNull().defaultTo('active'))
        .addColumn('last_login_at', 'bigint')
        .addColumn('created_at', 'bigint', (c) => c.notNull())
        .addColumn('updated_at', 'bigint', (c) => c.notNull())
        .addUniqueConstraint('uq_users_email', ['tenant_id', 'email'])
        .execute();
      await db.schema.createTable('web_sessions').addColumn('id_hash', 'bytea', (c) => c.primaryKey()).addColumn('tenant_id', 'uuid', (c) => c.notNull().defaultTo(tenant)).execute();
      await db.schema.createTable('encryption_keys').addColumn('id', 'uuid', (c) => c.primaryKey()).addColumn('tenant_id', 'uuid', (c) => c.notNull().defaultTo(tenant)).addColumn('status', 'text', (c) => c.notNull()).execute();
      await db.schema.createTable('servers').addColumn('id', 'uuid', (c) => c.primaryKey()).addColumn('tenant_id', 'uuid', (c) => c.notNull().defaultTo(tenant)).execute();
      await db.insertInto('tenants').values([{ id: DEFAULT_TENANT_ID, slug: 'default', name: 'Default', created_at: 1 }, { id: B, slug: 'beta', name: 'Beta', created_at: 2 }]).execute();
      await db.insertInto('users').values([
        { id: USER, email: 'boot@x.test', role: 'admin', role_source: 'bootstrap', created_at: 1, updated_at: 1 },
        { id: '00000000-0000-7000-8000-00000000a002', email: 'g@x.test', oidc_issuer: 'https://accounts.google.com', oidc_subject: 'g-1', role: 'viewer', role_source: 'oidc', created_at: 2, updated_at: 2 },
        { id: '00000000-0000-7000-8000-00000000a003', tenant_id: B, email: 'b@x.test', oidc_issuer: 'https://idp.beta.test', oidc_subject: 'b-1', role: 'admin', role_source: 'oidc', created_at: 3, updated_at: 3 },
      ]).execute();
      await db.insertInto('encryption_keys').values({ id: newId(), status: 'active' }).execute();

      await m0014_tenancy.up(db, { dialect: 'postgres', embeddingDims: DIMS });

      const defaults = await sql<{ table_name: string; column_default: string | null }>`select table_name, column_default from information_schema.columns where column_name = 'tenant_id' and table_schema = current_schema() order by table_name`.execute(db);
      const def = Object.fromEntries(defaults.rows.map((r) => [r.table_name, r.column_default !== null]));
      expect(def).toMatchObject({ users: false, encryption_keys: false, servers: false, web_sessions: true, memberships: false, invites: false });
      // emails are unique across tenants now
      await expect(db.insertInto('users').values({ id: newId(), tenant_id: B, email: 'boot@x.test', created_at: 4, updated_at: 4 }).execute()).rejects.toThrow();
      // one active DEK per tenant
      await expect(db.insertInto('encryption_keys').values({ id: newId(), tenant_id: DEFAULT_TENANT_ID, status: 'active' }).execute()).rejects.toThrow();
      await db.insertInto('encryption_keys').values({ id: newId(), tenant_id: B, status: 'active' }).execute();
      // the bootstrap admin owns the default tenant; a tenant without one promotes its oldest active admin
      expect(await db.selectFrom('memberships').select(['tenant_id', 'user_id', 'role', 'role_source']).orderBy('created_at').execute()).toEqual([
        { tenant_id: DEFAULT_TENANT_ID, user_id: USER, role: 'owner', role_source: 'bootstrap' },
        { tenant_id: DEFAULT_TENANT_ID, user_id: '00000000-0000-7000-8000-00000000a002', role: 'viewer', role_source: 'oidc' },
        { tenant_id: B, user_id: '00000000-0000-7000-8000-00000000a003', role: 'owner', role_source: 'oidc' },
      ]);
      expect(await db.selectFrom('user_identities').select(['user_id', 'provider', 'subject', 'email_verified']).orderBy('subject').execute()).toEqual([
        { user_id: '00000000-0000-7000-8000-00000000a003', provider: `oidc:${B}`, subject: 'b-1', email_verified: 1 },
        { user_id: '00000000-0000-7000-8000-00000000a002', provider: 'google', subject: 'g-1', email_verified: 1 },
      ]);
      expect(await db.selectFrom('tenants').select(['slug', 'kind', 'status', 'plan']).orderBy('slug').execute()).toEqual([
        { slug: 'beta', kind: 'org', status: 'active', plan: 'oss' },
        { slug: 'default', kind: 'org', status: 'active', plan: 'oss' },
      ]);
      // dev rollback path: down + up again
      await db.deleteFrom('encryption_keys').where('tenant_id', '=', B).execute();
      await m0014_tenancy.down(db, { dialect: 'postgres', embeddingDims: DIMS });
      await m0014_tenancy.up(db, { dialect: 'postgres', embeddingDims: DIMS });
      expect((await db.selectFrom('memberships').select('user_id').execute()).length).toBe(3);
    } finally {
      await close();
    }
  });
});
