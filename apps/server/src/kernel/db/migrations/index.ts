import { m0001_core } from './main/0001_core.js';
import { m0002_servers } from './main/0002_servers.js';
import { m0003_auth } from './main/0003_auth.js';
import { m0004_ops } from './main/0004_ops.js';
import { m0005_evals } from './main/0005_evals.js';
import { m0009_mock_state } from './main/0009_mock_state.js';
import { m0006_audit } from './audit/0006_audit.js';
import { m0007_metrics } from './audit/0007_metrics.js';
import type { DialectMigration } from './types.js';

/** Static migration sets (bundler-safe, explicit order). Numbering is global across both sets (Hub convention). */
export const MAIN_MIGRATIONS: readonly DialectMigration[] = [m0001_core, m0002_servers, m0003_auth, m0004_ops, m0005_evals, m0009_mock_state];

export const AUDIT_MIGRATIONS: readonly DialectMigration[] = [m0006_audit, m0007_metrics];

export type MigrationSet = 'main' | 'audit';

export const MIGRATION_TABLES: Record<MigrationSet, { table: string; lock: string }> = {
  main: { table: 'kysely_migration', lock: 'kysely_migration_lock' },
  audit: { table: 'kysely_audit_migration', lock: 'kysely_audit_migration_lock' },
};
