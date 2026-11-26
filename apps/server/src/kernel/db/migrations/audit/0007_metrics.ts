import { sql } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Latency histogram bucket columns h00..h19 (Hub buckets). */
export const HISTOGRAM_COLUMNS = Array.from({ length: 20 }, (_, i) => `h${String(i).padStart(2, '0')}`);

/** Metric rollups (1 min / 1 h) by server, environment, tool, mode, status class (§7.2 `0007_metrics`, ADAPT Hub). */
export const m0007_metrics: DialectMigration = {
  name: '0007_metrics',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    for (const table of ['rollup_minute', 'rollup_hour']) {
      let t = db.schema
        .createTable(table)
        .addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(sql.lit(DEFAULT_TENANT_ID)))
        .addColumn('bucket', T.ts, (c) => c.notNull())
        .addColumn('server_id', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('environment_id', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('tool_name', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('mode', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('status_class', T.text, (c) => c.notNull().defaultTo(''))
        .addColumn('calls', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('errors', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('blocked', T.int, (c) => c.notNull().defaultTo(0))
        .addColumn('latency_sum_ms', T.bigint, (c) => c.notNull().defaultTo(0))
        .addColumn('upstream_latency_sum', T.bigint, (c) => c.notNull().defaultTo(0));
      for (const h of HISTOGRAM_COLUMNS) t = t.addColumn(h, T.int, (c) => c.notNull().defaultTo(0));
      await t.addPrimaryKeyConstraint(`pk_${table}`, ['tenant_id', 'bucket', 'server_id', 'environment_id', 'tool_name', 'mode', 'status_class']).execute();
      await db.schema.createIndex(`ix_${table}_server_bucket`).on(table).columns(['server_id', 'bucket']).execute();
      await db.schema.createIndex(`ix_${table}_bucket`).on(table).column('bucket').execute();
    }
  },
  async down(db) {
    await dropTables(db, ['rollup_hour', 'rollup_minute']);
  },
};
