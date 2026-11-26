import { gunzipSync } from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { compile, diffSpecs, parseOverlay, applyOverlayPatch, type CompileResult } from '@neurouter/compiler';
import { api, OPS_TOOLS, parseSecretRef, SAMPLE_SPEC_URL, OPS_VISIBILITY, readinessBand, type ConnectConfig, type EnvironmentCreate, type OpsTool, type SpecPreview, type SpecSourceIn, type ToolDef } from '@neurouter/shared';
import { toIso } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { newId } from '../../../kernel/lib/ids.js';
import { parseJsonColumn, toBool, toJsonColumn } from '../../../kernel/lib/json.js';
import { decodeCursor, clampLimit, toPage } from '../../../kernel/lib/pagination.js';
import { unindexBuildTools } from '../../../kernel/db/tools-fts.js';
import { CONFIG_CHANGED, environmentRuntime, parseExposure, parseOpsTools } from '../../../kernel/runtime-config.js';
import { requireUser } from '../../auth/guards.js';
import { assertConsoleManaged, assertWithinCodeCap, EnvironmentsService } from '../../environments/environments.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';

const PREVIEW_TTL_MS = 24 * 3_600_000;

export const OPS_TITLES: Record<OpsTool | 'read_result', { title: string; description: string }> = {
  begin_task: { title: 'Begin a task', description: "Start tracking one user request as a task with the user's goal." },
  end_task: { title: 'End the task', description: 'Finish the current task with its outcome.' },
  report_unmet_need: { title: 'Report an unmet need', description: 'Tell the operators the user needs something no tool can do.' },
  log_decision: { title: 'Log a decision', description: 'Record a non-obvious choice and why.' },
  report_issue: { title: 'Report a tool issue', description: 'Report that a tool behaved wrongly or is documented misleadingly.' },
  explain_error: { title: 'Explain an error', description: 'Explain an error_id and how to fix the call.' },
  get_examples: { title: 'Get examples', description: 'Known-good example arguments or scripts for a tool.' },
  whoami: { title: 'Who am I', description: 'Environment, identity, scopes, writes, code mode and limits.' },
  read_result: { title: 'Read more of a truncated result', description: 'Page through a large result behind a handle.' },
};

export async function serverOr404(c: ApiContext, id: string) {
  return c.servers.get(c.tenantId, id);
}

/** Bytes of a spec source; URL fetches go through safe-fetch (§6.2). */
export async function specBytes(c: ApiContext, source: SpecSourceIn): Promise<{ bytes: Uint8Array; sourceUrl: string | null; contentType: string | null }> {
  if ('url' in source) {
    const f = await c.fetchSpec(source.url);
    return { bytes: f.bytes, sourceUrl: source.url, contentType: f.contentType };
  }
  return { bytes: Buffer.from(source.content, 'utf8'), sourceUrl: null, contentType: null };
}

export interface GraphqlEndpointSource {
  url: string;
  /** `env:NAME` reference for one request header (stored with the server; never the value). */
  headerRef?: { name: string; secretRef: string };
}

/**
 * Introspects a live GraphQL endpoint (backend §8.3) through the SSRF-guarded outbound fetch.
 * `headers` are one-off request headers (never stored); `headerRef` must be an `env:NAME` reference
 * (stored `secret:` values belong to an environment, which does not exist before the import).
 */
export async function introspectEndpoint(c: Pick<ApiContext, 'introspectGraphql'>, src: GraphqlEndpointSource, headers: Array<{ name: string; value: string }> = [], env: NodeJS.ProcessEnv = process.env): Promise<{ bytes: Uint8Array; sourceUrl: string; contentType: string }> {
  const h: Record<string, string> = {};
  for (const x of headers) h[x.name.toLowerCase()] = x.value;
  if (src.headerRef) {
    const ref = parseSecretRef(src.headerRef.secretRef);
    if (!ref || ref.kind !== 'env') throw AppError.validation('The header reference must be env:NAME (stored secrets belong to an environment)', [{ path: ['source', 'headerRef', 'secretRef'], message: 'use env:NAME', code: 'unsupported_ref' }]);
    const v = env[ref.name];
    if (!v) throw AppError.validation(`The server has no ${ref.name} environment variable`, [{ path: ['source', 'headerRef', 'secretRef'], message: `${ref.name} is not set`, code: 'ref_unresolved' }]);
    h[src.headerRef.name.toLowerCase()] = v;
  }
  const out = await c.introspectGraphql(src.url, h);
  return { bytes: out.bytes, sourceUrl: src.url, contentType: out.contentType };
}

/** The stored `servers.spec_source` for an introspected endpoint (re-import introspects again). */
function endpointSpecSource(src: GraphqlEndpointSource, graphql?: PreviewState['graphql']): Record<string, unknown> {
  return { graphqlEndpoint: src.url, ...(src.headerRef ? { headerRef: src.headerRef } : {}), format: 'graphql-introspection', ...(graphql ? { graphql } : {}) };
}

/** 422 spec_invalid / spec_unsupported when the compile has errors (before anything is stored). */
function assertCompiles(r: CompileResult): void {
  const errors = r.diagnostics.filter((d) => d.severity === 'error');
  if (!errors.length) return;
  const unsupported = errors.find((d) => d.code === 'spec_unsupported');
  throw new AppError(unsupported ? 'spec_unsupported' : 'spec_invalid', unsupported?.message ?? `The spec has ${errors.length} error(s)`, { extensions: { diagnostics: errors.slice(0, 50) } });
}

async function compileBytes(bytes: Uint8Array, slug: string, format?: string, graphql?: { selectionDepth?: number; endpointPath?: string }, overlay?: string): Promise<CompileResult> {
  return compile({ spec: { bytes, ...(format ? { format: format as never } : {}), ...(graphql ? { graphql } : {}) }, ...(overlay ? { overlay } : {}), namespace: slug.replace(/-/g, '_') });
}

export function connectConfig(c: ApiContext, s: { slug: string; name: string; exposure: unknown }, e: Parameters<typeof environmentRuntime>[0], listedTools: number, codeMode: boolean): ConnectConfig {
  const url = `${c.config.publicUrl}/mcp/${s.slug}/${e.slug}`;
  const rt = environmentRuntime(e);
  const exposure = parseExposure(s.exposure);
  const name = `${s.slug}-${e.slug}`;
  const header = 'Authorization: Bearer <NEUROUTER_API_KEY>';
  const codeHeader = `${header}" --header "X-Neurouter-Exposure: code`;
  const jsonCfg = (extra: Record<string, string> = {}) => JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: 'Bearer ${NEUROUTER_API_KEY}', ...extra } } } }, null, 2);
  const vscode = (extra: Record<string, string> = {}) => JSON.stringify({ servers: { [name]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:neurouter-key}', ...extra } } } }, null, 2);
  const curl = (extra = '') => `curl -s ${url} -H "${header}" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream"${extra} -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`;
  return {
    mcpUrl: url,
    resourceMetadataUrl: `${c.config.publicUrl}/.well-known/oauth-protected-resource/mcp/${s.slug}/${e.slug}`,
    environment: { id: e.id, slug: e.slug, kind: e.kind },
    auth: { apiKey: true, oauth: true, externalAs: c.config.externalAs ? { issuer: c.config.externalAs.issuer } : null },
    summary: { exposure: exposure.mode, discovery: exposure.discovery, listedTools, codeMode, writesEnabled: rt.writes.enabled },
    clients: [
      { id: 'claude-code', name: 'Claude Code', snippet: `claude mcp add --transport http ${name} ${url} --header "${header}"`, codeModeOnlySnippet: `claude mcp add --transport http ${name} ${url} --header "${codeHeader}"` },
      { id: 'cursor', name: 'Cursor', snippet: jsonCfg(), codeModeOnlySnippet: jsonCfg({ 'X-Neurouter-Exposure': 'code' }) },
      { id: 'vscode', name: 'VS Code', snippet: vscode(), codeModeOnlySnippet: vscode({ 'X-Neurouter-Exposure': 'code' }) },
      { id: 'http', name: 'HTTP (curl)', snippet: curl(), codeModeOnlySnippet: curl(' -H "X-Neurouter-Exposure: code"') },
    ],
  };
}

function descriptionQuality(t: ToolDef): 'none' | 'short' | 'ok' {
  const d = t.description.trim();
  if (!d || /^(GET|POST|PUT|PATCH|DELETE|HEAD) \//.test(d)) return 'none';
  return d.length < 40 ? 'short' : 'ok';
}

interface PreviewState {
  name: string | null;
  slug: string | null;
  format?: string;
  graphql?: { selectionDepth?: number; endpointPath?: string };
  /** Set when the spec came from introspecting a live endpoint. */
  graphqlEndpoint?: GraphqlEndpointSource;
  overlayYaml: string;
  result: Omit<SpecPreview, 'id' | 'expiresAt' | 'name' | 'slug' | 'overlayDraftYaml'>;
}

function previewFrom(r: CompileResult, slug: string | null, ms: number, diff: SpecPreview['diff']): PreviewState['result'] {
  const visible = r.tools.filter((t) => !t.hidden);
  const ok = r.ok;
  return {
    status: ok ? 'ready' : 'failed',
    stages: (['fetch', 'parse', 'validate', 'normalize', 'generate'] as const).map((name) => ({ name, status: ok || name === 'fetch' || name === 'parse' ? 'ok' : 'failed', durationMs: name === 'generate' ? ms : 0 })),
    kind: r.format ? (r.format.startsWith('graphql') ? 'graphql' : 'openapi') : null,
    format: r.format,
    title: r.title || null,
    suggestedSlug: slug,
    operationCount: r.operationCount,
    counts: { tools: r.tools.length, writeTools: visible.filter((t) => t.risk.write).length, hiddenByDefault: r.tools.length - visible.length },
    diagnostics: r.diagnostics.slice(0, 500),
    tools: r.tools.slice(0, 2000).map((t) => ({
      name: t.name,
      title: t.title,
      method: t.binding.type === 'http' ? t.binding.method : null,
      path: t.binding.type === 'http' ? t.binding.pathTemplate : null,
      field: 'rootType' in t.sourceRef ? `${t.sourceRef.rootType}.${t.sourceRef.field}` : null,
      write: t.risk.write,
      hidden: t.hidden,
      descriptionQuality: descriptionQuality(t),
      suggestedHide: [],
    })),
    lint: ok ? r.lint : null,
    preliminaryScore: ok ? r.lint.score : null,
    diff,
  };
}

function slugify(title: string): string | null {
  const s = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/, '');
  return /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/.test(s) ? s : null;
}

/** servers, opsTools, specs, builds, spec previews, readiness (§14.4, §14.5, §14.15). */
export async function serverRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const envs = new EnvironmentsService(db, c.clock, c.coord, c.config, c.tenantId);
  const v = c.views;

  route(app, 'servers.list', api.servers.list, async (req) => {
    const q = req.query;
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = db.selectFrom('servers').selectAll().where('tenant_id', '=', c.tenantId);
    if (q.q) qb = qb.where((eb) => eb.or([eb('slug', 'like', `%${q.q}%`), eb('name', 'like', `%${q.q}%`)]));
    if (q.status?.length) qb = qb.where('status', 'in', q.status);
    if (q.kind) qb = qb.where('kind', '=', q.kind);
    if (key) qb = qb.where('slug', '>', String(key[0]));
    const rows = await qb.orderBy('slug').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.slug]);
    return { items: await Promise.all(page.items.map((r) => v.serverRow(r))), nextCursor: page.nextCursor };
  });

  const createEnvironments = async (serverId: string, list: EnvironmentCreate[] | undefined) => {
    for (const e of list ?? []) if (e.slug !== 'mock') await envs.create(serverId, e);
  };

  route(app, 'servers.create', api.servers.create, async (req, reply) => {
    const u = requireUser(req);
    const body = req.body;
    const cap = await c.settings.get('codeLimitsCap');
    for (const e of body.environments ?? []) assertWithinCodeCap(e.limits, cap);
    if ('previewId' in body) {
      const p = await db.selectFrom('spec_previews').selectAll().where('id', '=', body.previewId).executeTakeFirst();
      if (!p || p.expires_at <= c.clock.now() || !p.content) throw AppError.notFound('Spec preview');
      const st = parseJsonColumn<PreviewState>(p.state)!;
      const r = await compileBytes(p.content, body.slug, st.format, st.graphql, st.overlayYaml || undefined);
      assertCompiles(r);
      const { server } = await c.servers.create({
        tenantId: c.tenantId,
        slug: body.slug,
        name: body.name,
        ...(body.description !== undefined ? { description: body.description } : {}),
        spec: { bytes: p.content, sourceUrl: p.source_url, ...(st.format ? { formatHint: st.format as never } : {}) },
        specSource: st.graphqlEndpoint ? endpointSpecSource(st.graphqlEndpoint, st.graphql) : { ...(p.source_url ? { url: p.source_url } : { upload: true }), ...(st.format ? { format: st.format } : {}), ...(st.graphql ? { graphql: st.graphql } : {}) },
        overlay: st.overlayYaml.trim() ? { yaml: st.overlayYaml, source: 'console', message: 'Initial overlay from the import wizard' } : null,
        createdBy: u.id,
      });
      await createEnvironments(server.id, body.environments);
      await db.deleteFrom('spec_previews').where('id', '=', p.id).execute();
      reply.status(201);
      return v.serverDetail(await c.servers.get(c.tenantId, server.id));
    }
    if (await c.servers.bySlug(c.tenantId, body.slug)) throw AppError.conflict(`A server named "${body.slug}" already exists`);
    const src = await specBytes(c, body.source);
    const r = await compileBytes(src.bytes, body.slug, body.format, body.graphql);
    assertCompiles(r);
    const { server, build } = await c.servers.create({
      tenantId: c.tenantId,
      slug: body.slug,
      name: body.name,
      ...(body.description !== undefined ? { description: body.description } : {}),
      spec: { bytes: src.bytes, sourceUrl: src.sourceUrl, contentType: src.contentType, ...(body.format ? { formatHint: body.format } : {}) },
      specSource: { ...(src.sourceUrl ? { url: src.sourceUrl } : { upload: true }), ...(body.format ? { format: body.format } : {}), ...(body.graphql ? { graphql: body.graphql } : {}) },
      createdBy: u.id,
    });
    await createEnvironments(server.id, body.environments);
    const jobId = await c.jobs.start('server_import', { serverId: server.id }, u.id, async () => ({ serverId: server.id, buildId: build.build.id, status: build.build.status }));
    return { server: await v.serverDetail(await c.servers.get(c.tenantId, server.id)), jobId };
  });

  route(app, 'servers.get', api.servers.get, async (req) => v.serverDetail(await serverOr404(c, req.params.id)));

  route(app, 'servers.update', api.servers.update, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const b = req.body;
    const touchesFile = b.name !== undefined || b.description !== undefined || b.exposure !== undefined || b.opsTools !== undefined || b.publicReport !== undefined;
    if (touchesFile) assertConsoleManaged(c.config, s, 'This server');
    const set: Record<string, unknown> = { updated_at: c.clock.now() };
    if (b.name !== undefined) set.name = b.name;
    if (b.description !== undefined) set.description = b.description;
    if (b.exposure) set.exposure = toJsonColumn({ ...parseExposure(s.exposure), ...b.exposure });
    if (b.opsTools) set.ops_tools = toJsonColumn({ ...parseOpsTools(s.ops_tools), ...b.opsTools });
    if (b.publicReport !== undefined) set.public_report = b.publicReport ? 1 : 0;
    if (b.status !== undefined) set.status = b.status;
    await db.updateTable('servers').set(set).where('id', '=', s.id).execute();
    await c.coord.publish(CONFIG_CHANGED, { serverId: s.id });
    return v.serverDetail(await serverOr404(c, s.id));
  });

  route(app, 'servers.delete', api.servers.delete, async (req) => {
    const s = await serverOr404(c, req.params.id);
    assertConsoleManaged(c.config, s, 'This server');
    if (req.query.confirm !== s.slug) throw AppError.validation('Type the server slug to confirm', [{ path: ['confirm'], message: `must equal ${s.slug}`, code: 'confirm_mismatch' }]);
    const builds = await db.selectFrom('builds').select('id').where('server_id', '=', s.id).execute();
    for (const b of builds) await unindexBuildTools(db, c.dbs.main.dialect, b.id);
    await db.deleteFrom('api_keys').where('server_id', '=', s.id).execute();
    await db.deleteFrom('servers').where('id', '=', s.id).execute();
    await c.coord.publish(CONFIG_CHANGED, { serverId: s.id });
  });

  route(app, 'servers.connect', api.servers.connect, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const list = await c.servers.environments(s.id);
    const e = (req.query.environmentId ? list.find((x) => x.id === req.query.environmentId) : null) ?? list.find((x) => x.slug === 'mock') ?? list[0];
    if (!e) throw AppError.notFound('Environment');
    const b = await v.buildById(e.build_id);
    const exec = c.ports.executorStatus();
    return connectConfig(c, s, e, b?.visible_count ?? 0, exec.ok && environmentRuntime(e).codeMode);
  });

  /* ---------------------------------------------------------------- ops tools */
  const opsRows = async (serverId: string) => {
    const s = await serverOr404(c, serverId);
    const toggles = parseOpsTools(s.ops_tools);
    const since = c.clock.now() - 7 * 86_400_000;
    const counts = await c.dbs.audit.db.selectFrom('audit_log').select(['tool_name', (eb) => eb.fn.countAll<number>().as('n')]).where('server_id', '=', s.id).where('kind', '=', 'ops_call').where('ts', '>=', since).groupBy('tool_name').execute();
    const byName = new Map(counts.map((r) => [r.tool_name, Number(r.n)]));
    const items = [...OPS_TOOLS, 'read_result' as const].map((op) => ({
      name: `neurouter_${op}`,
      pyName: op === 'read_result' ? null : `ops.${op}`,
      title: OPS_TITLES[op].title,
      description: OPS_TITLES[op].description,
      enabled: op === 'read_result' ? true : toggles[op],
      toggleable: op !== 'read_result',
      visibility: OPS_VISIBILITY[op],
      calls7d: byName.get(`neurouter_${op}`) ?? 0,
    }));
    return { items };
  };
  route(app, 'opsTools.list', api.opsTools.list, async (req) => opsRows(req.params.id));
  route(app, 'opsTools.set', api.opsTools.set, async (req) => {
    const s = await serverOr404(c, req.params.id);
    assertConsoleManaged(c.config, s, 'This server');
    await db.updateTable('servers').set({ ops_tools: toJsonColumn({ ...parseOpsTools(s.ops_tools), ...req.body }), updated_at: c.clock.now() }).where('id', '=', s.id).execute();
    await c.coord.publish(CONFIG_CHANGED, { serverId: s.id });
    return opsRows(s.id);
  });

  /* ---------------------------------------------------------------- specs */
  route(app, 'specs.list', api.specs.list, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    let qb = db.selectFrom('spec_revisions').selectAll().where('server_id', '=', s.id);
    if (key) qb = qb.where('rev', '<', Number(key[0]));
    const rows = await qb.orderBy('rev', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.rev]);
    return { items: await Promise.all(page.items.map((r) => v.specRow(r))), nextCursor: page.nextCursor };
  });

  route(app, 'specs.reimport', api.specs.reimport, async (req, reply) => {
    const u = requireUser(req);
    const s = await serverOr404(c, req.params.id);
    const src = parseJsonColumn<{ url?: string; path?: string; graphqlEndpoint?: string; headerRef?: GraphqlEndpointSource['headerRef'] }>(s.spec_source) ?? {};
    if (s.managed_by === 'file' && c.config.configMode !== 'console') assertConsoleManaged(c.config, s, 'This server\'s spec');
    let input: { bytes: Uint8Array; sourceUrl: string | null; contentType: string | null };
    if ('previewId' in req.body) {
      const p = await db.selectFrom('spec_previews').selectAll().where('id', '=', req.body.previewId).executeTakeFirst();
      if (!p || !p.content || p.expires_at <= c.clock.now()) throw AppError.notFound('Spec preview');
      input = { bytes: p.content, sourceUrl: p.source_url, contentType: null };
    } else if (req.body.source) input = await specBytes(c, req.body.source);
    else if (src.url) input = await specBytes(c, { url: src.url });
    else if (src.graphqlEndpoint) input = await introspectEndpoint(c, { url: src.graphqlEndpoint, ...(src.headerRef ? { headerRef: src.headerRef } : {}) });
    else throw AppError.validation('No stored URL to refetch; upload the spec instead', [{ path: ['source'], message: 'required', code: 'required' }]);
    const r = await compileBytes(input.bytes, s.slug);
    assertCompiles(r);
    const out = await c.servers.reimport(c.tenantId, s.id, input, u.id);
    const jobId = await c.jobs.start('spec_reimport', { serverId: s.id }, u.id, async () => {
      const rev = await db.selectFrom('spec_revisions').selectAll().where('id', '=', out.revisionId).executeTakeFirstOrThrow();
      const fresh = await serverOr404(c, s.id);
      const b = await v.buildById(out.build?.build.id ?? fresh.latest_build_id);
      return { revision: await v.specRow(rev), build: b ? await v.buildRow(b) : null, summary: out.summary, unchanged: out.unchanged };
    });
    reply.status(202);
    return { jobId, status: 'running' as const };
  });

  route(app, 'specs.get', api.specs.get, async (req) => {
    const r = await db.selectFrom('spec_revisions').selectAll().where('id', '=', req.params.id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!r) throw AppError.notFound('Spec revision');
    const sum = parseJsonColumn<Record<string, unknown>>(r.summary) ?? {};
    return { ...(await v.specRow(r)), summary: { added: (sum.added as never) ?? [], removed: (sum.removed as never) ?? [], changed: (sum.changed as never) ?? [], orphanedOverlayKeys: (sum.orphanedOverlayKeys as never) ?? [] } };
  });

  route(app, 'specs.download', api.specs.download, async (req, reply) => {
    const r = await db.selectFrom('spec_revisions').selectAll().where('id', '=', req.params.id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!r) throw AppError.notFound('Spec revision');
    const ext = r.format.startsWith('graphql-sdl') ? 'graphql' : r.format === 'graphql-introspection' ? 'json' : 'yaml';
    return reply.header('content-type', r.content_type ?? (ext === 'json' ? 'application/json' : 'text/plain; charset=utf-8')).header('content-disposition', `attachment; filename="spec-rev${r.rev}.${ext}"`).send(gunzipSync(r.content));
  });

  const toolsOfRevision = async (revId: string): Promise<ToolDef[]> => {
    const b = await db.selectFrom('builds').select('id').where('spec_revision_id', '=', revId).where('status', '=', 'ok').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    return b ? (await v.buildTools(b.id)).map((t) => t.def) : [];
  };
  route(app, 'specs.diff', api.specs.diff, async (req) => {
    const [a, b] = await Promise.all([toolsOfRevision(req.query.against), toolsOfRevision(req.params.id)]);
    const d = diffSpecs(a, b, []);
    return d as never;
  });

  /* ---------------------------------------------------------------- spec previews */
  const previewOut = (id: string, expiresAt: number, st: PreviewState): SpecPreview => ({ id, expiresAt: toIso(expiresAt), name: st.name, slug: st.slug, overlayDraftYaml: st.overlayYaml, ...st.result });
  const previewRow = async (id: string) => {
    const p = await db.selectFrom('spec_previews').selectAll().where('id', '=', id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!p || p.expires_at <= c.clock.now()) throw AppError.notFound('Spec preview');
    return p;
  };

  route(app, 'specs.preview', api.specs.preview, async (req, reply) => {
    const u = requireUser(req);
    const body = req.body;
    if (u.anonymous && (('url' in body.source && body.source.url !== SAMPLE_SPEC_URL) || 'graphqlEndpoint' in body.source)) throw new AppError('forbidden', 'The public demo only previews pasted or uploaded specs', { extensions: { reason: 'demo_read_only' } });
    const started = c.clock.now();
    const source = body.source;
    const endpoint: GraphqlEndpointSource | null = 'graphqlEndpoint' in source ? { url: source.graphqlEndpoint, ...(source.headerRef ? { headerRef: source.headerRef } : {}) } : null;
    const src = endpoint ? await introspectEndpoint(c, endpoint, 'headers' in source ? source.headers : []) : await specBytes(c, source as SpecSourceIn);
    const format = endpoint ? 'graphql-introspection' : body.format;
    const r = await compileBytes(src.bytes, 'preview', format, body.graphql);
    let diff: SpecPreview['diff'] = null;
    if (body.serverId) {
      const s = await serverOr404(c, body.serverId);
      const prev = s.latest_build_id ? (await v.buildTools(s.latest_build_id)).map((t) => t.def) : [];
      diff = diffSpecs(prev, r.tools, []) as never;
    }
    // an introspection result carries no API title: name the draft after the endpoint's host
    const title = endpoint && (!r.title || r.title === 'GraphQL API') ? `${new URL(endpoint.url).hostname} GraphQL` : r.title;
    const slug = slugify(title || '');
    const st: PreviewState = { name: title || null, slug, ...(format ? { format } : {}), ...(endpoint ? { graphqlEndpoint: endpoint } : {}), ...(body.graphql ? { graphql: body.graphql } : {}), overlayYaml: '', result: previewFrom(r, slug, c.clock.now() - started, diff) };
    const id = newId();
    const expires = c.clock.now() + PREVIEW_TTL_MS;
    await db.insertInto('spec_previews').values({ id, tenant_id: c.tenantId, server_id: body.serverId ?? null, status: st.result.status, content: Buffer.from(src.bytes), source_url: src.sourceUrl, state: toJsonColumn(st), created_by: u.id, created_at: c.clock.now(), expires_at: expires }).execute();
    const jobId = await c.jobs.start('spec_preview', { previewId: id }, u.id, async () => previewOut(id, expires, st));
    reply.status(202);
    return { jobId, status: 'running' as const, previewId: id };
  });

  route(app, 'specs.draft', api.specs.draft, async (req) => {
    const p = await previewRow(req.params.id);
    return previewOut(p.id, p.expires_at, parseJsonColumn<PreviewState>(p.state)!);
  });

  route(app, 'specs.draftUpdate', api.specs.draftUpdate, async (req) => {
    const p = await previewRow(req.params.id);
    const st = parseJsonColumn<PreviewState>(p.state)!;
    const b = req.body;
    if (b.slug) {
      if (await c.servers.bySlug(c.tenantId, b.slug)) throw AppError.conflict(`A server named "${b.slug}" already exists`);
      st.slug = b.slug;
    }
    if (b.name) st.name = b.name;
    if (b.graphql) st.graphql = { ...(st.graphql ?? {}), ...b.graphql };
    if (b.overlayOps?.length) {
      try {
        st.overlayYaml = applyOverlayPatch(st.overlayYaml || 'overlay: 1\n', b.overlayOps).yaml;
      } catch (err) {
        throw new AppError('overlay_invalid', (err as Error).message, { extensions: { diagnostics: [] } });
      }
    }
    if (b.overlayOps?.length || b.graphql) {
      const t0 = c.clock.now();
      const r = await compileBytes(p.content!, st.slug ?? 'preview', st.format, st.graphql, st.overlayYaml || undefined);
      st.result = previewFrom(r, st.result.suggestedSlug, c.clock.now() - t0, st.result.diff);
    }
    await db.updateTable('spec_previews').set({ state: toJsonColumn(st), status: st.result.status }).where('id', '=', p.id).execute();
    return previewOut(p.id, p.expires_at, st);
  });

  route(app, 'specs.cancelPreview', api.specs.cancelPreview, async (req) => {
    await db.deleteFrom('spec_previews').where('id', '=', req.params.id).where('tenant_id', '=', c.tenantId).execute();
  });

  /* ---------------------------------------------------------------- builds */
  route(app, 'builds.list', api.builds.list, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    let qb = db.selectFrom('builds').selectAll().where('server_id', '=', s.id).where('temporary', '=', 0);
    if (key) qb = qb.where((eb) => eb.or([eb('created_at', '<', Number(key[0])), eb.and([eb('created_at', '=', Number(key[0])), eb('id', '<', String(key[1]))])]));
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at, r.id]);
    return { items: await Promise.all(page.items.map((r) => v.buildRow(r))), nextCursor: page.nextCursor };
  });

  const buildOr404 = async (id: string) => {
    const b = await db.selectFrom('builds').selectAll().where('id', '=', id).where('tenant_id', '=', c.tenantId).executeTakeFirst();
    if (!b) throw AppError.notFound('Build');
    return b;
  };
  route(app, 'builds.get', api.builds.get, async (req) => {
    const b = await buildOr404(req.params.id);
    return { ...(await v.buildRow(b)), diagnostics: c.builds.diagnostics(b), lint: v.lint(b), orphanedOverlayKeys: parseJsonColumn<string[]>(b.orphaned_overlay_keys) ?? [] };
  });
  route(app, 'builds.stubs', api.builds.stubs, async (req) => {
    const b = await buildOr404(req.params.id);
    return { namespaces: Object.entries(v.stubs(b)).map(([name, pyi]) => ({ name, pyi })) };
  });

  /* ---------------------------------------------------------------- readiness */
  route(app, 'readiness.get', api.readiness.get, async (req) => {
    const s = await serverOr404(c, req.params.id);
    return (await v.readiness(s)) ?? { score: 0, band: readinessBand(0), confidence: 'preliminary' as const, runId: null, measuredAt: null, recommendedMode: null, recommendation: null, modeScores: {}, breakdown: [] };
  });

  void toBool;
  void parseOverlay;
}
