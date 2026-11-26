import { sql, type Kysely } from 'kysely';
import type { CommittedAuditRow } from '../../kernel/audit/writer.js';
import type { MainDB } from '../../kernel/db/schema.js';

/** `usage_daily` (§7.2): calls / errors / script calls per (environment, tool, day), from committed audit rows. */
export async function recordUsage(db: Kysely<MainDB>, rows: readonly CommittedAuditRow[]): Promise<void> {
  const agg = new Map<string, { tenant: string; server: string; env: string; tool: string; day: string; calls: number; errors: number; script: number }>();
  for (const r of rows) {
    if (r.kind !== 'tool_call' || !r.environment_id || !r.server_id || !r.tool_name) continue;
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
  const rows = await db.selectFrom('usage_daily').select(['tool_name', (eb) => eb.fn.sum<number>('calls').as('c')]).where('environment_id', '=', environmentId).where('day', '>=', sinceDay).groupBy('tool_name').orderBy('c', 'desc').limit(n).execute();
  return rows.map((r) => r.tool_name);
}
