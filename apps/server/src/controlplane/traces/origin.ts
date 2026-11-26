import { sql, type Expression, type Kysely, type SqlBool } from 'kysely';
import type { MainDB } from '../../kernel/db/schema.js';

/**
 * Defense in depth for eval traffic (see `RunContext.origin`): ops tools no longer record eval
 * reports, and migration 0010 removed the old ones, but inbox and analytics queries still exclude
 * any eval-origin row that exists. The subqueries are scoped to the caller's tenant (the outer query
 * is too). A row is eval-origin when its task is an eval task
 * (`tasks.origin`) or, for unmet needs, its credential is an eval API key.
 */
const evalTaskIds = (db: Kysely<MainDB>, tenantId: string) => db.selectFrom('tasks').select('id').where('tenant_id', '=', tenantId).where('origin', '=', 'eval');
// credential_key is text; api_keys.id is uuid on Postgres
const evalKeyIds = (db: Kysely<MainDB>, tenantId: string) => db.selectFrom('api_keys').select(sql<string>`cast(id as text)`.as('id')).where('tenant_id', '=', tenantId).where('purpose', '=', 'eval');

const col = (prefix: string, name: string) => sql.ref(prefix ? `${prefix}.${name}` : name);

/** An `unmet_needs` row (optionally aliased) of tenant `tenantId` that is not eval-origin. */
export function liveNeed(db: Kysely<MainDB>, tenantId: string, alias = ''): Expression<SqlBool> {
  return sql<SqlBool>`((${col(alias, 'task_id')} is null or ${col(alias, 'task_id')} not in (${evalTaskIds(db, tenantId)})) and ${col(alias, 'credential_key')} not in (${evalKeyIds(db, tenantId)}))`;
}

/** An `issues` row (optionally aliased) of tenant `tenantId` that is not eval-origin. */
export function liveIssue(db: Kysely<MainDB>, tenantId: string, alias = ''): Expression<SqlBool> {
  return sql<SqlBool>`(${col(alias, 'task_id')} is null or ${col(alias, 'task_id')} not in (${evalTaskIds(db, tenantId)}))`;
}

/**
 * A `need_groups` row that is not eval-only: it has a live report, or no eval report at all (groups
 * whose reports all expired under retention keep showing, as before).
 */
export function notEvalOnlyGroup(db: Kysely<MainDB>, tenantId: string, groupId = 'need_groups.id'): Expression<SqlBool> {
  const g = sql.ref(groupId);
  return sql<SqlBool>`(exists (select 1 from unmet_needs x where x.tenant_id = ${tenantId} and x.group_id = ${g} and ${liveNeed(db, tenantId, 'x')}) or not exists (select 1 from unmet_needs x where x.tenant_id = ${tenantId} and x.group_id = ${g}))`;
}
