import { sql } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes, inList, isBool, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Eval suites, tasks, runs, task runs and fix suggestions (§7.2 `0005_evals`). */
export const m0005_evals: DialectMigration = {
  name: '0005_evals',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const tenant = sql.lit(DEFAULT_TENANT_ID);
    const t = (name: string) => db.schema.createTable(name).addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant));

    await t('eval_suites')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('version', T.int, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['draft', 'frozen'])))
      .addColumn('generated_from_build_id', T.id)
      .addColumn('generator', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('task_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('frozen_at', T.ts)
      .addUniqueConstraint('uq_eval_suites_version', ['tenant_id', 'server_id', 'version'])
      .execute();

    await t('eval_tasks')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('suite_id', T.id, (c) => c.notNull().references('eval_suites.id').onDelete('cascade'))
      .addColumn('key', T.text, (c) => c.notNull())
      .addColumn('category', T.text, (c) => c.notNull().check(inList('category', ['single', 'multi', 'ambiguous', 'impossible'])))
      .addColumn('prompt', T.text, (c) => c.notNull())
      .addColumn('rubric', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('assertions', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('reference_calls', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('seed_state', T.json)
      .addColumn('tags', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('enabled', T.bool, (c) => c.notNull().defaultTo(1).check(isBool('enabled')))
      .addColumn('source', T.text, (c) => c.notNull().defaultTo('generated').check(inList('source', ['generated', 'manual'])))
      .addUniqueConstraint('uq_eval_tasks_key', ['suite_id', 'key'])
      .execute();

    await t('eval_runs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull().references('servers.id').onDelete('cascade'))
      .addColumn('suite_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('build_id', T.id, (c) => c.notNull())
      .addColumn('overlay_revision_id', T.id)
      .addColumn('models', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('modes', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('repeats', T.int, (c) => c.notNull().defaultTo(1))
      .addColumn('task_keys', T.json)
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['queued', 'running', 'succeeded', 'failed', 'cancelled'])))
      .addColumn('progress', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('score', T.json)
      .addColumn('headline', T.int)
      .addColumn('recommended_mode', T.text)
      .addColumn('confidence', T.text)
      .addColumn('usage', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('error', T.text)
      .addColumn('trigger', T.text, (c) => c.notNull().check(inList('trigger', ['console', 'cli', 'ci', 'suggestion_verify'])))
      .addColumn('base_run_id', T.id)
      .addColumn('job_id', T.id)
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('started_at', T.ts)
      .addColumn('ended_at', T.ts)
      .execute();
    await db.schema.createIndex('ix_eval_runs_server').on('eval_runs').columns(['tenant_id', 'server_id', 'created_at']).execute();

    await t('eval_task_runs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('run_id', T.id, (c) => c.notNull().references('eval_runs.id').onDelete('cascade'))
      .addColumn('task_id', T.id, (c) => c.notNull())
      .addColumn('model', T.text, (c) => c.notNull())
      .addColumn('mode', T.text, (c) => c.notNull().check(inList('mode', ['tool', 'code'])))
      .addColumn('attempt', T.int, (c) => c.notNull())
      .addColumn('passed', T.bool, (c) => c.notNull().check(isBool('passed')))
      .addColumn('assertion_results', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('judge', T.json)
      .addColumn('failure_cause', T.text)
      .addColumn('framing_ok', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('framing_ok')))
      .addColumn('tool_calls', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('scripts', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('input_tokens', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('output_tokens', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('latency_ms', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('served_by_model', T.text)
      .addColumn('fallback_used', T.bool, (c) => c.notNull().defaultTo(0).check(isBool('fallback_used')))
      .addColumn('task_id_neurouter', T.id)
      .addColumn('transcript', T.blob)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_eval_task_runs_run').on('eval_task_runs').columns(['run_id', 'task_id', 'model', 'mode']).execute();

    await t('suggestions')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('run_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('cause', T.text, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['rename', 'describe', 'example', 'hide', 'response_shape', 'composite'])))
      .addColumn('tools', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('affected_task_ids', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('overlay_patch', T.text, (c) => c.notNull())
      .addColumn('spec_patch', T.text)
      .addColumn('rationale', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('predicted_delta', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('proposed').check(inList('status', ['proposed', 'verifying', 'verified', 'applied', 'dismissed'])))
      .addColumn('verify_run_id', T.id)
      .addColumn('verified_delta', T.int)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_suggestions_run').on('suggestions').column('run_id').execute();
    await db.schema.createIndex('ix_suggestions_server').on('suggestions').columns(['tenant_id', 'server_id', 'status']).execute();
  },
  async down(db) {
    await dropTables(db, ['suggestions', 'eval_task_runs', 'eval_runs', 'eval_tasks', 'eval_suites']);
  },
};
