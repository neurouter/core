import type { FastifyInstance } from 'fastify';
import type { Selectable } from 'kysely';
import { api, type NeedGroupRow } from '@neurouter/shared';
import type { AuditLogTable, IssuesTable, NeedGroupsTable } from '../../../kernel/db/schema.js';
import { toIso } from '../../../kernel/lib/clock.js';
import { sha256Hex } from '../../../kernel/lib/crypto.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { newId } from '../../../kernel/lib/ids.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { TracesService } from '../../traces/traces.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';

const DAY = 86_400_000;

/** `inbox.*` (§14.10): unmet-need groups and issues. */
export async function inboxRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const tr = new TracesService(c);
  const inboxChanged = () => void c.coord.publish('events.inbox', {}).catch(() => {});

  const groupRow = async (g: Selectable<NeedGroupsTable>): Promise<NeedGroupRow> => {
    const r = await tr.refs(g.server_id, null);
    const samples = await db.selectFrom('unmet_needs').select('intent').where('group_id', '=', g.id).orderBy('created_at', 'desc').limit(3).execute();
    return { id: g.id, label: g.label, server: r.server!, count: g.count, distinctPrincipals: g.distinct_principals, firstSeenAt: toIso(g.first_seen_at), lastSeenAt: toIso(g.last_seen_at), status: g.status, note: g.note, sampleIntents: samples.map((s) => s.intent) };
  };
  const recount = async (groupId: string) => {
    const agg = await db.selectFrom('unmet_needs').select([(eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.count<number>('credential_key').distinct().as('p'), (eb) => eb.fn.min('created_at').as('f'), (eb) => eb.fn.max('created_at').as('l')]).where('group_id', '=', groupId).executeTakeFirst();
    await db.updateTable('need_groups').set({ count: Number(agg?.n ?? 0), distinct_principals: Number(agg?.p ?? 0), ...(agg?.f !== null && agg?.f !== undefined ? { first_seen_at: Number(agg.f), last_seen_at: Number(agg.l) } : {}) }).where('id', '=', groupId).execute();
  };
  const groupOr404 = async (id: string) => {
    const g = await db.selectFrom('need_groups').selectAll().where('id', '=', id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!g) throw AppError.notFound('Need group');
    return g;
  };
  const issueRow = async (i: Selectable<IssuesTable>) => {
    const r = await tr.refs(i.server_id, i.environment_id);
    return { id: i.id, tool: i.tool_name, problem: i.problem, server: r.server!, environment: r.environment!, taskId: i.task_id, status: i.status, createdAt: toIso(i.created_at), updatedAt: toIso(i.updated_at), hasFailingCall: Boolean(i.related_audit_id) };
  };
  const issueOr404 = async (id: string) => {
    const i = await db.selectFrom('issues').selectAll().where('id', '=', id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!i) throw AppError.notFound('Issue');
    return i;
  };

  route(app, 'inbox.summary', api.inbox.summary, async (req) => {
    const since = c.clock.now() - 7 * DAY;
    const sid = req.query.serverId;
    const count = async (table: 'need_groups' | 'issues', open: boolean) => {
      let qb = db.selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', c.tenantId);
      if (sid) qb = qb.where('server_id', '=', sid);
      qb = open ? qb.where('status', '=', 'open') : table === 'need_groups' ? qb.where('first_seen_at', '>=', since) : qb.where('created_at', '>=', since);
      return Number((await qb.executeTakeFirst())?.n ?? 0);
    };
    return { needs: { open: await count('need_groups', true), new7d: await count('need_groups', false) }, issues: { open: await count('issues', true), new7d: await count('issues', false) } };
  });

  route(app, 'inbox.list', api.inbox.list, async (req) => {
    const q = req.query;
    const limit = clampLimit(q.limit);
    let nq = db.selectFrom('unmet_needs as n').innerJoin('need_groups as g', 'g.id', 'n.group_id').select(['n.id', 'n.intent', 'n.created_at', 'g.status', 'g.id as gid', 'n.attempted']).where('n.tenant_id', '=', c.tenantId);
    if (q.serverId) nq = nq.where('n.server_id', '=', q.serverId);
    let iq = db.selectFrom('issues').selectAll().where('tenant_id', '=', c.tenantId);
    if (q.serverId) iq = iq.where('server_id', '=', q.serverId);
    if (q.toolName) iq = iq.where('tool_name', '=', q.toolName);
    const needs = (await nq.orderBy('n.created_at', 'desc').limit(500).execute()).filter((n) => !q.toolName || (parseJsonColumn<string[]>(n.attempted) ?? []).includes(q.toolName));
    const issues = await iq.orderBy('created_at', 'desc').limit(500).execute();
    const all = [
      ...needs.map((n) => ({ kind: 'need' as const, id: n.id, title: n.intent, status: n.status, createdAt: n.created_at, groupId: n.gid })),
      ...issues.map((i) => ({ kind: 'issue' as const, id: i.id, title: i.problem, status: i.status, createdAt: i.created_at })),
    ].sort((a, b) => b.createdAt - a.createdAt);
    const key = decodeCursor(q.cursor);
    const offset = key ? Number(key[0]) : 0;
    const slice = all.slice(offset, offset + limit + 1);
    const page = toPage(slice, limit, (x) => ({ ...x, createdAt: toIso(x.createdAt) }), () => [offset + limit]);
    return page;
  });

  route(app, 'inbox.needGroups', api.inbox.needGroups, async (req) => {
    const q = req.query;
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    const offset = key ? Number(key[0]) : 0;
    let qb = db.selectFrom('need_groups').selectAll().where('tenant_id', '=', c.tenantId);
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.status?.length) qb = qb.where('status', 'in', q.status);
    if (q.q) qb = qb.where('label', 'like', `%${q.q}%`);
    qb = q.sort === 'recent' ? qb.orderBy('last_seen_at', 'desc') : qb.orderBy('count', 'desc').orderBy('last_seen_at', 'desc');
    const rows = await qb.offset(offset).limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, () => [offset + limit]);
    return { items: await Promise.all(page.items.map(groupRow)), nextCursor: page.nextCursor };
  });

  route(app, 'inbox.needGroup', api.inbox.needGroup, async (req) => {
    const g = await groupOr404(req.params.groupId);
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    let qb = db.selectFrom('unmet_needs').selectAll().where('group_id', '=', g.id);
    if (key) qb = qb.where((eb) => eb.or([eb('created_at', '<', Number(key[0])), eb.and([eb('created_at', '=', Number(key[0])), eb('id', '<', String(key[1]))])]));
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at, r.id]);
    const items = [];
    for (const n of page.items) {
      const r = await tr.refs(null, n.environment_id);
      const keyRow = await db.selectFrom('api_keys').select('id').where('id', '=', n.credential_key).executeTakeFirst();
      items.push({ id: n.id, groupId: n.group_id, intent: n.intent, attempted: parseJsonColumn<string[]>(n.attempted) ?? [], taskId: n.task_id, environment: r.environment!, principal: await tr.principal(keyRow ? 'api_key' : n.user_id ? 'user' : 'external', n.user_id, keyRow?.id ?? null, n.credential_key), client: { name: n.client_name, version: null }, createdAt: toIso(n.created_at) });
    }
    const all = await db.selectFrom('unmet_needs').select(['attempted', 'created_at']).where('group_id', '=', g.id).execute();
    const tools = new Map<string, number>();
    const days = new Map<string, number>();
    const since = c.clock.now() - 30 * DAY;
    for (const n of all) {
      for (const t of parseJsonColumn<string[]>(n.attempted) ?? []) tools.set(t, (tools.get(t) ?? 0) + 1);
      if (n.created_at >= since) {
        const d = new Date(n.created_at).toISOString().slice(0, 10);
        days.set(d, (days.get(d) ?? 0) + 1);
      }
    }
    return {
      ...(await groupRow(g)),
      reports: { items, nextCursor: page.nextCursor },
      attemptedTools: [...tools].map(([tool, count]) => ({ tool, count })).sort((a, b) => b.count - a.count),
      daily: [...days].sort().map(([day, count]) => ({ day, count })),
    };
  });

  route(app, 'inbox.triageNeedGroup', api.inbox.triageNeedGroup, async (req) => {
    const g = await groupOr404(req.params.groupId);
    await db.updateTable('need_groups').set({ ...(req.body.status ? { status: req.body.status } : {}), ...(req.body.note !== undefined ? { note: req.body.note } : {}) }).where('id', '=', g.id).execute();
    inboxChanged();
    return groupRow(await groupOr404(g.id));
  });

  route(app, 'inbox.mergeNeedGroups', api.inbox.mergeNeedGroups, async (req) => {
    const from = await groupOr404(req.params.groupId);
    const into = await groupOr404(req.body.intoGroupId);
    if (from.id === into.id) throw AppError.validation('Cannot merge a group into itself', [{ path: ['intoGroupId'], message: 'same group', code: 'same_group' }]);
    if (from.server_id !== into.server_id) throw AppError.validation('Groups of different servers cannot be merged', [{ path: ['intoGroupId'], message: 'other server', code: 'server_mismatch' }]);
    await db.updateTable('unmet_needs').set({ group_id: into.id }).where('group_id', '=', from.id).execute();
    await db.deleteFrom('need_groups').where('id', '=', from.id).execute();
    await recount(into.id);
    inboxChanged();
    return groupRow(await groupOr404(into.id));
  });

  route(app, 'inbox.splitNeed', api.inbox.splitNeed, async (req) => {
    const n = await db.selectFrom('unmet_needs').selectAll().where('id', '=', req.params.reportId).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!n) throw AppError.notFound('Report');
    const id = newId();
    await db.insertInto('need_groups').values({ id, tenant_id: c.tenantId, server_id: n.server_id, label: n.intent.slice(0, 200), intent_norm_hash: `split:${sha256Hex(`${n.id}:${id}`)}`, count: 0, distinct_principals: 0, first_seen_at: n.created_at, last_seen_at: n.created_at, status: 'open', note: null, centroid: null }).execute();
    const old = n.group_id;
    await db.updateTable('unmet_needs').set({ group_id: id }).where('id', '=', n.id).execute();
    await recount(id);
    await recount(old);
    const left = await db.selectFrom('unmet_needs').select('id').where('group_id', '=', old).limit(1).executeTakeFirst();
    if (!left) await db.deleteFrom('need_groups').where('id', '=', old).execute();
    inboxChanged();
    return groupRow(await groupOr404(id));
  });

  route(app, 'inbox.issues', api.inbox.issues, async (req) => {
    const q = req.query;
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = db.selectFrom('issues').selectAll().where('tenant_id', '=', c.tenantId);
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.status?.length) qb = qb.where('status', 'in', q.status);
    if (q.tool) qb = qb.where('tool_name', '=', q.tool);
    if (q.q) qb = qb.where('problem', 'like', `%${q.q}%`);
    if (key) qb = qb.where((eb) => eb.or([eb('created_at', '<', Number(key[0])), eb.and([eb('created_at', '=', Number(key[0])), eb('id', '<', String(key[1]))])]));
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at, r.id]);
    return { items: await Promise.all(page.items.map(issueRow)), nextCursor: page.nextCursor };
  });

  route(app, 'inbox.issue', api.inbox.issue, async (req) => {
    const i = await issueOr404(req.params.id);
    let failing = null;
    let errorId: string | null = null;
    if (i.related_audit_id) {
      await c.auditStore.flush().catch(() => {});
      const a = (await c.auditStore.get(i.related_audit_id)) as AuditLogTable | null;
      if (a) {
        failing = await tr.callDetail(a);
        errorId = a.error_id;
      }
    }
    const task = i.task_id ? await db.selectFrom('tasks').selectAll().where('id', '=', i.task_id).executeTakeFirst() : null;
    return { ...(await issueRow(i)), evidence: parseJsonColumn(i.evidence), note: i.note, errorId, failingCall: failing, task: task ? await tr.taskRow(task) : null };
  });

  route(app, 'inbox.triageIssue', api.inbox.triageIssue, async (req) => {
    const i = await issueOr404(req.params.id);
    await db.updateTable('issues').set({ ...(req.body.status ? { status: req.body.status } : {}), ...(req.body.note !== undefined ? { note: req.body.note } : {}), updated_at: c.clock.now() }).where('id', '=', i.id).execute();
    inboxChanged();
    return issueRow(await issueOr404(i.id));
  });

  route(app, 'inbox.exportNeedMarkdown', api.inbox.exportNeedMarkdown, async (req) => {
    const g = await groupRow(await groupOr404(req.params.groupId));
    const reports = await db.selectFrom('unmet_needs').select(['intent', 'created_at', 'attempted']).where('group_id', '=', g.id).orderBy('created_at', 'desc').limit(20).execute();
    const md = [
      `## Unmet need: ${g.label}`,
      '',
      `- Server: ${g.server.name} (\`${g.server.slug}\`)`,
      `- Reports: ${g.count} from ${g.distinctPrincipals} agent credential(s)`,
      `- First seen: ${g.firstSeenAt} · last seen: ${g.lastSeenAt}`,
      `- Status: ${g.status}${g.note ? ` — ${g.note}` : ''}`,
      '',
      '### Recent reports',
      ...reports.map((r) => `- ${r.intent}${(parseJsonColumn<string[]>(r.attempted) ?? []).length ? ` (tried: ${(parseJsonColumn<string[]>(r.attempted) ?? []).join(', ')})` : ''}`),
    ].join('\n');
    return { markdown: md };
  });

  route(app, 'inbox.exportIssueMarkdown', api.inbox.exportIssueMarkdown, async (req) => {
    const i = await issueOr404(req.params.id);
    const r = await issueRow(i);
    const ev = parseJsonColumn(i.evidence);
    const md = [`## Tool issue: \`${i.tool_name}\``, '', i.problem, '', `- Server: ${r.server.name} · environment: ${r.environment.slug}`, `- Reported: ${r.createdAt} · status: ${i.status}`, ...(i.note ? [`- Note: ${i.note}`] : []), ...(ev ? ['', '```json', JSON.stringify(ev, null, 2), '```'] : [])].join('\n');
    return { markdown: md };
  });
}
