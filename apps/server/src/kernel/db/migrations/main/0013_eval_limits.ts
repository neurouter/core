import { columnTypes } from '../../columns.js';
import type { DialectMigration } from '../types.js';

/**
 * Per-task attempt limit overrides (0.3.3): `eval_tasks.limits` holds a task's `limits` JSON (`maxTurns`,
 * `maxToolCalls`, `maxTotalTokens`, `wallMs`), or null for the suite's and the run defaults. Suite-level limits live
 * in the suite's `generator` JSON, next to its mock data version.
 */
export const m0013_eval_limits: DialectMigration = {
  name: '0013_eval_limits',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema.alterTable('eval_tasks').addColumn('limits', T.text).execute();
  },
  async down(db) {
    await db.schema.alterTable('eval_tasks').dropColumn('limits').execute();
  },
};
