import { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { api, type AuditRow as AuditRowApi, type AuditVerifyResult } from '@neurouter/shared';
import { csvHeader, csvLine, ndjsonLine } from '../../../kernel/audit/export.js';
import type { AuditQuery, AuditRow } from '../../../kernel/audit/types.js';
import { fromIso, toIso } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, encodeCursor } from '../../../kernel/lib/pagination.js';
import { requireUser } from '../../auth/guards.js';
import { TracesService } from '../../traces/traces.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { range } from './tasks.js';

export const AUDIT_EXPORT_ROW_CAP = 100_000;

type Filters = { from?: string | undefined; to?: string | undefined; serverId?: string | undefined; environmentId?: string | undefined; kind?: AuditRow['kind'][] | undefined; decision?: AuditRow['decision'][] | undefined; status?: AuditRow['status'][] | undefined; tool?: string | undefined; principal?: string | undefined; taskId?: string | undefined; scriptRunId?: string | undefined; via?: string | undefined; q?: string | undefined; order?: 'asc' | 'desc' | undefined };

const asObj = (v: unknown): Record<string, unknown> | null => (v === null || v === undefined ? null : typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v });

/** `audit.*` (§14.12; ADAPT Hub audit.service.ts). */
export async function auditRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const tr = new TracesService(c);
  const toQuery = (f: Filters): Omit<AuditQuery, 'limit' | 'cursorSeq'> => {
    const { from, to } = range(f, c.clock.now());
    return {
      from,
      to,
      ...(f.serverId ? { serverIds: [f.serverId] } : {}),
      ...(f.environmentId ? { environmentId: f.environmentId } : {}),
      ...(f.kind?.length ? { kinds: f.kind } : {}),
      ...(f.decision?.length ? { decisions: f.decision } : {}),
      ...(f.status?.length ? { statuses: f.status } : {}),
      ...(f.tool ? { toolName: f.tool } : {}),
      ...(f.principal ? { principal: f.principal } : {}),
      ...(f.taskId ? { taskId: f.taskId } : {}),
      ...(f.scriptRunId ? { scriptRunId: f.scriptRunId } : {}),
      ...(f.via ? { via: f.via } : {}),
      ...(f.q ? { q: f.q } : {}),
      ...(f.order ? { order: f.order } : {}),
    };
  };
  const row = async (r: AuditRow): Promise<AuditRowApi> => {
    const refs = await tr.refs(r.server_id, r.environment_id);
    return {
      id: r.id,
      seq: Number(r.seq),
      ts: toIso(Number(r.ts)),
      kind: r.kind,
      principal: await tr.principal(r.principal_type, r.user_id, r.api_key_id, r.credential_key),
      client: r.client_name ? { name: r.client_name, version: r.client_version } : null,
      server: refs.server,
      environment: refs.environment,
      tool: r.tool_name,
      via: (r.via ?? null) as AuditRowApi['via'],
      mode: (r.mode ?? null) as AuditRowApi['mode'],
      decision: r.decision,
      decisionReason: r.decision_reason,
      status: r.status,
      write: Number(r.write) === 1,
      dryRun: Number(r.dry_run) === 1,
      confirm: (r.confirm ?? 'none') as AuditRowApi['confirm'],
      latencyMs: r.latency_ms === null ? null : Number(r.latency_ms),
      errorId: r.error_id,
      errorMessage: r.error_message,
      taskId: r.task_id,
      scriptRunId: r.script_run_id,
      traceId: r.trace_id,
      action: r.action,
    };
  };

  route(app, 'audit.list', api.audit.list, async (req) => {
    await c.auditStore.flush().catch(() => {});
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    const { rows, nextSeq } = await c.auditStore.query({ ...toQuery(req.query), limit, cursorSeq: key ? Number(key[0]) : null });
    return { items: await Promise.all(rows.map(row)), nextCursor: nextSeq === null ? null : encodeCursor([nextSeq]) };
  });

  route(app, 'audit.get', api.audit.get, async (req) => {
    await c.auditStore.flush().catch(() => {});
    const r = await c.auditStore.get(req.params.id);
    if (!r || r.tenant_id !== c.tenantId) throw AppError.notFound('Audit event');
    const changes = parseJsonColumn<{ before?: unknown; after?: unknown }>(r.changes);
    return {
      ...(await row(r)),
      params: parseJsonColumn(r.params_redacted),
      outputPreview: parseJsonColumn(r.output_preview),
      outputSize: r.output_size === null ? null : Number(r.output_size),
      outputHash: r.output_hash,
      upstreamStatus: r.upstream_status === null ? null : Number(r.upstream_status),
      upstreamLatencyMs: r.upstream_latency_ms === null ? null : Number(r.upstream_latency_ms),
      policyTrail: (parseJsonColumn<AuditRowApi[]>(r.policy_trail) ?? []) as never,
      changes: changes ? { before: asObj(changes.before), after: asObj(changes.after) } : null,
      target: r.target_type ? { type: r.target_type, id: r.target_id ?? '' } : null,
      ip: r.ip,
      userAgent: r.user_agent,
      spanId: r.span_id,
      protocolVersion: r.protocol_version,
      chain: { seq: Number(r.seq), prevHash: r.prev_hash, hash: r.hash },
    };
  });

  route(app, 'audit.export', api.audit.export, async (req, reply) => {
    const u = requireUser(req);
    await c.auditStore.flush().catch(() => {});
    const query = toQuery(req.query);
    const total = await c.auditStore.count(query, AUDIT_EXPORT_ROW_CAP);
    const truncated = total > AUDIT_EXPORT_ROW_CAP;
    c.audit.admin({ actorUserId: u.id, action: 'audit.export', targetType: 'audit', targetId: null, after: { format: req.query.format, rows: Math.min(total, AUDIT_EXPORT_ROW_CAP), truncated } });
    const csv = req.query.format === 'csv';
    const stamp = new Date(c.clock.now()).toISOString().replace(/[:.]/g, '-');
    reply
      .header('content-type', csv ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
      .header('content-disposition', `attachment; filename="neurouter-audit-${stamp}.${csv ? 'csv' : 'ndjson'}"`)
      .header('cache-control', 'no-store');
    if (truncated) reply.header('x-truncated', 'true');
    const rows = c.auditStore.export(query, AUDIT_EXPORT_ROW_CAP);
    async function* lines(): AsyncGenerator<string> {
      if (csv) yield csvHeader();
      for await (const r of rows) yield csv ? csvLine(r) : ndjsonLine(r);
    }
    return reply.status(200).send(Readable.from(lines()));
  });

  route(app, 'audit.verify', api.audit.verify, async (req, reply) => {
    const u = requireUser(req);
    const from = req.body.from ? fromIso(req.body.from) : undefined;
    const to = req.body.to ? fromIso(req.body.to) : undefined;
    if (from !== undefined && to !== undefined && to <= from) throw AppError.validation('`to` must be after `from`', [{ path: ['to'], message: 'Must be after from', code: 'invalid_range' }]);
    const jobId = await c.jobs.start('audit_verify', { from: req.body.from ?? null, to: req.body.to ?? null }, u.id, async (): Promise<AuditVerifyResult> => {
      await c.auditStore.flush();
      const rangeSeq = from !== undefined || to !== undefined ? await c.auditStore.seqRange(from, to) : {};
      if (rangeSeq === null) return { ok: true, checked: 0, fromSeq: null, toSeq: null, checkpointsVerified: 0, firstBrokenSeq: null, reason: null };
      const out = await c.auditStore.verify(rangeSeq);
      c.audit.system('audit.verify', { reason: out.ok ? 'ok' : (out.brokenAt?.reason ?? 'broken') });
      return { ok: out.ok, checked: out.checked, fromSeq: out.firstSeq, toSeq: out.lastSeq, checkpointsVerified: out.checkpointsVerified, firstBrokenSeq: out.brokenAt?.seq ?? null, reason: out.brokenAt?.reason ?? null };
    });
    reply.status(202);
    return { jobId, status: 'running' as const };
  });
}
