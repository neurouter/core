import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { columnTypes, inList, isBool } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/**
 * Tenant tables whose `tenant_id` keeps its column default on Postgres: global rows whose inserts
 * don't name a tenant (kernel/db/tenant-scope.ts `TENANT_ID_OPTIONAL_TABLES`, frozen here).
 */
const KEEP_DEFAULT = ['web_sessions', 'oidc_login_states', 'local_links', 'oauth_clients', 'redaction_rules'];

const GOOGLE_ISSUER = 'https://accounts.google.com';

/**
 * The tenancy model (multi-tenancy spec §2.2, named `0008_tenancy` there; P1). Additive for a
 * single-tenant database, and a 0.3.x binary keeps working after a rollback: `users.tenant_id`,
 * `users.role` and `users.role_source` stay and are still written (home tenant and home role).
 *
 * - `tenants`: `kind`, `status`, `plan`, `created_by`, `deletion_requested_at`, `deleted_at`, `updated_at`.
 * - New: `tenant_slug_aliases`, `user_identities`, `memberships`, `invites`.
 * - `users.email` becomes unique across tenants; `users.avatar_url`.
 * - `web_sessions.active_tenant_id`, `web_sessions.impersonation_id`.
 * - `encryption_keys`: at most one active DEK per tenant (per-tenant DEKs, §4.4).
 * - Postgres: `tenant_id` column defaults are dropped (inserts name the tenant, §4.2 step 1),
 *   except on the global tables listed in `KEEP_DEFAULT`. SQLite keeps them (no table rebuild).
 *
 * Data: one membership per user (the bootstrap admin becomes `owner`; a tenant left without an
 * owner promotes its oldest active admin), one identity per OIDC-linked user.
 */
export const m0014_tenancy: DialectMigration = {
  name: '0014_tenancy',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';

    await db.schema.alterTable('tenants').addColumn('kind', T.text, (c) => c.notNull().defaultTo('org').check(inList('kind', ['personal', 'org']))).execute();
    await db.schema.alterTable('tenants').addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'suspended', 'pending_deletion', 'deleted']))).execute();
    await db.schema.alterTable('tenants').addColumn('plan', T.text, (c) => c.notNull().defaultTo('oss')).execute();
    await db.schema.alterTable('tenants').addColumn('created_by', T.id).execute();
    await db.schema.alterTable('tenants').addColumn('deletion_requested_at', T.ts).execute();
    await db.schema.alterTable('tenants').addColumn('deleted_at', T.ts).execute();
    await db.schema.alterTable('tenants').addColumn('updated_at', T.ts).execute();
    await db.updateTable('tenants').set({ updated_at: sql`created_at` }).execute();

    await db.schema
      .createTable('tenant_slug_aliases')
      .addColumn('slug', T.text, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().references('tenants.id').onDelete('cascade'))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts)
      .execute();
    await db.schema.createIndex('ix_tenant_slug_aliases_tenant').on('tenant_slug_aliases').column('tenant_id').execute();

    // users: email unique across tenants (the app lower-cases emails before writing them)
    await db.schema.alterTable('users').addColumn('avatar_url', T.text).execute();
    if (pg) await sql`alter table users drop constraint if exists uq_users_email`.execute(db);
    await db.schema.createIndex('uq_users_email_global').on('users').column('email').unique().execute();

    await db.schema
      .createTable('user_identities')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('provider', T.text, (c) => c.notNull())
      .addColumn('subject', T.text, (c) => c.notNull())
      .addColumn('email', T.text, (c) => c.notNull())
      .addColumn('email_verified', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('email_verified')))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('last_login_at', T.ts)
      .addUniqueConstraint('uq_user_identities_provider_subject', ['provider', 'subject'])
      .execute();
    await db.schema.createIndex('ix_user_identities_user').on('user_identities').column('user_id').execute();

    await db.schema
      .createTable('memberships')
      .addColumn('tenant_id', T.id, (c) => c.notNull().references('tenants.id').onDelete('cascade'))
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('role', T.text, (c) => c.notNull().check(inList('role', ['owner', 'admin', 'viewer'])))
      .addColumn('role_source', T.text, (c) => c.notNull().defaultTo('local').check(inList('role_source', ['local', 'oidc', 'bootstrap', 'invite'])))
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'disabled'])))
      .addColumn('invited_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_memberships', ['tenant_id', 'user_id'])
      .execute();
    await db.schema.createIndex('ix_memberships_user').on('memberships').column('user_id').execute();

    await db.schema
      .createTable('invites')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().references('tenants.id').onDelete('cascade'))
      .addColumn('email', T.text, (c) => c.notNull())
      .addColumn('role', T.text, (c) => c.notNull().check(inList('role', ['admin', 'viewer'])))
      .addColumn('token_hash', T.blob, (c) => c.notNull())
      .addColumn('invited_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('accepted_at', T.ts)
      .addColumn('accepted_by', T.id)
      .addColumn('revoked_at', T.ts)
      .addUniqueConstraint('uq_invites_token_hash', ['token_hash'])
      .execute();
    await db.schema.createIndex('ix_invites_tenant_email').on('invites').columns(['tenant_id', 'email']).execute();

    await db.schema.alterTable('web_sessions').addColumn('active_tenant_id', T.id).execute();
    await db.schema.alterTable('web_sessions').addColumn('impersonation_id', T.id).execute();

    // per-tenant DEKs: one active DEK per tenant (today's single active DEK belongs to the default tenant)
    await db.schema.createIndex('uq_encryption_keys_active_tenant').on('encryption_keys').column('tenant_id').unique().where(sql.ref('status'), '=', 'active').execute();

    // data: memberships from users.tenant_id + users.role (bootstrap → owner)
    const users = (await db.selectFrom('users').select(['id', 'tenant_id', 'email', 'role', 'role_source', 'status', 'oidc_issuer', 'oidc_subject', 'last_login_at', 'created_at', 'updated_at']).execute()) as Array<{
      id: string; tenant_id: string; email: string; role: 'admin' | 'viewer'; role_source: 'local' | 'oidc' | 'bootstrap'; status: 'active' | 'disabled';
      oidc_issuer: string | null; oidc_subject: string | null; last_login_at: number | null; created_at: number; updated_at: number;
    }>;
    for (const u of users) {
      await db
        .insertInto('memberships')
        .values({ tenant_id: u.tenant_id, user_id: u.id, role: u.role_source === 'bootstrap' ? 'owner' : u.role, role_source: u.role_source, status: u.status, invited_by: null, created_at: Number(u.created_at), updated_at: Number(u.updated_at) })
        .execute();
      if (u.oidc_issuer && u.oidc_subject) {
        await db
          .insertInto('user_identities')
          .values({ id: randomUUID(), user_id: u.id, provider: u.oidc_issuer === GOOGLE_ISSUER ? 'google' : `oidc:${u.tenant_id}`, subject: u.oidc_subject, email: u.email, email_verified: 1, created_at: Number(u.created_at), last_login_at: u.last_login_at === null ? null : Number(u.last_login_at) })
          .onConflict((oc) => oc.columns(['provider', 'subject']).doNothing())
          .execute();
      }
    }
    // every tenant keeps an owner: promote the oldest active admin where no bootstrap admin exists
    const owned = new Set(users.filter((u) => u.role_source === 'bootstrap').map((u) => u.tenant_id));
    const admins = users.filter((u) => u.role === 'admin' && u.status === 'active' && !owned.has(u.tenant_id)).sort((a, b) => Number(a.created_at) - Number(b.created_at));
    for (const a of admins) {
      if (owned.has(a.tenant_id)) continue;
      await db.updateTable('memberships').set({ role: 'owner' }).where('tenant_id', '=', a.tenant_id).where('user_id', '=', a.id).execute();
      owned.add(a.tenant_id);
    }

    if (pg) {
      const cols = (await sql<{ table_name: string }>`
        select c.table_name from information_schema.columns c
        join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = current_schema() and c.column_name = 'tenant_id' and c.column_default is not null and t.table_type = 'BASE TABLE'`.execute(db)).rows;
      for (const { table_name: name } of cols) {
        if (KEEP_DEFAULT.includes(name) || name.startsWith('audit_') || name.startsWith('rollup_')) continue;
        await sql`alter table ${sql.table(name)} alter column tenant_id drop default`.execute(db);
      }
    }
  },
  async down(db, { dialect }) {
    const pg = dialect === 'postgres';
    await db.schema.dropIndex('uq_encryption_keys_active_tenant').ifExists().execute();
    await db.schema.alterTable('web_sessions').dropColumn('impersonation_id').execute();
    await db.schema.alterTable('web_sessions').dropColumn('active_tenant_id').execute();
    await dropTables(db, ['invites', 'memberships', 'user_identities']);
    await db.schema.dropIndex('uq_users_email_global').ifExists().execute();
    if (pg) await sql`alter table users add constraint uq_users_email unique (tenant_id, email)`.execute(db);
    await db.schema.alterTable('users').dropColumn('avatar_url').execute();
    await dropTables(db, ['tenant_slug_aliases']);
    for (const c of ['updated_at', 'deleted_at', 'deletion_requested_at', 'created_by', 'plan', 'status', 'kind']) await db.schema.alterTable('tenants').dropColumn(c).execute();
    // the Postgres tenant_id defaults are not restored (forward-only in production)
  },
};
