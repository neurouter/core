import { sql } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes, inList, isBool, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Tenants, users, sessions, local links, settings, encryption, platform tables (§7.2 `0001_core`). */
export const m0001_core: DialectMigration = {
  name: '0001_core',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';
    const tenant = sql.lit(DEFAULT_TENANT_ID);

    if (pg) {
      try {
        await sql`create extension if not exists vector`.execute(db);
      } catch (err) {
        throw new Error(
          'Failed to enable the pgvector extension. A database administrator must run `CREATE EXTENSION vector;` ' +
            `in this database before Neurouter can start. Cause: ${(err as Error).message}`,
          { cause: err },
        );
      }
    }

    await db.schema
      .createTable('tenants')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('slug', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_tenants_slug', ['slug'])
      .execute();
    await db.insertInto('tenants').values({ id: DEFAULT_TENANT_ID, slug: 'default', name: 'Default', created_at: Date.now() }).execute();

    await db.schema
      .createTable('users')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant).references('tenants.id'))
      .addColumn('email', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('oidc_issuer', T.text)
      .addColumn('oidc_subject', T.text)
      .addColumn('role', T.text, (c) => c.notNull().defaultTo('viewer').check(inList('role', ['admin', 'viewer'])))
      .addColumn('role_source', T.text, (c) => c.notNull().defaultTo('local').check(inList('role_source', ['local', 'oidc', 'bootstrap'])))
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'disabled'])))
      .addColumn('last_login_at', T.ts)
      .addColumn('preferences', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_users_email', ['tenant_id', 'email'])
      .addUniqueConstraint('uq_users_oidc', ['oidc_issuer', 'oidc_subject'])
      .execute();

    await db.schema
      .createTable('web_sessions')
      .addColumn('id_hash', T.blob, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('csrf_token', T.text, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('last_seen_at', T.ts, (c) => c.notNull())
      .addColumn('ip', T.text)
      .addColumn('user_agent', T.text)
      .addColumn('id_token_hint', T.text)
      .addColumn('anonymous', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('anonymous')))
      .execute();
    await db.schema.createIndex('ix_web_sessions_user').on('web_sessions').column('user_id').execute();
    await db.schema.createIndex('ix_web_sessions_expires').on('web_sessions').column('expires_at').execute();

    await db.schema
      .createTable('oidc_login_states')
      .addColumn('state_hash', T.blob, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('code_verifier_enc', T.blob, (c) => c.notNull())
      .addColumn('nonce', T.text, (c) => c.notNull())
      .addColumn('return_to', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('local_links')
      .addColumn('token_hash', T.blob, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('used_at', T.ts)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('settings')
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('key', T.text, (c) => c.notNull())
      .addColumn('value', T.json, (c) => c.notNull())
      .addColumn('updated_by', T.id)
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_settings', ['tenant_id', 'key'])
      .execute();

    await db.schema
      .createTable('encryption_keys')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('kek_id', T.text, (c) => c.notNull())
      .addColumn('wrapped_key', T.blob, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['active', 'retired'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_encryption_keys_status').on('encryption_keys').column('status').execute();

    await db.schema
      .createTable('secrets')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('purpose', T.text, (c) => c.notNull())
      .addColumn('owner_type', T.text, (c) => c.check(inList('owner_type', ['environment', 'settings', 'oauth_client'])))
      .addColumn('owner_id', T.text)
      .addColumn('name', T.text)
      .addColumn('provider', T.text, (c) => c.notNull().defaultTo('builtin').check(inList('provider', ['builtin'])))
      .addColumn('external_ref', T.text)
      .addColumn('dek_id', T.id, (c) => c.references('encryption_keys.id'))
      .addColumn('nonce', T.blob)
      .addColumn('ciphertext', T.blob)
      .addColumn('version', T.int, (c) => c.notNull().defaultTo(1))
      .addColumn('updated_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_secrets_owner_name', ['tenant_id', 'owner_type', 'owner_id', 'name'])
      .execute();
    await db.schema.createIndex('ix_secrets_dek').on('secrets').column('dek_id').execute();

    await db.schema
      .createTable('redaction_rules')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('type', T.text, (c) => c.notNull().check(inList('type', ['key', 'regex'])))
      .addColumn('pattern', T.text, (c) => c.notNull())
      .addColumn('replacement', T.text, (c) => c.notNull())
      .addColumn('enabled', T.bool, (c) => c.notNull().defaultTo(1).check(isBool('enabled')))
      .addColumn('order', T.int, (c) => c.notNull())
      .addColumn('builtin', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('builtin')))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_redaction_rules_order').on('redaction_rules').column('order').execute();

    await db.schema
      .createTable('leases')
      .addColumn('name', T.text, (c) => c.primaryKey())
      .addColumn('holder', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('coord_signals')
      .addColumn('channel', T.text, (c) => c.notNull())
      .addColumn('payload', T.json, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_coord_signals_channel_created').on('coord_signals').columns(['channel', 'created_at']).execute();

    await db.schema
      .createTable('jobs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('kind', T.text, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['queued', 'running', 'ok', 'error'])))
      .addColumn('params', T.json)
      .addColumn('progress', T.float)
      .addColumn('result', T.json)
      .addColumn('error', T.text)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('finished_at', T.ts)
      .execute();
    await db.schema.createIndex('ix_jobs_kind_created').on('jobs').columns(['kind', 'created_at']).execute();

    await db.schema
      .createTable('rate_limit_buckets')
      .addColumn('key', T.text, (c) => c.primaryKey())
      .addColumn('tokens', T.float, (c) => c.notNull())
      .addColumn('capacity', T.float, (c) => c.notNull())
      .addColumn('refill_per_ms', T.float, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
  },
  async down(db) {
    await dropTables(db, ['rate_limit_buckets', 'jobs', 'coord_signals', 'leases', 'redaction_rules', 'secrets', 'encryption_keys', 'settings', 'local_links', 'oidc_login_states', 'web_sessions', 'users', 'tenants']);
  },
};
