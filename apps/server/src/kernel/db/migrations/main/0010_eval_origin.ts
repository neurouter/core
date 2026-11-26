import { sql, type ExpressionBuilder } from 'kysely';
import { columnTypes, inList } from '../../columns.js';
import type { DialectMigration } from '../types.js';

/**
 * Eval traffic isolation: `tasks.origin` ('live' | 'eval'), backfilled from the task's API key
 * purpose, then removes what eval agents wrote into the product inbox before ops tools learned to
 * skip eval traffic: unmet needs and issues of eval tasks (or eval keys), and the need groups they
 * created. Groups that still hold live reports are recounted (count, distinct principals, first/last
 * seen) and relabelled from their oldest live report when their label came from an eval report.
 * Forward-only and idempotent (a second run finds no eval rows); portable SQL on SQLite and Postgres.
 */
export const m0010_eval_origin: DialectMigration = {
  name: '0010_eval_origin',
  async up(db, { dialect }) {
    const T = columnTypes(dialect);
    await db.schema
      .alterTable('tasks')
      .addColumn('origin', T.text, (c) => c.notNull().defaultTo('live').check(inList('origin', ['live', 'eval'])))
      .execute();
    await db.schema.createIndex('ix_tasks_origin').on('tasks').columns(['tenant_id', 'origin', 'started_at']).execute();

    const evalKeys = db.selectFrom('api_keys').select('id').where('purpose', '=', 'eval');
    await db.updateTable('tasks').set({ origin: 'eval' }).where('api_key_id', 'in', evalKeys).execute();
    const evalTasks = db.selectFrom('tasks').select('id').where('origin', '=', 'eval');
    // credential_key is text, api_keys.id is uuid on Postgres
    const evalKeyText = db.selectFrom('api_keys').select(sql<string>`cast(id as text)`.as('id')).where('purpose', '=', 'eval');

    // eval-origin unmet needs: their task is an eval task, or they were reported with an eval key
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const evalNeed = (eb: ExpressionBuilder<any, any>) => eb.or([eb('task_id', 'in', evalTasks), eb('credential_key', 'in', evalKeyText)]);
    const evalLabels = new Map<string, Set<string>>();
    for (const r of await db.selectFrom('unmet_needs').select(['group_id', 'intent']).where(evalNeed).execute()) {
      const set = evalLabels.get(r.group_id) ?? new Set<string>();
      set.add(String(r.intent).slice(0, 200));
      evalLabels.set(r.group_id, set);
    }
    await db.deleteFrom('unmet_needs').where(evalNeed).execute();
    await db.deleteFrom('issues').where('task_id', 'in', evalTasks).execute();

    for (const [groupId, labels] of evalLabels) {
      const agg = await db
        .selectFrom('unmet_needs')
        .select([sql<number>`count(*)`.as('n'), sql<number>`count(distinct credential_key)`.as('p'), sql<number | null>`min(created_at)`.as('f'), sql<number | null>`max(created_at)`.as('l')])
        .where('group_id', '=', groupId)
        .executeTakeFirst();
      const n = Number(agg?.n ?? 0);
      if (n === 0) {
        await db.deleteFrom('need_groups').where('id', '=', groupId).execute();
        continue;
      }
      const g = await db.selectFrom('need_groups').select(['label']).where('id', '=', groupId).executeTakeFirst();
      const oldest = await db.selectFrom('unmet_needs').select('intent').where('group_id', '=', groupId).orderBy('created_at', 'asc').orderBy('id', 'asc').limit(1).executeTakeFirst();
      const relabel = g && oldest && labels.has(g.label) ? { label: String(oldest.intent).slice(0, 200) } : {};
      await db
        .updateTable('need_groups')
        .set({ count: n, distinct_principals: Number(agg?.p ?? 0), first_seen_at: Number(agg!.f), last_seen_at: Number(agg!.l), ...relabel })
        .where('id', '=', groupId)
        .execute();
    }
  },
  async down(db) {
    await db.schema.dropIndex('ix_tasks_origin').ifExists().execute();
    await db.schema.alterTable('tasks').dropColumn('origin').execute();
  },
};
