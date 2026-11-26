import { sql } from 'kysely';
import { columnTypes, inList } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/**
 * Mock state in the database (multi-tenancy spec §7.3): namespaces, lazily seeded collections and
 * their items, every row keyed by tenant + environment + namespace so all instances share one mock
 * world. `tenant_id` has no default: the store sets it on every insert.
 */
export const m0009_mock_state: DialectMigration = {
  name: '0009_mock_state',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);

    await db.schema
      .createTable('mock_namespaces')
      .addColumn('tenant_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('namespace', T.text, (c) => c.notNull().check(sql`length(${sql.ref('namespace')}) <= 220`))
      .addColumn('seed', T.bigint, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['env', 'eval', 'gen'])))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('last_used_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts)
      .addPrimaryKeyConstraint('pk_mock_namespaces', ['tenant_id', 'environment_id', 'namespace'])
      .execute();
    await db.schema.createIndex('ix_mock_namespaces_expires').on('mock_namespaces').column('expires_at').execute();
    await db.schema.createIndex('ix_mock_namespaces_last_used').on('mock_namespaces').columns(['kind', 'last_used_at']).execute();

    await db.schema
      .createTable('mock_collections')
      .addColumn('tenant_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('namespace', T.text, (c) => c.notNull())
      .addColumn('collection_key', T.text, (c) => c.notNull())
      .addColumn('seed', T.bigint, (c) => c.notNull())
      .addColumn('next_id', T.bigint, (c) => c.notNull())
      .addColumn('item_count', T.int, (c) => c.notNull())
      .addColumn('bytes', T.bigint, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('last_used_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_mock_collections', ['tenant_id', 'environment_id', 'namespace', 'collection_key'])
      .execute();
    await db.schema.createIndex('ix_mock_collections_last_used').on('mock_collections').column('last_used_at').execute();

    await db.schema
      .createTable('mock_items')
      .addColumn('tenant_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('namespace', T.text, (c) => c.notNull())
      .addColumn('collection_key', T.text, (c) => c.notNull())
      .addColumn('item_id', T.text, (c) => c.notNull())
      .addColumn('ord', T.bigint, (c) => c.notNull())
      // JSON as text on both dialects: jsonb would reorder keys, and responses must stay byte-identical
      .addColumn('body', T.text, (c) => c.notNull())
      .addColumn('bytes', T.int, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_mock_items', ['tenant_id', 'environment_id', 'namespace', 'collection_key', 'item_id'])
      .execute();
    await db.schema.createIndex('ix_mock_items_ord').on('mock_items').columns(['tenant_id', 'environment_id', 'namespace', 'collection_key', 'ord']).execute();
  },
  async down(db) {
    await dropTables(db, ['mock_items', 'mock_collections', 'mock_namespaces']);
  },
};
