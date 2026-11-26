import type { Selectable } from 'kysely';
import { ERROR_CATALOG, fillTemplate, type CallDetail, type ErrorCode, type PrincipalView, type TaskRow, type TimelineItem } from '@neurouter/shared';
import type { AuditLogTable, TasksTable } from '../../kernel/db/schema.js';
import { toIso, toIsoOrNull } from '../../kernel/lib/clock.js';
import { parseJsonColumn } from '../../kernel/lib/json.js';
import type { ApiContext } from '../api/context.js';
import { DELETED } from '../api/views.js';

type Task = Selectable<TasksTable>;
type Audit = AuditLogTable;

export const TIMELINE_CAP = 2000;

const bool = (v: unknown) => Number(v) === 1 || v === true;

/** Tasks, calls and scripts for the console (§12.2, §14.9). */
export class TracesService {
  private readonly names = new Map<string, string>();
  constructor(private readonly c: ApiContext) {}

  private get db() {
    return this.c.dbs.main.db;
  }

  async principal(type: string | null, userId: string | null, apiKeyId: string | null, credentialKey: string | null): Promise<PrincipalView | null> {
    if (type === 'api_key' && apiKeyId) {
      const k = await this.db.selectFrom('api_keys').select(['name']).where('id', '=', apiKeyId).executeTakeFirst();
      return { type: 'api_key', id: apiKeyId, name: k?.name ?? DELETED };
    }
    if ((type === 'user' || !type) && userId) {
      const u = await this.db.selectFrom('users').select(['name', 'email']).where('id', '=', userId).executeTakeFirst();
      return { type: 'user', id: userId, name: u ? u.email : DELETED };
    }
    if (type === 'external' && credentialKey) return { type: 'external', id: credentialKey, name: credentialKey.split('|').pop() ?? credentialKey };
    return null;
  }

  async refs(serverId: string | null, environmentId: string | null) {
    const s = serverId ? await this.db.selectFrom('servers').select(['id', 'slug', 'name']).where('id', '=', serverId).executeTakeFirst() : null;
    const e = environmentId ? await this.db.selectFrom('environments').select(['id', 'slug', 'name', 'kind']).where('id', '=', environmentId).executeTakeFirst() : null;
    return { server: s ?? (serverId ? { id: serverId, slug: '', name: DELETED } : null), environment: e ?? (environmentId ? { id: environmentId, slug: '', name: DELETED, kind: 'dev' as const } : null) };
  }

  async taskRow(t: Task): Promise<TaskRow> {
    const r = await this.refs(t.server_id, t.environment_id);
    let origin: 'agent' | 'eval' = 'agent';
    if (t.api_key_id) {
      const k = await this.db.selectFrom('api_keys').select('purpose').where('id', '=', t.api_key_id).executeTakeFirst();
      if (k?.purpose === 'eval') origin = 'eval';
    }
    const p = (await this.principal(t.principal_type, t.user_id, t.api_key_id, t.credential_key)) ?? { type: 'api_key' as const, id: t.credential_key, name: DELETED };
    const label = parseJsonColumn<TaskRow['inferredLabel']>(t.inferred_label);
    return {
      id: t.id,
      goal: t.goal,
      outcome: t.outcome,
      framing: t.framing,
      inferredLabel: label ?? null,
      status: t.status,
      origin,
      server: r.server!,
      environment: r.environment!,
      principal: p,
      client: { name: t.client_name, version: t.client_version },
      startedAt: toIso(t.started_at),
      endedAt: toIsoOrNull(t.ended_at),
      durationMs: t.ended_at ? Number(t.ended_at) - Number(t.started_at) : null,
      callCount: t.call_count,
      errorCount: t.error_count,
      writeCount: t.write_count,
      blockedCount: t.blocked_count,
      scriptCount: t.script_count,
      decisionCount: t.decision_count,
      opsCount: t.ops_count,
    };
  }

  item(a: Audit): TimelineItem {
    const tool = a.tool_name ?? undefined;
    const base = { id: a.id, ts: toIso(Number(a.ts)), ...(a.latency_ms !== null ? { durationMs: Math.max(0, Number(a.latency_ms)) } : {}), auditId: a.id, decision: a.decision, status: a.status, ...(a.error_id ? { errorId: a.error_id } : {}), ...(a.via ? { via: a.via as TimelineItem['via'] } : {}) };
    if (a.kind === 'script_run') return { ...base, kind: 'script', tool: 'run_script', write: false, dryRun: bool(a.dry_run), summary: `run_script (${bool(a.dry_run) ? 'dry run' : 'execute'})${a.error_message ? `: ${a.error_message.slice(0, 120)}` : ''}`, ...(a.script_run_id ? { scriptRunId: a.script_run_id } : {}) };
    if (a.kind === 'tool_search') {
      const p = parseJsonColumn<{ query?: string }>(a.params_redacted);
      return { ...base, kind: 'search', ...(tool ? { tool } : {}), summary: `search_tools "${String(p?.query ?? '').slice(0, 120)}"` };
    }
    if (a.kind === 'ops_call') {
      const kind = tool === 'neurouter_begin_task' ? 'task_begin' : tool === 'neurouter_end_task' ? 'task_end' : 'ops';
      const p = parseJsonColumn<Record<string, unknown>>(a.params_redacted) ?? {};
      const text = kind === 'task_begin' ? `Begin: ${String(p.goal ?? '')}` : kind === 'task_end' ? `End: ${String(p.outcome ?? '')}` : `${tool}`;
      return { ...base, kind, ...(tool ? { tool } : {}), summary: text.slice(0, 300) };
    }
    if (a.kind === 'tools_list') return { ...base, kind: 'tools_list', summary: 'tools/list' };
    const blocked = a.decision.startsWith('denied_');
    return { ...base, kind: 'call', ...(tool ? { tool } : {}), write: bool(a.write), dryRun: bool(a.dry_run), ...(a.script_run_id ? { scriptRunId: a.script_run_id } : {}), summary: `${tool ?? 'call'}${blocked ? ` blocked (${a.decision})` : a.status !== 'ok' ? ` → ${a.status}` : ''}` };
  }

  /** Timeline (§12.2): audit rows + decisions + unmet needs + issues, script inner calls nested under their script. */
  async timeline(taskId: string): Promise<{ items: TimelineItem[]; truncated: boolean }> {
    await this.c.auditStore.flush().catch(() => {});
    const rows = (await this.c.dbs.audit.db.selectFrom('audit_log').selectAll().where('task_id', '=', taskId).orderBy('seq').limit(TIMELINE_CAP + 1).execute()) as Audit[];
    const truncated = rows.length > TIMELINE_CAP;
    const audit = rows.slice(0, TIMELINE_CAP);
    const scripts = new Map<string, TimelineItem>();
    const out: TimelineItem[] = [];
    for (const a of audit) if (a.kind === 'script_run' && a.script_run_id) scripts.set(a.script_run_id, { ...this.item(a), children: [] });
    const orphans = new Map<string, TimelineItem[]>();
    for (const a of audit) {
      if (a.kind === 'script_run') continue;
      const it = this.item(a);
      if (a.script_run_id && a.kind === 'tool_call') {
        const parent = scripts.get(a.script_run_id);
        if (parent) parent.children!.push(it);
        else orphans.set(a.script_run_id, [...(orphans.get(a.script_run_id) ?? []), it]);
        continue;
      }
      out.push(it);
    }
    // running scripts without their final audit row yet: synthesize the parent
    for (const [sid, children] of orphans) out.push({ id: sid, kind: 'script', ts: children[0]!.ts, tool: 'run_script', summary: 'run_script (running)', scriptRunId: sid, children });
    out.push(...scripts.values());
    const [decs, needs, issues] = await Promise.all([
      this.db.selectFrom('decisions').selectAll().where('task_id', '=', taskId).execute(),
      this.db.selectFrom('unmet_needs').selectAll().where('task_id', '=', taskId).execute(),
      this.db.selectFrom('issues').selectAll().where('task_id', '=', taskId).execute(),
    ]);
    // ops audit rows for these duplicate the domain rows; keep the richer domain item
    const dropOps = new Set<string>();
    for (const d of decs) {
      out.push({ id: d.id, kind: 'decision', ts: toIso(d.ts), summary: `${d.choice} — ${d.reason}`.slice(0, 500), ...(d.audit_id ? { auditId: d.audit_id } : {}) });
      if (d.audit_id) dropOps.add(d.audit_id);
    }
    for (const n of needs) {
      out.push({ id: n.id, kind: 'unmet_need', ts: toIso(n.created_at), summary: n.intent.slice(0, 500), ...(n.audit_id ? { auditId: n.audit_id } : {}) });
      if (n.audit_id) dropOps.add(n.audit_id);
    }
    for (const i of issues) out.push({ id: i.id, kind: 'issue', ts: toIso(i.created_at), tool: i.tool_name, summary: i.problem.slice(0, 500) });
    const items = out.filter((x) => !(x.kind === 'ops' && x.auditId && dropOps.has(x.auditId)));
    items.sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
    return { items, truncated };
  }

  async callDetail(a: Audit): Promise<CallDetail> {
    const r = await this.refs(a.server_id, a.environment_id);
    let error: CallDetail['error'] = null;
    if (a.error_id) {
      const ev = await this.db.selectFrom('error_events').select(['code', 'detail']).where('error_id', '=', a.error_id).executeTakeFirst();
      const code = (ev?.code ?? a.error_code ?? 'upstream_error') as ErrorCode;
      const cat = ERROR_CATALOG[code];
      const detail = parseJsonColumn<Record<string, unknown>>(ev?.detail) ?? {};
      error = cat ? { code, title: cat.title, explanation: fillTemplate(cat.explanation, detail) } : { code, title: code, explanation: a.error_message ?? '' };
    } else if (a.error_code) error = { code: a.error_code, title: ERROR_CATALOG[a.error_code as ErrorCode]?.title ?? a.error_code, explanation: a.error_message ?? '' };
    const storeOutputs = await this.c.settings.get('auditStoreFullOutput', a.tenant_id);
    return {
      auditId: a.id,
      ts: toIso(Number(a.ts)),
      tool: a.tool_name ?? '',
      toolId: a.tool_id,
      via: (a.via ?? 'direct') as CallDetail['via'],
      mode: (a.mode ?? 'tool') as CallDetail['mode'],
      decision: a.decision,
      status: a.status,
      write: bool(a.write),
      dryRun: bool(a.dry_run),
      confirm: (a.confirm ?? 'none') as CallDetail['confirm'],
      policyTrail: (parseJsonColumn<CallDetail['policyTrail']>(a.policy_trail) ?? []).filter((p) => p && typeof p.step === 'string'),
      arguments: parseJsonColumn(a.params_redacted),
      outputPreview: parseJsonColumn(a.output_preview),
      outputSize: a.output_size === null ? null : Number(a.output_size),
      outputHash: a.output_hash,
      ...(storeOutputs ? { upstreamBodyPreview: parseJsonColumn(a.output_full) } : {}),
      latencyMs: a.latency_ms === null ? null : Number(a.latency_ms),
      upstreamLatencyMs: a.upstream_latency_ms === null ? null : Number(a.upstream_latency_ms),
      upstreamStatus: a.upstream_status === null ? null : Number(a.upstream_status),
      errorId: a.error_id,
      error,
      traceId: a.trace_id,
      spanId: a.span_id,
      taskId: a.task_id,
      scriptRunId: a.script_run_id,
      server: r.server,
      environment: r.environment,
      client: { name: a.client_name, version: a.client_version },
      principal: await this.principal(a.principal_type, a.user_id, a.api_key_id, a.credential_key),
    };
  }
}
