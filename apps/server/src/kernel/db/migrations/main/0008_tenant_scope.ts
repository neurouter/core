import { sql } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** `INSTANCE_SCOPE_ID` (kernel/tenancy): the scope of instance settings. Frozen here: migrations never import runtime code. */
const INSTANCE_SCOPE = '00000000-0000-7000-8000-000000000000';

/** Instance setting keys at the time of this migration (kernel/settings `INSTANCE_SETTING_KEYS`). */
const INSTANCE_KEYS = ['installId', 'auditFailClosed', 'auditFtsEnabled', 'metricsToolLabel', 'codeLimitsCap', 'auditFullOutputMaxBytes', 'auditRetentionDays', 'metricsRetention', 'cimdPolicy', 'dcrEnabled', 'nativeSearchClients', 'firstAdminSignedIn'];

/**
 * Tenant isolation plumbing (multi-tenancy spec P0, §4.6, §3.4 G14). Additive and rollback-safe for
 * an existing single-tenant (v0.1.x) database:
 * - `oauth_client_blocks`: per-tenant OAuth client blocks (the global `oauth_clients.status` stays the platform block).
 * - Instance settings are **copied** from the default tenant to `INSTANCE_SCOPE_ID` (the originals stay,
 *   so an older binary still reads them after a rollback; the new settings service ignores them).
 * `tenant_id` column defaults are kept here (dropped on Postgres with the tenancy model, P1).
 */
export const m0008_tenant_scope: DialectMigration = {
  name: '0008_tenant_scope',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema
      .createTable('oauth_client_blocks')
      .addColumn('tenant_id', T.id, (c) => c.notNull())
      .addColumn('client_id', T.id, (c) => c.notNull().references('oauth_clients.id').onDelete('cascade'))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_oauth_client_blocks', ['tenant_id', 'client_id'])
      .execute();
    await db
      .insertInto('settings')
      .columns(['tenant_id', 'key', 'value', 'updated_by', 'updated_at'])
      .expression(
        db
          .selectFrom('settings')
          .select([sql.lit(INSTANCE_SCOPE).as('tenant_id'), 'key', 'value', 'updated_by', 'updated_at'])
          .where('tenant_id', '=', DEFAULT_TENANT_ID)
          .where('key', 'in', INSTANCE_KEYS),
      )
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .execute();
  },
  async down(db) {
    await db.deleteFrom('settings').where('tenant_id', '=', INSTANCE_SCOPE).execute();
    await dropTables(db, ['oauth_client_blocks']);
  },
};
