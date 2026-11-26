import type { FastifyInstance } from 'fastify';
import { api, type OverviewKpis } from '@neurouter/shared';
import { toIso } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { liveIssue, notEvalOnlyGroup } from '../../traces/origin.js';
import { TracesService } from '../../traces/traces.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { range } from './tasks.js';

const ROW_CAP = 200_000;

function pct(values: number[], p: number): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))]!;
}

/** `metrics.*` (§14.3): computed from audit_log + tasks over the requested range (correct over clever). */
export async function metricsRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const adb = c.dbs.audit.db;
  const tr = new TracesService(c);

  const calls = async (from: number, to: number, f: { serverId?: string | undefined; environmentId?: string | undefined; tool?: string | undefined }, kinds: Array<'tool_call' | 'script_run'> = ['tool_call']) => {
    await c.auditStore.flush().catch(() => {});
    let qb = adb.selectFrom('audit_log').select(['ts', 'kind', 'status', 'decision', 'tool_name', 'server_id', 'environment_id', 'mode', 'latency_ms', 'error_code', 'error_id']).where('tenant_id', '=', c.tenantId).where('ts', '>=', from).where('ts', '<', to).where('kind', 'in', kinds);
    if (f.serverId) qb = qb.where('server_id', '=', f.serverId);
    if (f.environmentId) qb = qb.where('environment_id', '=', f.environmentId);
    if (f.tool) qb = qb.where('tool_name', '=', f.tool);
    return qb.limit(ROW_CAP).execute();
  };

  const kpis = async (from: number, to: number, f: { serverId?: string | undefined; environmentId?: string | undefined }): Promise<OverviewKpis> => {
    const rows = await calls(from, to, f, ['tool_call', 'script_run']);
    const toolCalls = rows.filter((r) => r.kind === 'tool_call');
    const blocked = toolCalls.filter((r) => r.decision.startsWith('denied_')).length;
    const errors = toolCalls.filter((r) => r.status !== 'ok' && !r.decision.startsWith('denied_')).length;
    let tq = db.selectFrom('tasks').select(['outcome', 'status']).where('tenant_id', '=', c.tenantId).where('origin', '=', 'live').where('started_at', '>=', from).where('started_at', '<', to);
    if (f.serverId) tq = tq.where('server_id', '=', f.serverId);
    if (f.environmentId) tq = tq.where('environment_id', '=', f.environmentId);
    const tasks = await tq.execute();
    const decided = tasks.filter((t) => t.outcome === 'success' || t.outcome === 'partial' || t.outcome === 'failure');
    const openCount = async (table: 'need_groups' | 'issues') => {
      let qb = db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', c.tenantId).where('status', '=', 'open').where(table === 'need_groups' ? notEvalOnlyGroup(db) : liveIssue(db));
      if (f.serverId) qb = qb.where('server_id', '=', f.serverId);
      return Number((await qb.executeTakeFirst())?.n ?? 0);
    };
    return {
      tasks: tasks.length,
      taskSuccessRate: decided.length ? decided.filter((t) => t.outcome === 'success').length / decided.length : null,
      calls: toolCalls.length,
      errorRate: toolCalls.length ? errors / toolCalls.length : null,
      blockedCalls: blocked,
      scriptRuns: rows.filter((r) => r.kind === 'script_run').length,
      unmetNeedsOpen: await openCount('need_groups'),
      issuesOpen: await openCount('issues'),
    };
  };

  route(app, 'metrics.overview', api.metrics.overview, async (req) => {
    const q = req.query;
    const { from, to } = range(q, c.clock.now());
    const f = { serverId: q.serverId, environmentId: q.environmentId };
    const span = to - from;
    const [cur, prev] = await Promise.all([kpis(from, to, f), kpis(from - span, from, f)]);
    const rows = await calls(from, to, f);
    const byTool = new Map<string, { tool: string; serverId: string; calls: number; errors: number; lat: number[] }>();
    const errs = new Map<string, number>();
    for (const r of rows) {
      if (!r.tool_name || !r.server_id) continue;
      const k = `${r.server_id}|${r.tool_name}`;
      const t = byTool.get(k) ?? { tool: r.tool_name, serverId: r.server_id, calls: 0, errors: 0, lat: [] };
      t.calls++;
      if (r.status !== 'ok') t.errors++;
      if (r.latency_ms !== null) t.lat.push(Number(r.latency_ms));
      byTool.set(k, t);
      if (r.error_code) errs.set(r.error_code, (errs.get(r.error_code) ?? 0) + 1);
    }
    let sq = db.selectFrom('servers').selectAll().where('tenant_id', '=', c.tenantId).where('status', '=', 'active');
    if (q.serverId) sq = sq.where('id', '=', q.serverId);
    const servers = await sq.execute();
    const readiness = [];
    for (const s of servers) {
      const r = await c.views.readiness(s);
      if (r) readiness.push({ ...r, serverId: s.id, serverSlug: s.slug, serverName: s.name });
    }
    let rq = db.selectFrom('tasks').selectAll().where('tenant_id', '=', c.tenantId).where('origin', '=', 'live');
    if (q.serverId) rq = rq.where('server_id', '=', q.serverId);
    if (q.environmentId) rq = rq.where('environment_id', '=', q.environmentId);
    const recent = await rq.orderBy('started_at', 'desc').limit(5).execute();
    return {
      kpis: cur,
      previous: prev,
      readiness,
      topTools: [...byTool.values()].sort((a, b) => b.calls - a.calls).slice(0, 10).map((t) => ({ tool: t.tool, serverId: t.serverId, calls: t.calls, errorRate: t.calls ? t.errors / t.calls : 0, p95Ms: pct(t.lat, 95) })),
      topErrors: [...errs].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([code, count]) => ({ code, count })),
      recentTasks: await Promise.all(recent.map((t) => tr.taskRow(t))),
      from: toIso(from),
      to: toIso(to),
    };
  });

  route(app, 'metrics.timeseries', api.metrics.timeseries, async (req) => {
    const q = req.query;
    const { from, to } = range(q, c.clock.now());
    const span = to - from;
    const bucket = q.bucket ?? (span <= 6 * 3_600_000 ? 'minute' : span <= 7 * 86_400_000 ? 'hour' : 'day');
    const size = bucket === 'minute' ? 60_000 : bucket === 'hour' ? 3_600_000 : 86_400_000;
    if (span / size > 5000) throw AppError.validation('Too many buckets; use a coarser bucket', [{ path: ['bucket'], message: 'too fine for this range', code: 'too_many_buckets' }]);
    const start = Math.floor(from / size) * size;
    const n = Math.ceil((to - start) / size);
    const series = new Map<string, Array<{ c: number; e: number; lat: number[]; ok: number; dec: number }>>();
    const slot = (key: string, t: number) => {
      let s = series.get(key);
      if (!s) {
        s = Array.from({ length: n }, () => ({ c: 0, e: 0, lat: [], ok: 0, dec: 0 }));
        series.set(key, s);
      }
      return s[Math.min(n - 1, Math.max(0, Math.floor((t - start) / size)))]!;
    };
    if (q.metric === 'tasks' || q.metric === 'task_success') {
      let tq = db.selectFrom('tasks').select(['started_at', 'outcome', 'environment_id']).where('tenant_id', '=', c.tenantId).where('origin', '=', 'live').where('started_at', '>=', from).where('started_at', '<', to);
      if (q.serverId) tq = tq.where('server_id', '=', q.serverId);
      if (q.environmentId) tq = tq.where('environment_id', '=', q.environmentId);
      for (const t of await tq.execute()) {
        const k = q.groupBy === 'environment' ? t.environment_id : q.groupBy === 'status' ? (t.outcome ?? 'open') : 'all';
        const s = slot(k, t.started_at);
        s.c++;
        if (t.outcome === 'success' || t.outcome === 'partial' || t.outcome === 'failure') s.dec++;
        if (t.outcome === 'success') s.ok++;
      }
    } else {
      for (const r of await calls(from, to, { serverId: q.serverId, environmentId: q.environmentId })) {
        const k = q.groupBy === 'mode' ? (r.mode ?? 'tool') : q.groupBy === 'environment' ? (r.environment_id ?? '') : q.groupBy === 'status' ? r.status : 'all';
        const s = slot(k, Number(r.ts));
        s.c++;
        if (r.status !== 'ok') s.e++;
        if (r.latency_ms !== null) s.lat.push(Number(r.latency_ms));
      }
    }
    if (!series.size) series.set('all', Array.from({ length: n }, () => ({ c: 0, e: 0, lat: [], ok: 0, dec: 0 })));
    const val = (s: { c: number; e: number; lat: number[]; ok: number; dec: number }): number | null => {
      switch (q.metric) {
        case 'calls':
        case 'tasks':
          return s.c;
        case 'errors':
          return s.e;
        case 'latency_p95':
          return pct(s.lat, 95);
        case 'task_success':
          return s.dec ? s.ok / s.dec : null;
      }
    };
    return { metric: q.metric, bucket, series: [...series].map(([key, pts]) => ({ key, points: pts.map((p, i) => ({ t: toIso(start + i * size), v: val(p) })) })) };
  });

  route(app, 'metrics.toolUsage', api.metrics.toolUsage, async (req) => {
    const t = await db.selectFrom('tools').select(['name', 'server_id']).where('id', '=', req.params.id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!t) throw AppError.notFound('Tool');
    const { from, to } = range(req.query, c.clock.now());
    const rows = await calls(from, to, { serverId: t.server_id, environmentId: req.query.environmentId, tool: t.name });
    const envs = await db.selectFrom('environments').select(['id', 'slug']).where('server_id', '=', t.server_id).execute();
    const envSlug = new Map(envs.map((e) => [e.id, e.slug]));
    const byStatus: Record<string, number> = {};
    const byEnvironment: Record<string, number> = {};
    const byMode: Partial<Record<'tool' | 'code', number>> = {};
    const lat: number[] = [];
    for (const r of rows) {
      byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
      const e = envSlug.get(r.environment_id ?? '') ?? 'unknown';
      byEnvironment[e] = (byEnvironment[e] ?? 0) + 1;
      const m = r.mode === 'code' ? 'code' : 'tool';
      byMode[m] = (byMode[m] ?? 0) + 1;
      if (r.latency_ms !== null) lat.push(Number(r.latency_ms));
    }
    const recentErrors = rows.filter((r) => r.error_id).sort((a, b) => Number(b.ts) - Number(a.ts)).slice(0, 10).map((r) => ({ errorId: r.error_id!, code: r.error_code ?? 'error', ts: toIso(Number(r.ts)) }));
    return { calls: rows.length, errors: rows.filter((r) => r.status !== 'ok').length, p50Ms: pct(lat, 50), p95Ms: pct(lat, 95), byStatus, byEnvironment, byMode, recentErrors };
  });
}
