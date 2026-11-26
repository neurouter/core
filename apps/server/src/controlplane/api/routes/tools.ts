import { tenantOf } from '../../auth/guards.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { generateStubs, parseOverlay } from '@neurouter/compiler';
import { api, type OverlayToolEntry, type ToolDef } from '@neurouter/shared';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { environmentRuntime } from '../../../kernel/runtime-config.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { serverOr404 } from './servers.js';

const DAY = 86_400_000;

/** The overlay entry (draft first, else published) whose selector is the tool's stable key. */
export async function overlayEntryFor(c: ApiContext, tenantId: string, serverId: string, key: string): Promise<OverlayToolEntry | null> {
  const db = c.dbs.main.db;
  const draft = await db.selectFrom('overlay_drafts').select('yaml').where('server_id', '=', serverId).where('tenant_id', '=', tenantId).executeTakeFirst();
  let yaml = draft?.yaml ?? null;
  if (yaml === null) {
    const s = await db.selectFrom('servers').select('published_overlay_revision_id').where('id', '=', serverId).where('tenant_id', '=', tenantId).executeTakeFirst();
    yaml = s?.published_overlay_revision_id ? ((await db.selectFrom('overlay_revisions').select('yaml').where('id', '=', s.published_overlay_revision_id).where('tenant_id', '=', tenantId).executeTakeFirst())?.yaml ?? null) : null;
  }
  if (!yaml) return null;
  const p = parseOverlay(yaml);
  const tools = (p.overlay as { tools?: Record<string, OverlayToolEntry> } | null)?.tools ?? {};
  return tools[key] ?? null;
}

/** An environment pinned to the build (mock first) to render the agent view in. */
export async function viewEnvironment(c: ApiContext, tenantId: string, serverId: string, buildId: string): Promise<string | null> {
  const envs = await c.dbs.main.db.selectFrom('environments').select(['id', 'slug', 'build_id']).where('server_id', '=', serverId).where('tenant_id', '=', tenantId).where('status', '=', 'active').execute();
  return (envs.find((e) => e.build_id === buildId && e.slug === 'mock') ?? envs.find((e) => e.build_id === buildId) ?? null)?.id ?? null;
}

export async function agentView(c: ApiContext, tenantId: string, serverSlug: string, serverId: string, buildId: string, tool: ToolDef): Promise<{ mcp: Record<string, unknown>; python: string }> {
  const envId = await viewEnvironment(c, tenantId, serverId, buildId);
  const mcp = await c.ports.agentEntry(tenantId, tool, envId).catch(() => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema }));
  return { mcp, python: tool.hidden ? '' : generateStubs([tool], serverSlug.replace(/-/g, '_')) };
}

async function usage7d(c: ApiContext, tenantId: string, serverId: string): Promise<Map<string, { calls: number; errors: number }>> {
  const since = new Date(c.clock.now() - 7 * DAY).toISOString().slice(0, 10);
  const rows = await c.dbs.main.db.selectFrom('usage_daily').select(['tool_name', (eb) => eb.fn.sum<number>('calls').as('c'), (eb) => eb.fn.sum<number>('errors').as('e')]).where('server_id', '=', serverId).where('tenant_id', '=', tenantId).where('day', '>=', since).groupBy('tool_name').execute();
  return new Map(rows.map((r) => [r.tool_name, { calls: Number(r.c ?? 0), errors: Number(r.e ?? 0) }]));
}

/** `tools.*` (§14.6, §14.15). */
export async function toolRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const v = c.views;

  route(app, 'tools.list', api.tools.list, async (req) => {
    const s = await serverOr404(c, req, req.params.id);
    const q = req.query;
    const buildId = q.buildId ?? s.latest_build_id;
    if (!buildId) return { items: [], nextCursor: null };
    const envs = await c.servers.environments(s.id);
    const scoped = q.environmentId ? envs.filter((e) => e.id === q.environmentId) : envs;
    const usage = await usage7d(c, tenantOf(req), s.id);
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = db.selectFrom('tools').select(['id', 'seq', 'def']).where('build_id', '=', buildId);
    if (q.visibility === 'visible' || q.visibility === undefined) qb = qb.where('hidden', '=', 0);
    else if (q.visibility === 'hidden') qb = qb.where('hidden', '=', 1);
    if (q.kind) qb = qb.where('write', '=', q.kind === 'write' ? 1 : 0);
    if (q.pinned !== undefined) qb = qb.where('pinned', '=', q.pinned ? 1 : 0);
    if (q.q) qb = qb.where((eb) => eb.or([eb('name', 'like', `%${q.q}%`), eb('title', 'like', `%${q.q}%`), eb('description', 'like', `%${q.q}%`)]));
    if (key) qb = qb.where('seq', '>', Number(key[0]));
    const rows = await qb.orderBy('seq').limit(q.modified !== undefined || q.tag ? 5000 : limit + 1).execute();
    let defs = rows.map((r) => ({ ...r, t: parseJsonColumn<ToolDef>(r.def)! }));
    if (q.modified !== undefined) defs = defs.filter((d) => (d.t.overlayApplied.length > 0) === q.modified);
    if (q.tag) defs = defs.filter((d) => d.t.tags.includes(q.tag!));
    if (q.modified !== undefined || q.tag) defs = defs.slice(0, limit + 1);

    const page = toPage(defs, limit, (d) => d, (d) => [Number(d.seq)]);
    return {
      items: page.items.map((d) => {
        const u = usage.get(d.t.name);
        const writeEnabledIn = scoped.filter((e) => {
          if (!d.t.risk.write) return true;
          const w = environmentRuntime(e).writes;
          return w.enabled && (w.tools === null || w.tools.includes(d.t.name));
        }).map((e) => e.slug);
        return v.toolRow(d.id, buildId, d.t, { writeEnabledIn, calls7d: u?.calls ?? 0, errorRate7d: u && u.calls ? Math.min(1, u.errors / u.calls) : 0 });
      }),
      nextCursor: page.nextCursor,
    };
  });

  const toolOr404 = async (req: FastifyRequest, id: string) => {
    const r = await db.selectFrom('tools').select(['id', 'build_id', 'server_id', 'def']).where('id', '=', id).where('tenant_id', '=', tenantOf(req)).executeTakeFirst();
    if (!r) throw AppError.notFound('Tool');
    return { ...r, t: parseJsonColumn<ToolDef>(r.def)! };
  };

  route(app, 'tools.get', api.tools.get, async (req) => {
    const r = await toolOr404(req, req.params.id);
    const s = await serverOr404(c, req, r.server_id);
    const t = r.t;
    const envs = await c.servers.environments(s.id);
    const usage = (await usage7d(c, tenantOf(req), s.id)).get(t.name);
    const b = t.binding;
    const binding =
      b.type === 'http'
        ? { type: 'http' as const, method: b.method, pathTemplate: b.pathTemplate, params: b.params.map((p) => ({ arg: p.arg, in: p.in, name: p.name, required: p.required })), bodyContentType: b.body?.contentType ?? null, successStatuses: b.successStatuses }
        : b.type === 'graphql'
          ? { type: 'graphql' as const, operationType: b.operationType, document: b.document }
          : { type: 'composite' as const, script: b.script };
    return {
      ...v.toolRow(r.id, r.build_id, t, {
        writeEnabledIn: envs.filter((e) => !t.risk.write || (environmentRuntime(e).writes.enabled && (environmentRuntime(e).writes.tools === null || environmentRuntime(e).writes.tools!.includes(t.name)))).map((e) => e.slug),
        calls7d: usage?.calls ?? 0,
        errorRate7d: usage && usage.calls ? Math.min(1, usage.errors / usage.calls) : 0,
      }),
      description: t.description,
      inputSchema: t.inputSchema,
      outputSchema: t.outputSchema ?? null,
      annotations: { title: t.title, readOnlyHint: t.risk.readOnly, destructiveHint: t.risk.destructive, idempotentHint: t.risk.idempotent, openWorldHint: t.risk.openWorld },
      risk: t.risk,
      binding,
      examples: t.examples.map((e) => ({ ...(e.title ? { title: e.title } : {}), arguments: e.arguments })),
      pySignature: t.pySignature,
      sourceRef: t.sourceRef as Record<string, unknown>,
      overlayApplied: t.overlayApplied,
      overlayEntry: await overlayEntryFor(c, tenantOf(req), s.id, t.key),
      agentView: await agentView(c, tenantOf(req), s.slug, s.id, r.build_id, t),
      defHash: t.defHash,
    };
  });

  route(app, 'tools.search', api.tools.search, async (req) => {
    const s = await serverOr404(c, req, req.params.id);
    const envs = await c.servers.environments(s.id);
    const env = (req.query.environmentId ? envs.find((e) => e.id === req.query.environmentId) : null) ?? envs.find((e) => e.slug === 'mock') ?? envs[0];
    if (!env) throw AppError.notFound('Environment');
    const res = await c.ports.searchTools(tenantOf(req), env.id, req.query.q, req.query.format ?? 'json', req.query.limit ?? 8);
    return {
      tools: res.tools.map((t) => ({ name: String(t.name), title: String(t.title ?? ''), description: String(t.description ?? ''), readOnly: Boolean(t.readOnly), write: Boolean(t.write), ...(t.inputSchema ? { inputSchema: t.inputSchema as Record<string, unknown> } : {}), ...(t.pySignature ? { pySignature: String(t.pySignature) } : {}), score: Number(t.score ?? 0) })),
      totalVisible: res.totalVisible,
      ...(res.hint ? { hint: res.hint } : {}),
      ...(res.mode === 'hybrid' || res.mode === 'keyword' ? { mode: res.mode as 'hybrid' | 'keyword' } : {}),
    };
  });

  route(app, 'tools.diff', api.tools.diff, async (req) => {
    const r = await toolOr404(req, req.params.id);
    const s = await serverOr404(c, req, r.server_id);
    const other = await db.selectFrom('tools').select(['def', 'build_id']).where('build_id', '=', req.query.against).where('key', '=', r.t.key).executeTakeFirst();
    const before = other ? await agentView(c, tenantOf(req), s.slug, s.id, other.build_id, parseJsonColumn<ToolDef>(other.def)!) : null;
    const after = await agentView(c, tenantOf(req), s.slug, s.id, r.build_id, r.t);
    const changed: string[] = [];
    if (before) {
      for (const k of new Set([...Object.keys(before.mcp), ...Object.keys(after.mcp)])) if (JSON.stringify(before.mcp[k]) !== JSON.stringify(after.mcp[k])) changed.push(k);
      if (before.python !== after.python) changed.push('python');
    } else changed.push('added');
    return { before, after, changedFields: changed };
  });

  route(app, 'tools.searchAll', api.tools.searchAll, async (req) => {
    const limit = req.query.limit ?? 20;
    const servers = await db.selectFrom('servers').select(['id', 'slug', 'name', 'latest_build_id']).where('tenant_id', '=', tenantOf(req)).where('status', '=', 'active').execute();
    const builds = servers.map((s) => s.latest_build_id).filter((x): x is string => Boolean(x));
    if (!builds.length) return { items: [] };
    const q = req.query.q;
    const rows = await db.selectFrom('tools').select(['id', 'name', 'title', 'server_id']).where('build_id', 'in', builds).where('hidden', '=', 0).where((eb) => eb.or([eb('name', 'like', `%${q}%`), eb('title', 'like', `%${q}%`)])).orderBy('name').limit(limit).execute();
    const byId = new Map(servers.map((s) => [s.id, s]));
    return { items: rows.map((r) => ({ id: r.id, name: r.name, title: r.title, server: { id: r.server_id, slug: byId.get(r.server_id)?.slug ?? '', name: byId.get(r.server_id)?.name ?? '' } })) };
  });
}
