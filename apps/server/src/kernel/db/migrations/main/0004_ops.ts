import { sql } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { columnTypes, inList, jsonDefault } from '../../columns.js';
import { dropTables, type DialectMigration } from '../types.js';

/** Tasks, scripts, ops records, examples, result pages, usage, kill switches, config state (§7.2 `0004_ops`). */
export const m0004_ops: DialectMigration = {
  name: '0004_ops',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    const tenant = sql.lit(DEFAULT_TENANT_ID);
    const t = (name: string) => db.schema.createTable(name).addColumn('tenant_id', T.id, (c) => c.notNull().defaultTo(tenant));

    await t('tasks')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id)
      .addColumn('api_key_id', T.id)
      .addColumn('oauth_client_id', T.id)
      .addColumn('principal_type', T.text, (c) => c.notNull())
      .addColumn('credential_key', T.text, (c) => c.notNull())
      .addColumn('client_name', T.text)
      .addColumn('client_version', T.text)
      .addColumn('goal', T.text)
      .addColumn('outcome', T.text, (c) => c.check(inList('outcome', ['success', 'partial', 'failure', 'abandoned', 'unknown'])))
      .addColumn('notes', T.text)
      .addColumn('framing', T.text, (c) => c.notNull().check(inList('framing', ['explicit', 'inferred', 'script'])))
      .addColumn('inferred_label', T.json)
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['open', 'closed'])))
      .addColumn('started_at', T.ts, (c) => c.notNull())
      .addColumn('last_activity_at', T.ts, (c) => c.notNull())
      .addColumn('ended_at', T.ts)
      .addColumn('call_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('error_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('write_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('blocked_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('script_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('decision_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('ops_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('hinted', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('trace_id', T.text)
      .execute();
    await db.schema.createIndex('ix_tasks_started').on('tasks').columns(['tenant_id', 'started_at']).execute();
    await db.schema.createIndex('ix_tasks_server_env').on('tasks').columns(['tenant_id', 'server_id', 'environment_id', 'started_at']).execute();
    await db.schema.createIndex('ix_tasks_credential').on('tasks').columns(['credential_key', 'client_name', 'status', 'last_activity_at']).execute();

    await t('script_runs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('task_id', T.id)
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('user_id', T.id)
      .addColumn('credential_key', T.text, (c) => c.notNull())
      .addColumn('code', T.text, (c) => c.notNull())
      .addColumn('code_hash', T.text, (c) => c.notNull())
      .addColumn('mode', T.text, (c) => c.notNull().check(inList('mode', ['dry_run', 'execute'])))
      .addColumn('status', T.text, (c) => c.notNull())
      .addColumn('error', T.json)
      .addColumn('result_preview', T.json)
      .addColumn('result_bytes', T.int)
      .addColumn('result_handle', T.text)
      .addColumn('planned_changes', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('stats', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('phases', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('stdout', T.text)
      .addColumn('audit_id', T.id)
      .addColumn('trace_id', T.text)
      .addColumn('started_at', T.ts, (c) => c.notNull())
      .addColumn('ended_at', T.ts)
      .execute();
    await db.schema.createIndex('ix_script_runs_task').on('script_runs').columns(['tenant_id', 'task_id']).execute();
    await db.schema.createIndex('ix_script_runs_started').on('script_runs').columns(['tenant_id', 'started_at']).execute();
    await db.schema.createIndex('ix_script_runs_hash').on('script_runs').columns(['tenant_id', 'code_hash']).execute();

    await t('decisions')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('task_id', T.id)
      .addColumn('ts', T.ts, (c) => c.notNull())
      .addColumn('choice', T.text, (c) => c.notNull())
      .addColumn('reason', T.text, (c) => c.notNull())
      .addColumn('alternatives', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('audit_id', T.id)
      .execute();
    await db.schema.createIndex('ix_decisions_task').on('decisions').columns(['task_id', 'ts']).execute();

    await t('need_groups')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('label', T.text, (c) => c.notNull())
      .addColumn('intent_norm_hash', T.text, (c) => c.notNull())
      .addColumn('count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('distinct_principals', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('first_seen_at', T.ts, (c) => c.notNull())
      .addColumn('last_seen_at', T.ts, (c) => c.notNull())
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('open').check(inList('status', ['open', 'planned', 'done', 'dismissed'])))
      .addColumn('note', T.text)
      .addColumn('centroid', T.blob)
      .addUniqueConstraint('uq_need_groups_hash', ['tenant_id', 'server_id', 'intent_norm_hash'])
      .execute();
    await db.schema.createIndex('ix_need_groups_status').on('need_groups').columns(['tenant_id', 'server_id', 'status', 'count']).execute();

    await t('unmet_needs')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('group_id', T.id, (c) => c.notNull())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('task_id', T.id)
      .addColumn('user_id', T.id)
      .addColumn('credential_key', T.text, (c) => c.notNull())
      .addColumn('client_name', T.text)
      .addColumn('intent', T.text, (c) => c.notNull())
      .addColumn('attempted', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('audit_id', T.id)
      .execute();
    await db.schema.createIndex('ix_unmet_needs_group').on('unmet_needs').columns(['group_id', 'created_at']).execute();
    await db.schema.createIndex('ix_unmet_needs_created').on('unmet_needs').columns(['tenant_id', 'created_at']).execute();

    await t('issues')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('task_id', T.id)
      .addColumn('tool_name', T.text, (c) => c.notNull())
      .addColumn('problem', T.text, (c) => c.notNull())
      .addColumn('evidence', T.json)
      .addColumn('related_audit_id', T.id)
      .addColumn('status', T.text, (c) => c.notNull().defaultTo('open').check(inList('status', ['open', 'acknowledged', 'fixed', 'dismissed'])))
      .addColumn('note', T.text)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('updated_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_issues_status').on('issues').columns(['tenant_id', 'server_id', 'status', 'created_at']).execute();

    await t('error_events')
      .addColumn('error_id', T.text, (c) => c.primaryKey())
      .addColumn('task_id', T.id)
      .addColumn('audit_id', T.id)
      .addColumn('tool_name', T.text)
      .addColumn('code', T.text, (c) => c.notNull())
      .addColumn('detail', T.json, (c) => c.notNull().defaultTo(jsonDefault('{}')))
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_error_events_expires').on('error_events').column('expires_at').execute();

    await t('examples')
      .addColumn('id', T.id, (c) => c.primaryKey())
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('tool_name', T.text, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['call', 'script'])))
      .addColumn('arguments', T.json)
      .addColumn('code', T.text)
      .addColumn('args_hash', T.text, (c) => c.notNull())
      .addColumn('source', T.text, (c) => c.notNull().check(inList('source', ['overlay', 'spec', 'eval', 'traffic'])))
      .addColumn('success_count', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('last_success_at', T.ts)
      .addColumn('build_hash', T.text)
      .addUniqueConstraint('uq_examples', ['tenant_id', 'server_id', 'tool_name', 'kind', 'args_hash'])
      .execute();
    await db.schema.createIndex('ix_examples_tool').on('examples').columns(['server_id', 'tool_name', 'success_count']).execute();

    await t('result_pages')
      .addColumn('handle', T.text, (c) => c.primaryKey())
      .addColumn('credential_key', T.text, (c) => c.notNull())
      .addColumn('content', T.blob, (c) => c.notNull())
      .addColumn('bytes', T.int, (c) => c.notNull())
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addColumn('expires_at', T.ts, (c) => c.notNull())
      .execute();
    await db.schema.createIndex('ix_result_pages_expires').on('result_pages').column('expires_at').execute();

    await t('usage_daily')
      .addColumn('server_id', T.id, (c) => c.notNull())
      .addColumn('environment_id', T.id, (c) => c.notNull())
      .addColumn('tool_name', T.text, (c) => c.notNull())
      .addColumn('day', T.text, (c) => c.notNull())
      .addColumn('calls', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('errors', T.int, (c) => c.notNull().defaultTo(0))
      .addColumn('script_calls', T.int, (c) => c.notNull().defaultTo(0))
      .addPrimaryKeyConstraint('pk_usage_daily', ['tenant_id', 'environment_id', 'tool_name', 'day'])
      .execute();

    await t('kill_switches')
      .addColumn('scope', T.text, (c) => c.notNull().check(inList('scope', ['global', 'server', 'environment', 'tool'])))
      .addColumn('target', T.text, (c) => c.notNull())
      .addColumn('kind', T.text, (c) => c.notNull().check(inList('kind', ['all', 'writes', 'code_mode'])))
      .addColumn('reason', T.text, (c) => c.notNull().defaultTo(''))
      .addColumn('created_by', T.id)
      .addColumn('created_at', T.ts, (c) => c.notNull())
      .addPrimaryKeyConstraint('pk_kill_switches', ['tenant_id', 'scope', 'target', 'kind'])
      .execute();

    await db.schema
      .createTable('config_state')
      .addColumn('tenant_id', T.id, (c) => c.primaryKey())
      .addColumn('path', T.text)
      .addColumn('hash', T.text)
      .addColumn('applied_at', T.ts)
      .addColumn('status', T.text, (c) => c.notNull().check(inList('status', ['ok', 'error'])))
      .addColumn('diagnostics', T.json, (c) => c.notNull().defaultTo(jsonDefault('[]')))
      .execute();
  },
  async down(db) {
    await dropTables(db, ['config_state', 'kill_switches', 'usage_daily', 'result_pages', 'examples', 'error_events', 'issues', 'unmet_needs', 'need_groups', 'decisions', 'script_runs', 'tasks']);
  },
};
