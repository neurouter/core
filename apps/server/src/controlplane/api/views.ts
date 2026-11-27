import type { EnvRefGate } from '../../kernel/secrets/env-refs.js';
import { gunzipSync } from 'node:zlib';
import type { Kysely, Selectable } from 'kysely';
import {
  DEFAULT_LIMITS,
  readinessBand,
  type BuildRow as BuildRowApi,
  type EnvironmentDetail,
  type OverlayRevisionRow as OverlayRevisionRowApi,
  type ReadinessSummary,
  type ServerDetail,
  type ServerRow as ServerRowApi,
  type SpecRevisionRow as SpecRevisionRowApi,
  type ToolDef,
  type ToolRow as ToolRowApi,
  type UpstreamAuthOut,
  type Diagnostic,
  type LintReport,
} from '@neurouter/shared';
import type { BuildsTable, EnvironmentsTable, MainDB, OverlayRevisionsTable, ServersTable, SpecRevisionsTable } from '../../kernel/db/schema.js';
import { toIso } from '../../kernel/lib/clock.js';
import { parseJsonColumn, toBool } from '../../kernel/lib/json.js';
import { environmentRuntime, parseExposure, parseOpsTools, type UpstreamAuthDescriptor } from '../../kernel/runtime-config.js';
import type { NamedSecrets } from '../../kernel/secrets/named-secrets.js';

type Srv = Selectable<ServersTable>;
type Env = Selectable<EnvironmentsTable>;
type Build = Selectable<BuildsTable>;
type SpecRev = Selectable<SpecRevisionsTable>;
type OverlayRev = Selectable<OverlayRevisionsTable>;

export const DELETED = '(deleted)';

export function firstSentence(s: string): string {
  const line = s.split('\n')[0] ?? '';
  const m = /^(.+?[.!?])(\s|$)/.exec(line);
  return (m ? m[1]! : line).slice(0, 300);
}

export function mask(s: string, anonymous: boolean): string {
  if (!anonymous) return s;
  if (s.startsWith('env:') || s.startsWith('secret:')) return `${s.split(':')[0]}:••••`;
  return s.length > 12 ? `${s.slice(0, 9)}••••` : '••••';
}

/** Row → API mappers shared by the console routes. */
export class Views {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly publicUrl: string,
    private readonly secrets: NamedSecrets,
    /** `env:NAME` presence is revealed only for references the env's tenant may use (G12: no oracle on gateway variables). */
    private readonly envRefs: Pick<EnvRefGate, 'read'>,
  ) {}

  async userRef(id: string | null): Promise<{ id: string; name: string } | null> {
    if (!id) return null;
    const u = await this.db.selectFrom('users').select(['id', 'name', 'email']).where('id', '=', id).executeTakeFirst();
    return { id, name: u ? u.name || u.email : DELETED };
  }

  async specRow(r: SpecRev): Promise<SpecRevisionRowApi> {
    return { id: r.id, rev: r.rev, format: r.format, title: r.title, apiVersion: r.api_version, operationCount: r.operation_count, contentHash: r.content_hash, contentBytes: r.content_bytes, sourceUrl: r.source_url, createdAt: toIso(r.created_at), createdBy: await this.userRef(r.created_by) };
  }

  async overlayRow(r: OverlayRev): Promise<OverlayRevisionRowApi> {
    const prev = r.rev > 1 ? await this.db.selectFrom('overlay_revisions').where('tenant_id', '=', r.tenant_id).select('id').where('server_id', '=', r.server_id).where('rev', '=', r.rev - 1).executeTakeFirst() : null;
    let toolChanges = 0;
    const b = await this.db.selectFrom('builds').where('tenant_id', '=', r.tenant_id).select('id').where('overlay_revision_id', '=', r.id).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    if (b) {
      const pb = prev ? await this.db.selectFrom('builds').where('tenant_id', '=', r.tenant_id).select('id').where('overlay_revision_id', '=', prev.id).orderBy('created_at', 'desc').limit(1).executeTakeFirst() : null;
      // tenant-scope: child-of-scoped (build of a tenant-scoped revision)
      const cur = await this.db.selectFrom('tools').select(['name', 'def_hash', 'key']).where('build_id', '=', b.id).execute();
      // tenant-scope: child-of-scoped (build of a tenant-scoped revision)
      const before = pb ? new Map((await this.db.selectFrom('tools').select(['key', 'def_hash']).where('build_id', '=', pb.id).execute()).map((t) => [t.key, t.def_hash])) : null;
      if (before) toolChanges = cur.filter((t) => before.get(t.key) !== t.def_hash).length;
      else toolChanges = cur.length;
    }
    return { id: r.id, rev: r.rev, hash: r.hash, message: r.message, source: r.source, basedOnRev: r.based_on_rev, createdBy: await this.userRef(r.created_by), createdAt: toIso(r.created_at), toolChanges };
  }

  async buildRow(b: Build): Promise<BuildRowApi> {
    const spec = await this.db.selectFrom('spec_revisions').where('tenant_id', '=', b.tenant_id).select('rev').where('id', '=', b.spec_revision_id).executeTakeFirst();
    const ov = b.overlay_revision_id ? await this.db.selectFrom('overlay_revisions').where('tenant_id', '=', b.tenant_id).select('rev').where('id', '=', b.overlay_revision_id).executeTakeFirst() : null;
    const diags = parseJsonColumn<Diagnostic[]>(b.diagnostics) ?? [];
    const envs = await this.db.selectFrom('environments').where('tenant_id', '=', b.tenant_id).select('slug').where('build_id', '=', b.id).execute();
    return {
      id: b.id,
      hash: b.hash,
      status: b.status,
      specRev: spec?.rev ?? 0,
      overlayRev: ov?.rev ?? null,
      compilerVersion: b.compiler_version,
      toolCount: b.tool_count,
      visibleCount: b.visible_count,
      writeCount: b.write_tool_count,
      hiddenCount: b.hidden_count,
      lintScore: b.lint_score,
      diagnosticsCount: { error: diags.filter((d) => d.severity === 'error').length, warning: diags.filter((d) => d.severity === 'warning').length, info: diags.filter((d) => d.severity === 'info').length },
      environments: envs.map((e) => e.slug),
      createdAt: toIso(b.created_at),
    };
  }

  lint(b: Build): LintReport {
    const l = parseJsonColumn<LintReport>(b.lint);
    return l && typeof l.score === 'number' ? l : { score: b.lint_score, rules: [], findings: [] };
  }

  async buildById(id: string | null): Promise<Build | null> {
    if (!id) return null;
    // tenant-scope: child-of-scoped (build ids of tenant-scoped servers and environments)
    return (await this.db.selectFrom('builds').selectAll().where('id', '=', id).executeTakeFirst()) ?? null;
  }

  async buildTools(buildId: string): Promise<Array<{ id: string; def: ToolDef }>> {
    // tenant-scope: child-of-scoped (build ids of tenant-scoped servers and environments)
    const rows = await this.db.selectFrom('tools').select(['id', 'def']).where('build_id', '=', buildId).orderBy('seq').execute();
    return rows.map((r) => ({ id: r.id, def: parseJsonColumn<ToolDef>(r.def)! }));
  }

  stubs(b: Build): Record<string, string> {
    return b.python_stubs ? (JSON.parse(gunzipSync(b.python_stubs).toString('utf8')) as Record<string, string>) : {};
  }

  /** Readiness (§15.6): measured = latest succeeded eval run's score; else preliminary = lint score. */
  async readiness(s: Srv): Promise<ReadinessSummary | null> {
    const run = await this.db.selectFrom('eval_runs').where('tenant_id', '=', s.tenant_id).select(['id', 'score', 'headline', 'recommended_mode', 'confidence', 'ended_at']).where('server_id', '=', s.id).where('status', '=', 'succeeded').where('trigger', '!=', 'suggestion_verify').orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    if (run && run.headline !== null) {
      const sc = parseJsonColumn<Record<string, unknown>>(run.score) ?? {};
      const breakdown = Array.isArray(sc.breakdown) ? (sc.breakdown as ReadinessSummary['breakdown']) : [];
      const modeScores = (sc.modeScores as ReadinessSummary['modeScores'] | undefined) ?? {};
      const conf = run.confidence === 'degraded' || run.confidence === 'preliminary' ? run.confidence : 'measured';
      return {
        score: Math.round(run.headline),
        band: readinessBand(run.headline),
        confidence: conf,
        runId: run.id,
        measuredAt: run.ended_at ? toIso(run.ended_at) : null,
        recommendedMode: run.recommended_mode === 'tool' || run.recommended_mode === 'code' ? run.recommended_mode : null,
        recommendation: typeof sc.recommendation === 'string' ? sc.recommendation : typeof sc.recommendationText === 'string' ? sc.recommendationText : null,
        modeScores: { ...(typeof modeScores.tool === 'number' ? { tool: Math.round(modeScores.tool) } : {}), ...(typeof modeScores.code === 'number' ? { code: Math.round(modeScores.code) } : {}) },
        breakdown: breakdown.filter((c) => c && typeof c.key === 'string').map((c) => ({ key: c.key, label: c.label ?? c.key, weight: Math.min(1, Math.max(0, Number(c.weight) || 0)), score: Math.min(1, Math.max(0, Number(c.score) || 0)), detail: c.detail ?? '', fixCount: c.fixCount ?? 0 })),
      };
    }
    const b = await this.buildById(s.latest_build_id);
    if (!b) return null;
    const lint = this.lint(b);
    return { score: b.lint_score, band: readinessBand(b.lint_score), confidence: 'preliminary', runId: null, measuredAt: null, recommendedMode: null, recommendation: null, modeScores: {}, breakdown: [{ key: 'quality', label: 'Tool quality', weight: 1, score: lint.score / 100, detail: `Lint score ${lint.score}/100`, fixCount: lint.findings.length }] };
  }

  envHealth(e: Env): EnvironmentDetail['health'] {
    const h = parseJsonColumn<{ status?: 'up' | 'down' | 'unknown'; checkedAt?: number; latencyMs?: number; error?: string }>(e.health) ?? {};
    if (e.base_url.startsWith('mock:') && !h.status) return { status: 'up', checkedAt: null, latencyMs: 0, error: null };
    return { status: h.status ?? 'unknown', checkedAt: h.checkedAt ? toIso(h.checkedAt) : null, latencyMs: h.latencyMs ?? null, error: h.error ?? null };
  }

  async serverRow(s: Srv): Promise<ServerRowApi> {
    const envs = await this.db.selectFrom('environments').where('tenant_id', '=', s.tenant_id).selectAll().where('server_id', '=', s.id).orderBy('created_at').execute();
    const b = await this.buildById(s.latest_build_id);
    const spec = s.current_spec_revision_id ? await this.db.selectFrom('spec_revisions').where('tenant_id', '=', s.tenant_id).select(['format', 'created_at']).where('id', '=', s.current_spec_revision_id).executeTakeFirst() : null;
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      kind: s.kind,
      specFormat: spec?.format ?? null,
      status: s.status,
      managedBy: s.managed_by,
      toolCount: b?.tool_count ?? 0,
      visibleToolCount: b?.visible_count ?? 0,
      writeToolCount: b?.write_tool_count ?? 0,
      environments: envs.map((e) => ({ id: e.id, slug: e.slug, kind: e.kind, writesEnabled: environmentRuntime(e).writes.enabled, isMock: e.base_url.startsWith('mock:'), health: this.envHealth(e).status })),
      readiness: await this.readiness(s),
      lastSpecAt: spec ? toIso(spec.created_at) : null,
      updatedAt: toIso(s.updated_at),
    };
  }

  async serverDetail(s: Srv): Promise<ServerDetail> {
    const row = await this.serverRow(s);
    const src = parseJsonColumn<{ url?: string; path?: string; upload?: boolean; graphqlEndpoint?: string }>(s.spec_source) ?? {};
    const spec = s.current_spec_revision_id ? await this.db.selectFrom('spec_revisions').where('tenant_id', '=', s.tenant_id).selectAll().where('id', '=', s.current_spec_revision_id).executeTakeFirst() : null;
    const ov = s.published_overlay_revision_id ? await this.db.selectFrom('overlay_revisions').where('tenant_id', '=', s.tenant_id).selectAll().where('id', '=', s.published_overlay_revision_id).executeTakeFirst() : null;
    const draft = await this.db.selectFrom('overlay_drafts').where('tenant_id', '=', s.tenant_id).select(['change_count', 'updated_at']).where('server_id', '=', s.id).executeTakeFirst();
    const b = await this.buildById(s.latest_build_id);
    const fileManaged = s.managed_by === 'file' ? ['name', 'description', 'exposure', 'opsTools', 'publicReport', 'spec', ...(s.overlay_path ? ['overlay'] : [])] : [];
    return {
      ...row,
      description: s.description,
      exposure: parseExposure(s.exposure),
      opsTools: parseOpsTools(s.ops_tools),
      publicReport: toBool(s.public_report),
      publicReportUrl: toBool(s.public_report) ? `${this.publicUrl}/public/servers/${s.slug}/report` : null,
      specSource: { url: src.url ?? src.graphqlEndpoint ?? null, path: src.path ?? null, upload: !src.url && !src.path && !src.graphqlEndpoint },
      currentSpec: spec ? await this.specRow(spec) : null,
      publishedOverlay: ov ? await this.overlayRow(ov) : null,
      draft: draft ? { changeCount: draft.change_count, updatedAt: toIso(draft.updated_at) } : null,
      latestBuild: b ? await this.buildRow(b) : null,
      config: s.config_path ? { path: s.config_path, line: s.config_line } : null,
      fileManagedFields: fileManaged,
    };
  }

  async authOut(e: Env, anonymous: boolean, connected: boolean): Promise<UpstreamAuthOut> {
    const parsed = parseJsonColumn<UpstreamAuthDescriptor>(e.auth);
    const a = (parsed && parsed.type ? parsed : { type: 'none' }) as UpstreamAuthDescriptor;
    const ref = a.type === 'header' ? (a.header?.secret ?? a.secret) : a.type === 'query' ? (a.query?.secret ?? a.secret) : a.type === 'oauth_client_credentials' || a.type === 'oauth_passthrough' ? a.clientSecret : a.secret;
    let state: { hasSecret: boolean; secretUpdatedAt: string | null } = { hasSecret: false, secretUpdatedAt: null };
    if (ref?.startsWith('secret:')) {
      const m = await this.secrets.meta(e.tenant_id, 'environment', e.id, ref.slice(7));
      state = { hasSecret: Boolean(m), secretUpdatedAt: m ? toIso(m.updatedAt) : null };
    } else if (ref?.startsWith('env:')) state = { hasSecret: Boolean(await this.envRefs.read(e.tenant_id, ref.slice(4))), secretUpdatedAt: null };
    const r = (x: string | undefined) => mask(x ?? '', anonymous);
    switch (a.type) {
      case 'none':
        return { type: 'none', ...state };
      case 'bearer':
        return { type: 'bearer', secretRef: r(a.secret), ...state };
      case 'header':
        return { type: 'header', headerName: a.header?.name ?? 'x-api-key', secretRef: r(a.header?.secret ?? a.secret), ...state };
      case 'query':
        return { type: 'query', paramName: a.query?.name ?? 'api_key', secretRef: r(a.query?.secret ?? a.secret), ...state };
      case 'basic':
        return { type: 'basic', username: a.username ?? '', secretRef: r(a.secret), ...state };
      case 'oauth_client_credentials':
        return { type: 'oauth_client_credentials', tokenUrl: a.tokenUrl ?? '', clientId: a.clientId ?? '', clientSecretRef: r(a.clientSecret), scopes: a.scopes ?? [], ...state };
      case 'oauth_passthrough':
        return {
          type: 'oauth_passthrough',
          mode: a.forwardInboundToken ? 'forward_inbound' : 'broker',
          ...(a.authorizationUrl ? { authorizationUrl: a.authorizationUrl } : {}),
          ...(a.tokenUrl ? { tokenUrl: a.tokenUrl } : {}),
          ...(a.clientId ? { clientId: a.clientId } : {}),
          ...(a.clientSecret ? { clientSecretRef: r(a.clientSecret) } : {}),
          scopes: a.scopes ?? [],
          ...(a.upstreamAudience ? { upstreamAudience: a.upstreamAudience } : {}),
          connected,
          connectUrl: a.forwardInboundToken ? null : `${this.publicUrl}/oauth/upstream/${e.id}/connect`,
          ...state,
        };
    }
  }

  async credentialState(e: Env, auth: UpstreamAuthOut): Promise<'ok' | 'missing' | 'not_required'> {
    if (auth.type === 'none' || e.base_url.startsWith('mock:')) return 'not_required';
    if (auth.type === 'oauth_passthrough') return 'ok';
    return auth.hasSecret ? 'ok' : 'missing';
  }

  async envDetail(e: Env, opts: { anonymous?: boolean; userId?: string; connected?: boolean } = {}): Promise<EnvironmentDetail> {
    const rt = environmentRuntime(e);
    const server = await this.db.selectFrom('servers').where('tenant_id', '=', e.tenant_id).select(['slug']).where('id', '=', e.server_id).executeTakeFirstOrThrow();
    const b = await this.buildById(e.build_id);
    const tools = b ? await this.db.selectFrom('tools').where('tenant_id', '=', e.tenant_id).select(['name']).where('build_id', '=', b.id).where('write', '=', 1).where('hidden', '=', 0).execute() : [];
    const writeNames = tools.map((t) => t.name);
    const enabledToolNames = rt.writes.enabled ? (rt.writes.tools === null ? writeNames : writeNames.filter((n) => rt.writes.tools!.includes(n))) : [];
    const auth = await this.authOut(e, Boolean(opts.anonymous), Boolean(opts.connected));
    const limits = parseJsonColumn<Record<string, unknown>>(e.limits) ?? {};
    return {
      id: e.id,
      serverId: e.server_id,
      slug: e.slug,
      name: e.name,
      kind: e.kind,
      baseUrl: e.base_url,
      isMock: rt.isMock,
      builtin: e.builtin === 1,
      status: e.status,
      buildId: e.build_id,
      build: b ? await this.buildRow(b) : null,
      auth,
      headers: opts.anonymous ? Object.fromEntries(Object.keys(rt.headers).map((k) => [k, '••••'])) : rt.headers,
      writes: { enabled: rt.writes.enabled, tools: rt.writes.tools, confirm: rt.writes.confirm, writeToolCount: writeNames.length, enabledToolNames },
      codeMode: rt.codeMode,
      limits: {
        rateLimit: (limits.rateLimit as never) ?? DEFAULT_LIMITS.rateLimit,
        toolRateLimit: (limits.toolRateLimit as never) ?? DEFAULT_LIMITS.toolRateLimit,
        timeoutMs: rt.limits.timeoutMs,
        maxResponseBytes: rt.limits.maxResponseBytes,
        code: rt.limits.code,
        ...(rt.limits.searchResultChars !== undefined ? { searchResultChars: rt.limits.searchResultChars } : {}),
      },
      policies: rt.policies as EnvironmentDetail['policies'],
      discovery: rt.discoveryOverride,
      allowedHosts: rt.allowedHosts,
      allowHttp: rt.allowHttp,
      autoPromote: e.auto_promote === 1,
      health: this.envHealth(e),
      credential: await this.credentialState(e, auth),
      mcpUrl: `${this.publicUrl}/mcp/${server.slug}/${e.slug}`,
      managedBy: e.managed_by,
      config: e.config_path ? { path: e.config_path, line: e.config_line } : null,
      createdAt: toIso(e.created_at),
      updatedAt: toIso(e.updated_at),
    };
  }

  toolRow(id: string, buildId: string, t: ToolDef, opts: { writeEnabledIn: string[]; calls7d: number; errorRate7d: number }): ToolRowApi {
    const b = t.binding;
    return {
      id,
      buildId,
      name: t.name,
      pyName: t.pyName,
      title: t.title,
      summary: firstSentence(t.description),
      kind: t.kind,
      method: b.type === 'http' ? b.method : b.type === 'graphql' ? 'POST' : null,
      path: b.type === 'http' ? b.pathTemplate : null,
      key: t.key,
      write: t.risk.write,
      destructive: t.risk.destructive,
      hidden: t.hidden,
      pinned: t.pinned,
      deprecated: t.deprecated,
      overlayModified: t.overlayApplied.length > 0,
      tags: t.tags,
      writeEnabledIn: opts.writeEnabledIn,
      calls7d: opts.calls7d,
      errorRate7d: opts.errorRate7d,
    };
  }
}
