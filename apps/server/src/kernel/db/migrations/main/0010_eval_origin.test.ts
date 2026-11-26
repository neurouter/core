import { afterEach, describe, expect, it } from 'vitest';
import { Kysely, PostgresDialect, sql } from 'kysely';
import { Migrator } from 'kysely/migration';
import { newId } from '../../../lib/ids.js';
import { createDatabases, type Databases } from '../../index.js';
import { StaticMigrationProvider } from '../../migrator.js';
import { MAIN_MIGRATIONS, MIGRATION_TABLES } from '../index.js';
import type { MigrationContext } from '../types.js';

/** v0.1.1 shipped main migrations 0001–0005; 0010 runs on top of a database built by them. */
const V011 = MAIN_MIGRATIONS.filter((m) => m.name <= '0005_evals');

type AnyDb = Kysely<any>;

function migrator(db: AnyDb, ctx: MigrationContext, set = MAIN_MIGRATIONS) {
  return new Migrator({ db, provider: new StaticMigrationProvider(set, ctx), migrationTableName: MIGRATION_TABLES.main.table, migrationLockTableName: MIGRATION_TABLES.main.lock });
}

async function up(db: AnyDb, ctx: MigrationContext, set = MAIN_MIGRATIONS) {
  const res = await migrator(db, ctx, set).migrateToLatest();
  if (res.error) throw res.error;
  return (res.results ?? []).map((r) => r.migrationName);
}

/** Production-shaped data: two eval runs' worth of reports (one eval-only group, one mixed group) and live traffic. */
async function seed(db: AnyDb) {
  const now = Date.UTC(2026, 10, 20);
  const id = () => newId();
  const user = id();
  const srv = id();
  const env = id();
  await db.insertInto('users').values({ id: user, email: 'admin@test.dev', created_at: now, updated_at: now }).execute();
  await db.insertInto('servers').values({ id: srv, slug: 'petstore', name: 'Petstore', kind: 'openapi', created_at: now, updated_at: now }).execute();
  await db.insertInto('environments').values({ id: env, server_id: srv, slug: 'mock', name: 'Mock', kind: 'dev', base_url: 'mock://', created_at: now, updated_at: now }).execute();
  const key = async (purpose: 'user' | 'eval') => {
    const k = id();
    await db.insertInto('api_keys').values({ id: k, key_id: k.slice(-10), secret_hash: Buffer.from('x'), display_prefix: 'nrk', name: purpose, purpose, owner_user_id: user, server_id: srv, environment_id: env, created_at: now }).execute();
    return k;
  };
  const task = async (apiKeyId: string) => {
    const t = id();
    await db.insertInto('tasks').values({ id: t, server_id: srv, environment_id: env, api_key_id: apiKeyId, principal_type: 'api_key', credential_key: apiKeyId, framing: 'explicit', status: 'closed', started_at: now, last_activity_at: now }).execute();
    return t;
  };
  const group = async (label: string, hash: string) => {
    const g = id();
    await db.insertInto('need_groups').values({ id: g, server_id: srv, label, intent_norm_hash: hash, count: 0, distinct_principals: 0, first_seen_at: now, last_seen_at: now, status: 'open' }).execute();
    return g;
  };
  const need = async (groupId: string, taskId: string | null, credentialKey: string, intent: string, at: number) =>
    db.insertInto('unmet_needs').values({ id: id(), group_id: groupId, server_id: srv, environment_id: env, task_id: taskId, credential_key: credentialKey, intent, created_at: at }).execute();
  const issue = async (taskId: string, problem: string) =>
    db.insertInto('issues').values({ id: id(), server_id: srv, environment_id: env, task_id: taskId, tool_name: 'get_pet', problem, status: 'open', created_at: now, updated_at: now }).execute();

  const live = await key('user');
  const eval1 = await key('eval');
  const eval2 = await key('eval');
  const liveTask = await task(live);
  const evalTask1 = await task(eval1);
  const evalTask2 = await task(eval2);
  // eval-only group (created by eval traffic, counts bumped by it)
  const evalOnly = await group('Delete my account', 'h-eval');
  await need(evalOnly, evalTask1, eval1, 'Delete my account', now);
  await need(evalOnly, evalTask2, eval2, 'Delete my account', now + 1);
  // an eval report with no task (matched by its eval key)
  await need(evalOnly, null, eval2, 'Delete my account', now + 2);
  // mixed group: created (and labelled) by an eval report, later joined by live reports
  const mixed = await group('Book a vet (eval)', 'h-mixed');
  await need(mixed, evalTask1, eval1, 'Book a vet (eval)', now);
  await need(mixed, liveTask, live, 'Book a vet appointment', now + 10);
  await need(mixed, liveTask, live, 'Book a vet visit', now + 20);
  await db.updateTable('need_groups').set({ count: 3, distinct_principals: 2 }).where('id', '=', mixed).execute();
  await db.updateTable('need_groups').set({ count: 3, distinct_principals: 2 }).where('id', '=', evalOnly).execute();
  // live-only group whose reports all expired under retention: untouched
  const expired = await group('Export CSV', 'h-expired');
  await db.updateTable('need_groups').set({ count: 4, distinct_principals: 1 }).where('id', '=', expired).execute();
  await issue(evalTask1, 'eval issue');
  await issue(liveTask, 'live issue');
  return { live, liveTask, evalTask1, evalTask2, evalOnly, mixed, expired, now };
}

async function verify(db: AnyDb, s: Awaited<ReturnType<typeof seed>>) {
  const tasks = await db.selectFrom('tasks').select(['id', 'origin']).execute();
  expect(Object.fromEntries(tasks.map((t: { id: string; origin: string }) => [t.id, t.origin]))).toEqual({ [s.liveTask]: 'live', [s.evalTask1]: 'eval', [s.evalTask2]: 'eval' });
  const needs = await db.selectFrom('unmet_needs').select(['intent', 'credential_key', 'group_id']).orderBy('created_at').execute();
  expect(needs).toEqual([
    { intent: 'Book a vet appointment', credential_key: s.live, group_id: s.mixed },
    { intent: 'Book a vet visit', credential_key: s.live, group_id: s.mixed },
  ]);
  expect((await db.selectFrom('issues').select('problem').execute()).map((i: { problem: string }) => i.problem)).toEqual(['live issue']);
  const groups = await db.selectFrom('need_groups').select(['id', 'label', 'count', 'distinct_principals', 'first_seen_at', 'last_seen_at']).orderBy('label').execute();
  expect(groups.map((g: Record<string, unknown>) => ({ ...g, count: Number(g.count), distinct_principals: Number(g.distinct_principals), first_seen_at: Number(g.first_seen_at), last_seen_at: Number(g.last_seen_at) }))).toEqual([
    { id: s.mixed, label: 'Book a vet appointment', count: 2, distinct_principals: 1, first_seen_at: s.now + 10, last_seen_at: s.now + 20 },
    { id: s.expired, label: 'Export CSV', count: 4, distinct_principals: 1, first_seen_at: s.now, last_seen_at: s.now },
  ]);
  // new tasks default to live; the CHECK rejects unknown origins
  await expect(db.updateTable('tasks').set({ origin: 'bogus' }).where('id', '=', s.liveTask).execute()).rejects.toThrow();
}

async function runScenario(db: AnyDb, ctx: MigrationContext) {
  expect(await up(db, ctx, V011)).toEqual(['0001_core', '0002_servers', '0003_auth', '0004_ops', '0005_evals']);
  const s = await seed(db);
  expect(await up(db, ctx)).toEqual(['0008_tenant_scope', '0009_mock_state', '0010_eval_origin']);
  await verify(db, s);
  // idempotent: re-running the body on the cleaned database changes nothing
  const m = MAIN_MIGRATIONS.find((x) => x.name === '0010_eval_origin')!;
  await m.down(db, ctx);
  await m.up(db, ctx);
  await verify(db, s);
}

describe('0010_eval_origin on a v0.1.1 database', () => {
  let dbs: Databases | undefined;
  afterEach(async () => {
    await dbs?.close();
    dbs = undefined;
  });

  it('SQLite: tags eval tasks, deletes eval reports and eval-only groups, recounts mixed groups, keeps live rows', async () => {
    dbs = createDatabases({ databaseUrl: 'sqlite::memory:' });
    await runScenario(dbs.main.db as AnyDb, { dialect: 'sqlite', embeddingDims: 384 });
  });

  it('Postgres (PGlite): same result', async () => {
    const { PGlite } = await import('@electric-sql/pglite');
    const pg = await PGlite.create();
    const db = new Kysely<unknown>({ dialect: new PostgresDialect({ pool: pgliteAsPool(pg) }) }) as AnyDb;
    try {
      await runScenario(db, { dialect: 'postgres', embeddingDims: 384 });
      const col = await sql<{ data_type: string; column_default: string }>`select data_type, column_default from information_schema.columns where table_name = 'tasks' and column_name = 'origin'`.execute(db);
      expect(col.rows[0]).toMatchObject({ data_type: 'text' });
    } finally {
      await db.destroy();
    }
  }, 60_000);

  it.skipIf(!process.env.NEUROUTER_TEST_PG_URL)('Postgres (real server, NEUROUTER_TEST_PG_URL): same result', async () => {
    const { resetPg } = await import('../../../../test/fakes/server.js');
    dbs = createDatabases({ databaseUrl: await resetPg(process.env.NEUROUTER_TEST_PG_URL!, 'nr_test_m0010') });
    await runScenario(dbs.main.db as AnyDb, { dialect: 'postgres', embeddingDims: 384 });
  }, 60_000);
});

/**
 * Minimal pg.Pool facade over PGlite for Kysely's PostgresDialect (one connection). This PGlite build
 * has no pgvector, which only the v0.1.1 base migrations need (0001 creates the extension, 0002 a
 * `vector(n)` column): those two statements are shimmed; 0010 itself runs unmodified.
 */
function pgliteAsPool(pg: { query: (q: string, p?: unknown[]) => Promise<{ rows: unknown[]; affectedRows?: number }>; close: () => Promise<void> }) {
  const shim = (q: string) => (/^create extension if not exists vector/i.test(q.trim()) ? 'select 1' : q.replace(/\bvector\(\d+\)/g, 'bytea'));
  const client = {
    query: async (q: string, params?: unknown[]) => {
      const r = await pg.query(shim(q), params ?? []);
      return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length, command: q.trim().split(/\s+/)[0]!.toUpperCase() };
    },
    release: () => {},
  };
  return { connect: async () => client, end: async () => pg.close() } as never;
}
