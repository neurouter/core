import type { FastifyInstance } from 'fastify';
import { sql } from 'kysely';
import { api, DEFAULT_TIME_RANGE_MS, type ScriptRunDetail } from '@neurouter/shared';
import type { AuditLogTable } from '../../../kernel/db/schema.js';
import { fromIso, toIso, toIsoOrNull } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, encodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { TracesService } from '../../traces/traces.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';

export function range(q: { from?: string | undefined; to?: string | undefined }, now: number): { from: number; to: number } {
  const to = q.to ? fromIso(q.to) : now;
  const from = q.from ? fromIso(q.from) : to - DEFAULT_TIME_RANGE_MS;
  if (to <= from) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
  return { from, to };
}

/** `tasks.*`, `calls.get`, `scripts.get` (§14.9). */
export async function taskRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const tr = new TracesService(c);

  route(app, 'tasks.list', api.tasks.list, async (req) => {
    const q = req.query;
    const { from, to } = range(q, c.clock.now());
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = db.selectFrom('tasks').selectAll().where('tenant_id', '=', c.tenantId).where('started_at', '>=', from).where('started_at', '<', to);
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.environmentId) qb = qb.where('environment_id', '=', q.environmentId);
    if (q.status) qb = qb.where('status', '=', q.status);
    if (q.outcome?.length) {
      const outs = q.outcome.filter((o) => o !== 'inferred') as Array<'success' | 'partial' | 'failure' | 'abandoned' | 'unknown'>;
      const inferred = q.outcome.includes('inferred');
      qb = qb.where((eb) => eb.or([...(outs.length ? [eb('outcome', 'in', outs)] : []), ...(inferred ? [eb('framing', '=', 'inferred')] : [])]));
    }
    if (q.framing?.length) qb = qb.where('framing', 'in', q.framing);
    if (q.principal) qb = qb.where((eb) => eb.or([eb('api_key_id', '=', q.principal!), eb('user_id', '=', q.principal!), eb('credential_key', '=', q.principal!)]));
    if (q.client) qb = qb.where('client_name', '=', q.client);
    if (q.q) qb = qb.where('goal', 'like', `%${q.q}%`);
    if (q.hasErrors !== undefined) qb = q.hasErrors ? qb.where('error_count', '>', 0) : qb.where('error_count', '=', 0);
    if (q.hasWrites !== undefined) qb = q.hasWrites ? qb.where('write_count', '>', 0) : qb.where('write_count', '=', 0);
    if (q.origin) {
      const evalKeys = db.selectFrom('api_keys').select('id').where('purpose', '=', 'eval');
      qb = q.origin === 'eval' ? qb.where('api_key_id', 'in', evalKeys) : qb.where((eb) => eb.or([eb('api_key_id', 'is', null), eb('api_key_id', 'not in', evalKeys)]));
    }
    if (q.tool) {
      const ids = await c.dbs.audit.db.selectFrom('audit_log').select('task_id').distinct().where('tool_name', '=', q.tool).where('ts', '>=', from).where('task_id', 'is not', null).limit(5000).execute();
      const set = ids.map((r) => r.task_id!).filter(Boolean);
      qb = qb.where('id', 'in', set.length ? set : ['-']);
    }
    if (key) qb = qb.where((eb) => eb.or([eb('started_at', '<', Number(key[0])), eb.and([eb('started_at', '=', Number(key[0])), eb('id', '<', String(key[1]))])]));
    const rows = await qb.orderBy('started_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.started_at, r.id]);
    return { items: await Promise.all(page.items.map((r) => tr.taskRow(r))), nextCursor: page.nextCursor };
  });

  const taskOr404 = async (id: string) => {
    const t = await db.selectFrom('tasks').selectAll().where('id', '=', id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!t) throw AppError.notFound('Task');
    return t;
  };

  route(app, 'tasks.get', api.tasks.get, async (req) => {
    const t = await taskOr404(req.params.id);
    const tl = await tr.timeline(t.id);
    const [needs, issues, evalRun] = await Promise.all([
      db.selectFrom('unmet_needs').select(['id', 'group_id', 'intent', 'created_at']).where('task_id', '=', t.id).execute(),
      db.selectFrom('issues').select(['id', 'tool_name', 'problem', 'status', 'created_at']).where('task_id', '=', t.id).execute(),
      db.selectFrom('eval_task_runs').select('run_id').where('task_id_neurouter', '=', t.id).executeTakeFirst(),
    ]);
    return {
      ...(await tr.taskRow(t)),
      notes: t.notes,
      traceId: t.trace_id,
      timeline: tl.items.slice(0, 200),
      truncated: tl.truncated || tl.items.length > 200,
      unmetNeeds: needs.map((n) => ({ id: n.id, groupId: n.group_id, intent: n.intent, createdAt: toIso(n.created_at) })),
      issues: issues.map((i) => ({ id: i.id, tool: i.tool_name, problem: i.problem, status: i.status, createdAt: toIso(i.created_at) })),
      evalRunId: evalRun?.run_id ?? null,
    };
  });

  route(app, 'tasks.events', api.tasks.events, async (req) => {
    const t = await taskOr404(req.params.id);
    const tl = await tr.timeline(t.id);
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    const offset = key ? Number(key[0]) : 0;
    const items = tl.items.slice(offset, offset + limit);
    return { items, nextCursor: offset + limit < tl.items.length ? encodeCursor([offset + limit]) : null };
  });

  route(app, 'calls.get', api.calls.get, async (req) => {
    await c.auditStore.flush().catch(() => {});
    const a = (await c.auditStore.get(req.params.auditId)) as AuditLogTable | null;
    if (!a || a.tenant_id !== c.tenantId) throw AppError.notFound('Call');
    return tr.callDetail(a);
  });

  route(app, 'scripts.get', api.scripts.get, async (req) => {
    const r = await db.selectFrom('script_runs').selectAll().where('id', '=', req.params.id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!r) throw AppError.notFound('Script run');
    await c.auditStore.flush().catch(() => {});
    const inner = (await c.dbs.audit.db.selectFrom('audit_log').selectAll().where('script_run_id', '=', r.id).where('kind', '=', 'tool_call').orderBy('seq').limit(500).execute()) as AuditLogTable[];
    const refs = await tr.refs(r.server_id, r.environment_id);
    const recipe = await db.selectFrom('script_runs').select((eb) => eb.fn.countAll<number>().as('n')).where('code_hash', '=', r.code_hash).executeTakeFirst();
    const err = parseJsonColumn<Record<string, unknown>>(r.error);
    const stats = parseJsonColumn<Record<string, number>>(r.stats);
    const planned = parseJsonColumn<Array<Record<string, unknown>>>(r.planned_changes) ?? [];
    const out: ScriptRunDetail = {
      id: r.id,
      taskId: r.task_id,
      server: refs.server!,
      environment: refs.environment!,
      mode: r.mode,
      status: r.status as ScriptRunDetail['status'],
      code: r.code,
      codeHash: r.code_hash,
      error: err ? { type: String(err.type ?? 'error'), message: String(err.message ?? ''), ...(typeof err.line === 'number' ? { line: err.line } : {}), ...(typeof err.col === 'number' ? { col: err.col } : {}), ...(typeof err.hint === 'string' ? { hint: err.hint } : {}), ...(typeof err.traceback === 'string' ? { traceback: err.traceback } : {}) } : null,
      resultPreview: parseJsonColumn(r.result_preview),
      resultBytes: r.result_bytes,
      resultHandle: r.result_handle,
      stdout: r.stdout,
      plannedChanges: planned.map((p) => ({ tool: String(p.tool ?? ''), method: typeof p.method === 'string' ? p.method : null, path: typeof p.path === 'string' ? p.path : null, arguments: (p.arguments as Record<string, unknown>) ?? {}, wouldConfirm: Boolean(p.wouldConfirm) })),
      stats: stats && Object.keys(stats).length ? { wallMs: Math.round(stats.wallMs ?? 0), toolCalls: stats.toolCalls ?? 0, blockedCalls: stats.blockedCalls ?? 0, suspensions: stats.suspensions ?? 0, ...(stats.cpuMs !== undefined ? { cpuMs: Math.round(stats.cpuMs) } : {}), ...(stats.peakMemoryBytes !== undefined ? { peakMemoryBytes: stats.peakMemoryBytes } : {}) } : null,
      phases: (parseJsonColumn<ScriptRunDetail['phases']>(r.phases) ?? []).map((p) => ({ name: p.name, status: p.status, durationMs: p.durationMs === null ? null : Math.round(p.durationMs) })),
      calls: inner.map((a) => tr.item(a)),
      auditId: r.audit_id,
      traceId: r.trace_id,
      startedAt: toIso(r.started_at),
      endedAt: toIsoOrNull(r.ended_at),
      recipeCount: Number(recipe?.n ?? 1),
    };
    return out;
  });
  void sql;
}
