import { sql } from 'kysely';
import { columnTypes } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** `LEGACY_CHAIN_ID` (kernel/audit/chain.ts), frozen here: migrations never import runtime code. */
const LEGACY_CHAIN = '00000000-0000-0000-0000-000000000000';

/**
 * Per-tenant audit hash chains (multi-tenancy spec §4.5, named `0010_audit_tenant_chains` there; P1).
 *
 * - `audit_chain_heads(tenant_id, seq, hash)`: the head of each tenant's chain, moved by the writer
 *   in the batch transaction. New rows link to the previous row **of the same tenant** (the first one
 *   to `sha256("neurouter-core-audit-genesis:" + install_id + ":" + tenant_id)`).
 * - The rows written before this migration stay verifiable as the legacy instance-wide chain: its
 *   head is recorded under `LEGACY_CHAIN_ID` (seq 0 on an empty log).
 * - `audit_checkpoints.tenant_id`: the chain a checkpoint anchors (null = the legacy chain).
 * - Indexes lead with `tenant_id`: `(tenant_id, seq)` for chain walks, `(tenant_id, server_id, environment_id, ts)`.
 * - Postgres: `tenant_id` column defaults are dropped on the audit tables (writers always name the tenant).
 */
export const m0015_audit_tenant_chains: DialectMigration = {
  name: '0015_audit_tenant_chains',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const pg = dialect === 'postgres';
    await db.schema
      .createTable('audit_chain_heads')
      .addColumn('tenant_id', T.id, (c) => c.primaryKey())
      .addColumn('seq', T.bigint, (c) => c.notNull())
      .addColumn('hash', T.text, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.alterTable('audit_checkpoints').addColumn('tenant_id', T.id).execute();
    await db.schema.createIndex('ix_audit_checkpoints_tenant_seq').on('audit_checkpoints').columns(['tenant_id', 'seq']).execute();
    await db.schema.createIndex('ix_audit_log_tenant_seq').on('audit_log').columns(['tenant_id', 'seq']).execute();
    await db.schema.createIndex('ix_audit_log_tenant_server_env_ts').on('audit_log').columns(['tenant_id', 'server_id', 'environment_id', 'ts']).execute();
    await db.schema.dropIndex('ix_audit_log_server_env_ts').ifExists().execute();

    // the legacy chain ends at the current head (the newest row, else the newest checkpoint after a full prune)
    const last = (await db.selectFrom('audit_log').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst()) as { seq: number | string; hash: string } | undefined;
    const cp = last ? undefined : ((await db.selectFrom('audit_checkpoints').select(['seq', 'hash']).orderBy('seq', 'desc').limit(1).executeTakeFirst()) as { seq: number | string; hash: string } | undefined);
    const head = last ?? cp;
    await db.insertInto('audit_chain_heads').values({ tenant_id: LEGACY_CHAIN, seq: head ? Number(head.seq) : 0, hash: head?.hash ?? '', updated_at: Date.now() }).execute();

    if (pg) {
      for (const t of ['audit_log', 'rollup_minute', 'rollup_hour']) await sql`alter table ${sql.table(t)} alter column tenant_id drop default`.execute(db);
    }
  },
  async down(db, { dialect }) {
    await db.schema.createIndex('ix_audit_log_server_env_ts').ifNotExists().on('audit_log').columns(['server_id', 'environment_id', 'ts']).execute();
    await db.schema.dropIndex('ix_audit_log_tenant_server_env_ts').ifExists().execute();
    await db.schema.dropIndex('ix_audit_log_tenant_seq').ifExists().execute();
    await db.schema.dropIndex('ix_audit_checkpoints_tenant_seq').ifExists().execute();
    await db.schema.alterTable('audit_checkpoints').dropColumn('tenant_id').execute();
    await dropTables(db, ['audit_chain_heads']);
    void dialect;
  },
};
