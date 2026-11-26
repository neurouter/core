import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyOverlayPatch, diffOverlays, parseOverlay, shapeResponse, type CompileResult } from '@neurouter/compiler';
import { api, type Diagnostic, type OverlayDraft, type ToolDef } from '@neurouter/shared';
import { toIso } from '../../../kernel/lib/clock.js';
import { sha256Hex } from '../../../kernel/lib/crypto.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn, toJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { requireUser } from '../../auth/guards.js';
import type { ServerRowDb } from '../../servers/servers.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { serverOr404 } from './servers.js';
import { agentView, viewEnvironment } from './tools.js';

const EMPTY = 'overlay: 1\n';
const tokens = (v: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(v ?? null) ?? '', 'utf8') / 4);

/** Overlay drafts → publish (§14.6): YAML on the server, structured patch ops (comment-preserving), ETag/If-Match. */
export class OverlayDrafts {
  constructor(private readonly c: ApiContext) {}

  async published(s: ServerRowDb): Promise<{ yaml: string; rev: number | null }> {
    if (!s.published_overlay_revision_id) return { yaml: EMPTY, rev: null };
    const r = await this.c.dbs.main.db.selectFrom('overlay_revisions').select(['yaml', 'rev']).where('id', '=', s.published_overlay_revision_id).executeTakeFirst();
    return r ? { yaml: r.yaml || EMPTY, rev: r.rev } : { yaml: EMPTY, rev: null };
  }

  async current(s: ServerRowDb) {
    const d = await this.c.dbs.main.db.selectFrom('overlay_drafts').selectAll().where('server_id', '=', s.id).executeTakeFirst();
    const pub = await this.published(s);
    if (d) return { yaml: d.yaml, basedOnRev: d.based_on_rev, updatedAt: d.updated_at, updatedBy: d.updated_by, pub };
    return { yaml: pub.yaml, basedOnRev: pub.rev, updatedAt: null as number | null, updatedBy: null as string | null, pub };
  }

  etag(yaml: string, basedOnRev: number | null): string {
    return `"${sha256Hex(`${basedOnRev ?? 0}\n${yaml}`).slice(0, 32)}"`;
  }

  async validate(serverId: string, yaml: string): Promise<{ ok: boolean; diagnostics: Diagnostic[]; result: CompileResult | null }> {
    const p = parseOverlay(yaml);
    if (p.diagnostics.some((d) => d.severity === 'error')) return { ok: false, diagnostics: p.diagnostics, result: null };
    const r = await this.c.builds.compileWith(serverId, yaml);
    const diags = [...p.diagnostics, ...r.diagnostics.filter((d) => d.overlayPath || d.code.startsWith('overlay'))];
    return { ok: r.ok, diagnostics: r.ok ? diags : [...diags, ...r.diagnostics.filter((d) => d.severity === 'error' && !diags.includes(d))], result: r };
  }

  async view(s: ServerRowDb): Promise<OverlayDraft> {
    const cur = await this.current(s);
    const changes = diffOverlays(cur.pub.yaml, cur.yaml);
    const val = await this.validate(s.id, cur.yaml);
    const r = val.result;
    return {
      yaml: cur.yaml,
      basedOnRev: cur.basedOnRev,
      changeCount: changes.length,
      changes,
      etag: this.etag(cur.yaml, cur.basedOnRev),
      validation: { ok: val.ok, diagnostics: val.diagnostics },
      preview: { toolCount: r?.tools.length ?? 0, visibleCount: r?.tools.filter((t) => !t.hidden).length ?? 0, lintScore: r?.lint.score ?? 0 },
      fileManaged: Boolean(s.overlay_path) && s.managed_by === 'file' && this.c.config.configMode !== 'console',
      updatedAt: cur.updatedAt ? toIso(cur.updatedAt) : null,
      updatedBy: await this.c.views.userRef(cur.updatedBy),
    };
  }

  checkIfMatch(req: FastifyRequest, expected: string): void {
    const h = req.headers['if-match'];
    if (typeof h !== 'string' || !h) throw new AppError('precondition_failed', 'If-Match with the draft ETag is required');
    if (h !== expected && h.replace(/^W\//, '') !== expected) throw new AppError('draft_conflict', 'The draft changed since you loaded it; reload and reapply your edits');
  }

  async save(s: ServerRowDb, yaml: string, basedOnRev: number | null, userId: string): Promise<void> {
    const pub = await this.published(s);
    const changes = diffOverlays(pub.yaml, yaml);
    const row = { yaml, based_on_rev: basedOnRev, change_count: changes.length, changes: toJsonColumn(changes), updated_by: userId, updated_at: this.c.clock.now() };
    await this.c.dbs.main.db.insertInto('overlay_drafts').values({ server_id: s.id, tenant_id: this.c.tenantId, ...row }).onConflict((oc) => oc.column('server_id').doUpdateSet(row)).execute();
  }
}

async function publishResult(c: ApiContext, revisionId: string, buildId: string, pinTo: string[] | undefined) {
  const db = c.dbs.main.db;
  const rev = await db.selectFrom('overlay_revisions').selectAll().where('id', '=', revisionId).executeTakeFirstOrThrow();
  const b = await db.selectFrom('builds').selectAll().where('id', '=', buildId).executeTakeFirstOrThrow();
  const pinned = await db.selectFrom('environments').select(['id', 'slug']).where('build_id', '=', buildId).execute();
  void pinTo;
  return { revision: await c.views.overlayRow(rev), build: await c.views.buildRow(b), pinnedEnvironments: pinned };
}

/** `overlays.*` (§14.6, §14.15). */
export async function overlayRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const drafts = new OverlayDrafts(c);
  const fileOverlayGuard = (s: ServerRowDb) => {
    if (s.overlay_path && s.managed_by === 'file' && c.config.configMode !== 'console') throw new AppError('config_managed', 'The overlay is file-managed: download overlay.yaml and commit it', { extensions: { configPath: s.config_path ?? s.overlay_path, configLine: s.config_line ?? null } });
  };
  const withEtag = async (reply: { header: (k: string, v: string) => unknown }, s: ServerRowDb) => {
    const out = await drafts.view(s);
    reply.header('etag', out.etag);
    return out;
  };

  route(app, 'overlays.getDraft', api.overlays.getDraft, async (req, reply) => withEtag(reply, await serverOr404(c, req.params.id)));

  route(app, 'overlays.updateDraft', api.overlays.updateDraft, async (req, reply) => {
    const u = requireUser(req);
    const s = await serverOr404(c, req.params.id);
    const cur = await drafts.current(s);
    drafts.checkIfMatch(req, drafts.etag(cur.yaml, cur.basedOnRev));
    let yaml: string;
    if ('ops' in req.body) {
      try {
        yaml = applyOverlayPatch(cur.yaml, req.body.ops).yaml;
      } catch (err) {
        throw new AppError('overlay_invalid', (err as Error).message, { extensions: { diagnostics: [] } });
      }
    } else yaml = req.body.yaml || EMPTY;
    const p = parseOverlay(yaml);
    const errs = p.diagnostics.filter((d) => d.severity === 'error');
    if (errs.length) throw new AppError('overlay_invalid', `The overlay has ${errs.length} error(s)`, { extensions: { diagnostics: errs } });
    await drafts.save(s, yaml, cur.basedOnRev, u.id);
    return withEtag(reply, s);
  });

  route(app, 'overlays.discardDraft', api.overlays.discardDraft, async (req) => {
    const s = await serverOr404(c, req.params.id);
    await db.deleteFrom('overlay_drafts').where('server_id', '=', s.id).execute();
  });

  route(app, 'overlays.publish', api.overlays.publish, async (req) => {
    const u = requireUser(req);
    const s = await serverOr404(c, req.params.id);
    fileOverlayGuard(s);
    const cur = await drafts.current(s);
    drafts.checkIfMatch(req, drafts.etag(cur.yaml, cur.basedOnRev));
    if (req.body.pinTo) {
      const own = await db.selectFrom('environments').select('id').where('server_id', '=', s.id).where('id', 'in', req.body.pinTo.length ? req.body.pinTo : ['-']).execute();
      if (own.length !== req.body.pinTo.length) throw AppError.validation('pinTo contains environments of another server', [{ path: ['pinTo'], message: 'unknown environment', code: 'environment_mismatch' }]);
    }
    const out = await c.servers.publishOverlay(c.tenantId, s.id, cur.yaml, { message: req.body.message, source: 'console', createdBy: u.id, basedOnRev: cur.basedOnRev, ...(req.body.pinTo ? { pinTo: req.body.pinTo } : {}) });
    await db.deleteFrom('overlay_drafts').where('server_id', '=', s.id).execute();
    return publishResult(c, out.revisionId, out.build.build.id, req.body.pinTo);
  });

  route(app, 'overlays.versions', api.overlays.versions, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    let qb = db.selectFrom('overlay_revisions').selectAll().where('server_id', '=', s.id);
    if (key) qb = qb.where('rev', '<', Number(key[0]));
    const rows = await qb.orderBy('rev', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.rev]);
    return { items: await Promise.all(page.items.map((r) => c.views.overlayRow(r))), nextCursor: page.nextCursor };
  });

  route(app, 'overlays.getVersion', api.overlays.getVersion, async (req) => {
    const r = await db.selectFrom('overlay_revisions').selectAll().where('id', '=', req.params.id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!r) throw AppError.notFound('Overlay revision');
    return { ...(await c.views.overlayRow(r)), yaml: r.yaml };
  });

  const yamlAt = async (s: ServerRowDb, ref: 'draft' | number): Promise<string> => {
    if (ref === 'draft') return (await drafts.current(s)).yaml;
    if (ref === 0) return EMPTY;
    const r = await db.selectFrom('overlay_revisions').select('yaml').where('server_id', '=', s.id).where('rev', '=', ref).executeTakeFirst();
    if (!r) throw AppError.notFound(`Overlay revision ${ref}`);
    return r.yaml;
  };

  route(app, 'overlays.diff', api.overlays.diff, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const [fromYaml, toYaml] = await Promise.all([yamlAt(s, req.query.from), yamlAt(s, req.query.to)]);
    const [a, b] = await Promise.all([c.builds.compileWith(s.id, fromYaml), c.builds.compileWith(s.id, toYaml)]);
    const before = new Map(a.tools.map((t) => [t.key, t]));
    const toolChanges: Array<{ toolName: string; fields: string[] }> = [];
    for (const t of b.tools) {
      const p = before.get(t.key);
      if (!p) {
        toolChanges.push({ toolName: t.name, fields: ['added'] });
        continue;
      }
      if (p.defHash === t.defHash && p.hidden === t.hidden) continue;
      const fields = (['name', 'title', 'description', 'hidden', 'pinned', 'inputSchema', 'tags', 'risk', 'shaping', 'examples'] as const).filter((f) => JSON.stringify(p[f]) !== JSON.stringify(t[f]));
      toolChanges.push({ toolName: t.name, fields });
    }
    return { fromYaml, toYaml, toolChanges };
  });

  route(app, 'overlays.revert', api.overlays.revert, async (req) => {
    const u = requireUser(req);
    const s = await serverOr404(c, req.params.id);
    fileOverlayGuard(s);
    const yaml = await yamlAt(s, req.body.toRev);
    const cur = await drafts.published(s);
    const out = await c.servers.publishOverlay(c.tenantId, s.id, yaml, { message: req.body.message ?? `Revert to v${req.body.toRev}`, source: 'revert', createdBy: u.id, basedOnRev: cur.rev });
    await db.deleteFrom('overlay_drafts').where('server_id', '=', s.id).execute();
    return publishResult(c, out.revisionId, out.build.build.id, undefined);
  });

  route(app, 'overlays.download', api.overlays.download, async (req, reply) => {
    const s = await serverOr404(c, req.params.id);
    const yaml = req.query.rev ? await yamlAt(s, req.query.rev) : (await drafts.published(s)).yaml;
    return reply.header('content-type', 'text/yaml; charset=utf-8').header('content-disposition', `attachment; filename="${s.slug}.overlay.yaml"`).send(yaml);
  });

  route(app, 'overlays.validate', api.overlays.validate, async (req) => {
    await serverOr404(c, req.body.serverId);
    const v = await drafts.validate(req.body.serverId, req.body.yaml || EMPTY);
    const r = v.result;
    return { ok: v.ok, diagnostics: v.diagnostics, preview: r ? { toolCount: r.tools.length, visibleCount: r.tools.filter((t) => !t.hidden).length, lintScore: r.lint.score } : null };
  });

  route(app, 'overlays.preview', api.overlays.preview, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const cur = await drafts.current(s);
    let yaml = cur.yaml;
    const diagnostics: Diagnostic[] = [];
    if (req.body.ops?.length) {
      try {
        yaml = applyOverlayPatch(yaml, req.body.ops).yaml;
      } catch (err) {
        diagnostics.push({ severity: 'error', code: 'overlay_invalid', message: (err as Error).message });
      }
    }
    const r = await c.builds.compileWith(s.id, yaml);
    diagnostics.push(...r.diagnostics.filter((d) => d.severity === 'error'));
    const baseTools = s.latest_build_id ? (await c.views.buildTools(s.latest_build_id)).map((x) => x.def) : [];
    const after: ToolDef | undefined = r.tools.find((t) => t.name === req.body.toolName) ?? r.tools.find((t) => baseTools.find((b) => b.name === req.body.toolName)?.key === t.key);
    if (!after) throw AppError.notFound(`Tool ${req.body.toolName}`);
    const before = baseTools.find((t) => t.key === after.key) ?? after;
    const envId = s.latest_build_id ? await viewEnvironment(c, s.id, s.latest_build_id) : null;
    let sample: unknown = null;
    let source: 'mock' | 'example' = 'example';
    if (envId) {
      sample = await c.ports.mockSample(envId, { ...before, shaping: {} } as ToolDef).catch(() => null);
      if (sample !== null) source = 'mock';
    }
    if (sample === null) sample = before.examples[0]?.arguments ?? null;
    const shapedBefore = source === 'mock' ? shapeResponse(sample, before.shaping).value : sample;
    const shapedAfter = source === 'mock' ? shapeResponse(sample, after.shaping).value : sample;
    const view = await agentView(c, s.slug, s.id, s.latest_build_id ?? '', after);
    return { agentView: view, sample: { before: shapedBefore, after: shapedAfter, source }, tokens: { definition: tokens(view.mcp), sampleBefore: tokens(shapedBefore), sampleAfter: tokens(shapedAfter), estimated: true as const }, diagnostics };
  });
  void parseJsonColumn;
}
