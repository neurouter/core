import { sql } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes, inList, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** API keys and the MCP OAuth 2.1 AS (§7.2 `0003_auth`, ADAPT Hub `0008_oauth`). */
export const m0003_auth: DialectMigration = {
  name: '0003_auth',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const tenant = sql.lit(DEFAULT_TENANT_ID);

    await db.schema
      .createTable('api_keys')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('key_id', T.text, (c) => c.notNull())
      .addColumn('secret_hash', T.blob, (c) => c.notNull())
      .addColumn('display_prefix', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('purpose', T.text, (c) => c.notNull().defaultTo('user').check(inList('purpose', ['user', 'eval'])))
      .addColumn('owner_user_id', T.id, (c) => c.notNull().references('users.id'))
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('environment_id', T.id, (c) => c.notNull().references('environments.id').onDelete('cascade'))
      .addColumn('scopes', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('profile', T.text)
      .addColumn('rate_limit', T.json)
      .addColumn('expires_at', T.ts)
      .addColumn('revoked_at', T.ts)
      .addColumn('last_used_at', T.ts)
      .addColumn('last_used_ip', T.text)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_api_keys_key_id', ['key_id'])
      .execute();
    await db.schema.createIndex('ix_api_keys_env').on('api_keys').columns(['tenant_id', 'environment_id']).execute();

    await db.schema
      .createTable('oauth_clients')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('client_id', T.text, (c) => c.notNull())
      .addColumn('registration_type', T.text, (c) => c.notNull().check(inList('registration_type', ['cimd', 'dcr', 'preregistered'])))
      .addColumn('client_name', T.text, (c) => c.notNull())
      .addColumn('client_uri', T.text)
      .addColumn('logo_uri', T.text)
      .addColumn('redirect_uris', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('grant_types', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('response_types', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('token_endpoint_auth_method', T.text, (c) => c.notNull().check(inList('token_endpoint_auth_method', ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt'])))
      .addColumn('client_secret_hash', T.blob)
      .addColumn('application_type', T.text)
      .addColumn('metadata', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('metadata_fetched_at', T.ts)
      .addColumn('metadata_expires_at', T.ts)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'blocked'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_oauth_clients_client_id', ['client_id'])
      .execute();

    await db.schema
      .createTable('oauth_authz_requests')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('params', T.json, (c) => c.notNull())
      .addColumn('user_id', T.id)
      .addColumn('csrf_token', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('oauth_consents')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('scopes', T.text, (c) => c.notNull())
      .addColumn('redirect_uri', T.text, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('revoked_at', T.ts)
      .addUniqueConstraint('uq_oauth_consents', ['user_id', 'client_id', 'environment_id'])
      .execute();
    await db.schema.createIndex('ix_oauth_consents_env').on('oauth_consents').column('environment_id').execute();

    await db.schema
      .createTable('oauth_codes')
      .addColumn('code_hash', T.blob, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('redirect_uri', T.text, (c) => c.notNull())
      .addColumn('code_challenge', T.text, (c) => c.notNull())
      .addColumn('scopes', T.text, (c) => c.notNull())
      .addColumn('resource', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('consumed_at', T.ts)
      .execute();

    await db.schema
      .createTable('oauth_tokens')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('token_hash', T.blob, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['access', 'refresh'])))
      .addColumn('client_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('scopes', T.text, (c) => c.notNull())
      .addColumn('resource', T.text, (c) => c.notNull())
      .addColumn('family_id', T.id, (c) => c.notNull())
      .addColumn('parent_id', T.id)
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .addColumn('revoked_at', T.ts)
      .addColumn('last_used_at', T.ts)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_oauth_tokens_hash', ['token_hash'])
      .execute();
    await db.schema.createIndex('ix_oauth_tokens_family').on('oauth_tokens').column('family_id').execute();
    await db.schema.createIndex('ix_oauth_tokens_user').on('oauth_tokens').column('user_id').execute();
    await db.schema.createIndex('ix_oauth_tokens_env').on('oauth_tokens').column('environment_id').execute();
    await db.schema.createIndex('ix_oauth_tokens_expires').on('oauth_tokens').column('expires_at').execute();
  },
  async down(db) {
    await dropTables(db, ['oauth_tokens', 'oauth_codes', 'oauth_consents', 'oauth_authz_requests', 'oauth_clients', 'api_keys']);
  },
};
