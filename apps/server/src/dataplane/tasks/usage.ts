import { sql, type Kysely } from 'kysely';
import type { CommittedAuditRow } from '../../kernel/audit/writer.js';
import type { MainDB } from '../../kernel/db/schema.js';

/**
 * `usage_daily` (§7.2): calls / errors / script calls per (environment, tool, day), from committed audit rows.
 *
 * Eval traffic is excluded: it is synthetic (the eval runner's per-attempt keys against mock/dev
 * environments), `usage_daily` is what billing and pinned-by-usage read, and eval cost is accounted
 * separately (`eval_runs.usage` tokens, `eval_task_runs.tool_calls`). Direct eval calls carry
 * `via = 'eval'`; calls inside an eval agent's scripts carry `via = 'script'`, so those are matched by
 * their API key's purpose. The audit log keeps every eval call (the scorer reads it).
 */
export async function recordUsage(db: Kysely<MainDB>, rows: readonly CommittedAuditRow[]): Promise<void> {
  const keyRows = rows.filter((r) => r.kind === 'tool_call' && r.api_key_id && r.via !== 'eval');
  const keyIds = [...new Set(keyRows.map((r) => r.api_key_id!))];
  const tenantIds = [...new Set(keyRows.map((r) => r.tenant_id))];
  const evalKeys = new Set(keyIds.length ? (await db.selectFrom('api_keys').select('id').where('tenant_id', 'in', tenantIds).where('id', 'in', keyIds).where('purpose', '=', 'eval').execute()).map((k) => k.id) : []);
  const agg = new Map<string, { tenant: string; server: string; env: string; tool: string; day: string; calls: number; errors: number; script: number }>();
  for (const r of rows) {
    if (r.kind !== 'tool_call' || !r.environment_id || !r.server_id || !r.tool_name) continue;
    if (r.via === 'eval' || (r.api_key_id && evalKeys.has(r.api_key_id))) continue;
    const day = new Date(Number(r.ts)).toISOString().slice(0, 10);
    const k = `${r.environment_id}|${r.tool_name}|${day}`;
    const a = agg.get(k) ?? { tenant: r.tenant_id, server: r.server_id, env: r.environment_id, tool: r.tool_name, day, calls: 0, errors: 0, script: 0 };
    a.calls++;
    if (r.status !== 'ok') a.errors++;
    if (r.via === 'script') a.script++;
    agg.set(k, a);
  }
  for (const a of agg.values()) {
    await db
      .insertInto('usage_daily')
      .values({ tenant_id: a.tenant, server_id: a.server, environment_id: a.env, tool_name: a.tool, day: a.day, calls: a.calls, errors: a.errors, script_calls: a.script })
      .onConflict((oc) =>
        oc.columns(['tenant_id', 'environment_id', 'tool_name', 'day']).doUpdateSet({
          calls: sql`usage_daily.calls + ${a.calls}`,
          errors: sql`usage_daily.errors + ${a.errors}`,
          script_calls: sql`usage_daily.script_calls + ${a.script}`,
        }),
      )
      .execute();
  }
}

/** Top-N tools by 7-day calls for an environment (pinned-by-usage, §9.4). */
export async function topToolsByUsage(db: Kysely<MainDB>, environmentId: string, sinceDay: string, n = 5): Promise<string[]> {
  // tenant-scope: child-of-scoped (environment id of a tenant-scoped bundle)
  const rows = await db.selectFrom('usage_daily').select(['tool_name', (eb) => eb.fn.sum<number>('calls').as('c')]).where('environment_id', '=', environmentId).where('day', '>=', sinceDay).groupBy('tool_name').orderBy('c', 'desc').limit(n).execute();
  return rows.map((r) => r.tool_name);
}
