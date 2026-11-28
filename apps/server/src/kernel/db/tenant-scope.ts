import { sql, type DeleteQueryBuilder, type DeleteResult, type Kysely, type SelectQueryBuilder, type SqlBool, type UpdateQueryBuilder, type UpdateResult } from 'kysely';
import type { AuditDB, MainDB } from './schema.js';

/**
 * Tables without tenant scope by design (multi-tenancy spec §4.2 step 5): platform rows, global
 * registrations, secret-hash lookups and coordination. Every other table is a `TenantTable`: each
 * query on it filters (select/update/delete) or sets (insert) `tenant_id`, which the tenant-scope CI
 * test (`test/tenant-scope.test.ts`) enforces.
 */
export const GLOBAL_TABLES = [
  'tenants',
  'tenant_slug_aliases',
  'users',
  'user_identities',
  'web_sessions',
  'oidc_login_states',
  'local_links',
  'oauth_clients',
  'oauth_codes',
  'leases',
  'coord_signals',
  'rate_limit_buckets',
  'redaction_rules',
  'audit_checkpoints',
  'audit_chain_heads',
  'audit_sink_cursors',
  'rollup_minute',
  'rollup_hour',
  'kysely_migration',
  'kysely_audit_migration',
] as const;

export type GlobalTable = (typeof GLOBAL_TABLES)[number];
export type TenantTable = Exclude<keyof MainDB, GlobalTable>;
export type AuditTenantTable = Exclude<keyof AuditDB, GlobalTable>;

const GLOBAL = new Set<string>(GLOBAL_TABLES);
export const isTenantTable = (t: string): boolean => !GLOBAL.has(t);

/**
 * Tables whose `tenant_id` keeps its column default in the generated types (`Generated<string>`):
 * global tables that still carry a `tenant_id` column. Inserts into every other table must set
 * `tenant_id` (spec §4.2 step 1).
 */
export const TENANT_ID_OPTIONAL_TABLES: readonly string[] = ['web_sessions', 'oidc_login_states', 'local_links', 'oauth_clients', 'redaction_rules'];

/**
 * Scoped query helper (spec §4.2 step 2): every builder it returns is already filtered by the tenant,
 * so a forgotten predicate can't read or change another tenant's rows. Inserts need `tenant_id` by
 * type (the column is required in `schema.ts`). `db` is the escape hatch; the CI test flags its
 * unscoped chains.
 */
export function scoped(db: Kysely<MainDB>, tenantId: string) {
  const own = (t: string) => sql<SqlBool>`${sql.ref(`${t}.tenant_id`)} = ${tenantId}`;
  return {
    tenantId,
    selectFrom: <T extends TenantTable>(t: T): SelectQueryBuilder<MainDB, T, object> => (db.selectFrom(t as TenantTable) as unknown as SelectQueryBuilder<MainDB, T, object>).where(own(t)),
    updateTable: <T extends TenantTable>(t: T): UpdateQueryBuilder<MainDB, T, T, UpdateResult> => (db.updateTable(t as TenantTable) as unknown as UpdateQueryBuilder<MainDB, T, T, UpdateResult>).where(own(t)),
    deleteFrom: <T extends TenantTable>(t: T): DeleteQueryBuilder<MainDB, T, DeleteResult> => (db.deleteFrom(t as TenantTable) as unknown as DeleteQueryBuilder<MainDB, T, DeleteResult>).where(own(t)),
    insertInto: <T extends TenantTable>(t: T) => db.insertInto(t),
    db,
  };
}

export type Scoped = ReturnType<typeof scoped>;
