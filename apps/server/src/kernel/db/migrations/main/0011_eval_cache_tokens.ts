import { columnTypes } from '../../columns.js';
import type { DialectMigration } from '../types.js';

/**
 * Cached input tokens per eval attempt, reported separately from uncached input (provider caches:
 * OpenAI `cached_tokens`, Anthropic `cache_read_input_tokens` / `cache_creation_input_tokens`,
 * Gemini `total_cached_tokens`). `input_tokens` keeps its meaning: input not read from a cache
 * (Anthropic cache writes included). Older rows read as 0 cached tokens.
 */
export const m0011_eval_cache_tokens: DialectMigration = {
  name: '0011_eval_cache_tokens',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema.alterTable('eval_task_runs').addColumn('cache_read_tokens', T.int, (c) => c.notNull().defaultTo(0)).execute();
    await db.schema.alterTable('eval_task_runs').addColumn('cache_write_tokens', T.int, (c) => c.notNull().defaultTo(0)).execute();
  },
  async down(db) {
    await db.schema.alterTable('eval_task_runs').dropColumn('cache_write_tokens').execute();
    await db.schema.alterTable('eval_task_runs').dropColumn('cache_read_tokens').execute();
  },
};
