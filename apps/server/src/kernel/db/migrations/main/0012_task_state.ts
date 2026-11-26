import { columnTypes, inList } from '../../columns.js';
import type { DialectMigration } from '../types.js';

/**
 * Agent contract 2, P3:
 * - task inference by MCP session (`tasks.session_key`) and the per-task state block in the database
 *   (`state_*`: call counter, identical-result streak, last call/result keys, env/writes last shown), so a task
 *   served by several instances counts once;
 * - `tasks.exit_kind`: how the agent ended the task with `neurouter_report` (`done` | `blocked`);
 * - `confirm_nonces`: single-use confirm tokens for destructive writes outside prod (D5), shared by instances.
 */
export const m0012_task_state: DialectMigration = {
  name: '0012_task_state',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema.alterTable('tasks').addColumn('session_key', T.text).execute();
    await db.schema.alterTable('tasks').addColumn('state_calls', T.int, (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('tasks').addColumn('state_streak', T.int, (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('tasks').addColumn('state_call_key', T.text).execute();
    await db.schema.alterTable('tasks').addColumn('state_result_key', T.text).execute();
    await db.schema.alterTable('tasks').addColumn('state_env', T.text).execute();
    await db.schema.alterTable('tasks').addColumn('state_writes', T.text).execute();
    await db.schema
      .alterTable('tasks')
      .addColumn('exit_kind', T.text, (c) => c.check(inList('exit_kind', ['done', 'blocked'])))
      .execute();
    await db.schema
      .createTable('confirm_nonces')
      .addColumn('id', T.text, (c) => c.primaryKey())
      .addColumn('tenant_id', T.text, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_confirm_nonces_expires').on('confirm_nonces').column('expires_at').execute();
  },
  async down(db) {
    await db.schema.dropTable('confirm_nonces').ifExists().execute();
    for (const c of ['exit_kind', 'state_writes', 'state_env', 'state_result_key', 'state_call_key', 'state_streak', 'state_calls', 'session_key']) await db.schema.alterTable('tasks').dropColumn(c).execute();
  },
};
