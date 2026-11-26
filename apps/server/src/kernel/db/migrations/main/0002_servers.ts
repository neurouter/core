import { sql, type CreateTableBuilder } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes, inList, isBool, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Servers, spec revisions, overlays, builds, tools (+ search index), environments, upstream tokens (§7.2 `0002_servers`). */
export const m0002_servers: DialectMigration = {
  name: '0002_servers',
  async up(db, { dialect, embeddingDims }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';
    const tenant = sql.lit(DEFAULT_TENANT_ID);
    const managed = ['file', 'console'];
    const resStatus = ['active', 'disabled', 'removed_from_config'];

    await db.schema
      .createTable('servers')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('slug', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['openapi', 'graphql'])))
      .addColumn('spec_source', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('exposure', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('ops_tools', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('public_report', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('public_report')))
      .addColumn('overlay_path', T.text)
      .addColumn('current_spec_revision_id', T.id)
      .addColumn('published_overlay_revision_id', T.id)
      .addColumn('latest_build_id', T.id)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', resStatus)))
      .addColumn('managed_by', T.text, (c) => c.notNull().defaultTo('console').check(inList('managed_by', managed)))
      .addColumn('config_path', T.text)
      .addColumn('config_line', T.int)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_servers_slug', ['tenant_id', 'slug'])
      .execute();

    await db.schema
      .createTable('spec_revisions')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('rev', T.int, (c) => c.notNull())
      .addColumn('format', T.text, (c) => c.notNull().check(inList('format', ['openapi-3.0', 'openapi-3.1', 'graphql-sdl', 'graphql-introspection'])))
      .addColumn('source_url', T.text)
      .addColumn('content_type', T.text)
      .addColumn('content_hash', T.text, (c) => c.notNull())
      .addColumn('content', T.blob, (c) => c.notNull())
      .addColumn('content_bytes', T.int, (c) => c.notNull())
      .addColumn('title', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('api_version', T.text)
      .addColumn('operation_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('summary', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_spec_revisions_rev', ['tenant_id', 'server_id', 'rev'])
      .execute();
    await db.schema.createIndex('ix_spec_revisions_hash').on('spec_revisions').columns(['server_id', 'content_hash']).execute();

    await db.schema
      .createTable('overlay_revisions')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('rev', T.int, (c) => c.notNull())
      .addColumn('yaml', T.text, (c) => c.notNull())
      .addColumn('hash', T.text, (c) => c.notNull())
      .addColumn('message', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('source', T.text, (c) => c.notNull().check(inList('source', ['console', 'file', 'suggestion', 'revert'])))
      .addColumn('based_on_rev', T.int)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_overlay_revisions_rev', ['tenant_id', 'server_id', 'rev'])
      .execute();

    await db.schema
      .createTable('overlay_drafts')
      .addColumn('server_id', T.id, (c) => c.primaryKey().references('servers.id').onDelete('cascade'))
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('yaml', T.text, (c) => c.notNull())
      .addColumn('based_on_rev', T.int)
      .addColumn('change_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('changes', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('updated_by', T.id)
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('builds')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('spec_revision_id', T.id, (c) => c.notNull())
      .addColumn('overlay_revision_id', T.id)
      .addColumn('temporary', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('temporary')))
      .addColumn('compiler_version', T.text, (c) => c.notNull())
      .addColumn('hash', T.text, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['ok', 'error'])))
      .addColumn('diagnostics', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('tool_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('visible_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('write_tool_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('hidden_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('lint', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('lint_score', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('orphaned_overlay_keys', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('profiles', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('python_stubs', T.blob)
      .addColumn('mock_model', T.blob)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_builds_hash', ['tenant_id', 'server_id', 'hash'])
      .execute();
    await db.schema.createIndex('ix_builds_server_created').on('builds').columns(['server_id', 'created_at']).execute();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let tools: CreateTableBuilder<any, any> = db.schema.createTable('tools');
    tools = pg ? tools.addColumn('seq', 'bigserial', (c) => c.notNull().unique()) : tools.addColumn('seq', 'integer', (c) => c.primaryKey());
    tools = tools
      .addColumn('id', T.id, (c) => (pg ? c.primaryKey() : c.notNull().unique()))
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('build_id', T.id, (c) => c.notNull().references('builds.id').onDelete('cascade'))
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('key', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('py_name', T.text, (c) => c.notNull())
      .addColumn('title', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('description', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['http', 'graphql', 'composite'])))
      .addColumn('write', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('write')))
      .addColumn('hidden', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('hidden')))
      .addColumn('pinned', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('pinned')))
      .addColumn('deprecated', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('deprecated')))
      .addColumn('tags', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('def', T.json, (c) => c.notNull())
      .addColumn('def_hash', T.text, (c) => c.notNull())
      .addColumn('search_text', T.text, (c) => c.notNull().defaultTo(''))
      .addUniqueConstraint('uq_tools_build_name', ['tenant_id', 'build_id', 'name']);
    if (pg) {
      tools = tools.addColumn('search_tsv', sql`tsvector`, (c) =>
        c
          .generatedAlwaysAs(
            sql`setweight(to_tsvector('simple'::regconfig, coalesce(name, '')), 'A') || setweight(to_tsvector('simple'::regconfig, coalesce(title, '')), 'B') || setweight(to_tsvector('simple'::regconfig, coalesce(description, '')), 'C') || setweight(to_tsvector('simple'::regconfig, coalesce(search_text, '')), 'D')`,
          )
          .stored(),
      );
    }
    await tools.execute();
    await db.schema.createIndex('ix_tools_build_hidden').on('tools').columns(['build_id', 'hidden']).execute();
    if (pg) await sql`create index ix_tools_search_tsv on tools using gin (search_tsv)`.execute(db);
    else await sql`create virtual table tools_fts using fts5(name, title, description, search_text, content='tools', content_rowid='seq', tokenize='unicode61 remove_diacritics 2')`.execute(db);

    const dims = Math.trunc(embeddingDims);
    if (!(dims > 0 && dims <= 2000)) throw new Error(`Invalid embedding dimensions: ${embeddingDims}`);
    await db.schema
      .createTable('tool_embeddings')
      .addColumn('tool_id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('tool_seq', T.bigint, (c) => c.notNull())
      .addColumn('model_id', T.text, (c) => c.notNull())
      .addColumn('dims', T.int, (c) => c.notNull())
      .addColumn('text_hash', T.text, (c) => c.notNull())
      .addColumn('embedding', pg ? sql.raw(`vector(${dims})`) : T.blob, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_tool_embeddings_seq').on('tool_embeddings').column('tool_seq').execute();
    await db.schema.createIndex('ix_tool_embeddings_model').on('tool_embeddings').column('model_id').execute();

    await db.schema
      .createTable('environments')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('slug', T.text, (c) => c.notNull())
      .addColumn('name', T.text, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['dev', 'qa', 'prod'])))
      .addColumn('base_url', T.text, (c) => c.notNull())
      .addColumn('build_id', T.id)
      .addColumn('auto_promote', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('auto_promote')))
      .addColumn('auth', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('headers', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('writes', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('code_mode', T.bool, (c) => c.notNull().defaultTo(1).check(isBool('code_mode')))
      .addColumn('limits', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('policies', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('discovery_override', T.json)
      .addColumn('allowed_hosts', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('allow_http', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('allow_http')))
      .addColumn('builtin', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('builtin')))
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', resStatus)))
      .addColumn('health', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('managed_by', T.text, (c) => c.notNull().defaultTo('console').check(inList('managed_by', managed)))
      .addColumn('config_path', T.text)
      .addColumn('config_line', T.int)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_environments_slug', ['tenant_id', 'server_id', 'slug'])
      .execute();

    await db.schema
      .createTable('upstream_tokens')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('environment_id', T.id, (c) => c.notNull().references('environments.id').onDelete('cascade'))
      .addColumn('user_id', T.id, (c) => c.notNull().references('users.id').onDelete('cascade'))
      .addColumn('dek_id', T.id, (c) => c.notNull().references('encryption_keys.id'))
      .addColumn('access_nonce', T.blob, (c) => c.notNull())
      .addColumn('access_ciphertext', T.blob, (c) => c.notNull())
      .addColumn('refresh_nonce', T.blob)
      .addColumn('refresh_ciphertext', T.blob)
      .addColumn('scopes', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('expires_at', T.ts)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('active').check(inList('status', ['active', 'refresh_failed', 'revoked'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addUniqueConstraint('uq_upstream_tokens', ['tenant_id', 'environment_id', 'user_id'])
      .execute();

    await db.schema
      .createTable('upstream_oauth_states')
      .addColumn('state_hash', T.blob, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('user_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('code_verifier_enc', T.blob, (c) => c.notNull())
      .addColumn('redirect_after', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();

    await db.schema
      .createTable('spec_previews')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant))
      .addColumn('server_id', T.id)
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['compiling', 'ready', 'failed'])))
      .addColumn('content', T.blob)
      .addColumn('source_url', T.text)
      .addColumn('state', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();
  },
  async down(db, { dialect }) {
    if (dialect === 'sqlite') await sql`drop table if exists tools_fts`.execute(db);
    await dropTables(db, ['spec_previews', 'upstream_oauth_states', 'upstream_tokens', 'environments', 'tool_embeddings', 'tools', 'builds', 'overlay_drafts', 'overlay_revisions', 'spec_revisions', 'servers']);
  },
};
