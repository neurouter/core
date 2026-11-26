import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { Kysely } from 'kysely';
import { LineCounter, parseDocument, isMap, isSeq, type Node } from 'yaml';
import { clampCodeLimits, effectiveConfirm, NeurouterYaml, parseSecretRef, type Diagnostic, type YamlEnvironment, type YamlServer, type YamlUpstreamAuth } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { sha256Hex } from '../../kernel/lib/crypto.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import { CONFIG_CHANGED, type UpstreamAuthDescriptor } from '../../kernel/runtime-config.js';
import type { SettingsService } from '../../kernel/settings/settings.service.js';
import type { ServersService } from '../servers/servers.service.js';
import type { SpecFetcher } from '../servers/fetch-spec.js';
import { configWarnings } from './file-env.js';

export interface ParsedConfig {
  ok: boolean;
  config: NeurouterYaml | null;
  diagnostics: Diagnostic[];
  /** dotted path (`servers.0.environments.1`) → 1-based line */
  lines: Map<string, number>;
  hash: string;
}

/** Parse + validate (zod) with `file:line:col` diagnostics (§6.2). */
export function parseConfigYaml(text: string, file = 'neurouter.yaml'): ParsedConfig {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, keepSourceTokens: false });
  const diagnostics: Diagnostic[] = [];
  const lines = new Map<string, number>();
  for (const e of doc.errors) diagnostics.push({ severity: 'error', code: 'yaml_syntax', message: e.message, line: e.linePos?.[0]?.line ?? 1, col: e.linePos?.[0]?.col ?? 1, pointer: file });
  const walk = (node: Node | null | undefined, path: string) => {
    if (!node) return;
    if (node.range) lines.set(path, lc.linePos(node.range[0]).line);
    if (isMap(node)) for (const p of node.items) walk(p.value as Node, path ? `${path}.${String((p.key as { value?: unknown })?.value)}` : String((p.key as { value?: unknown })?.value));
    else if (isSeq(node)) node.items.forEach((it, i) => walk(it as Node, `${path}.${i}`));
  };
  walk(doc.contents as Node, '');
  const hash = sha256Hex(text);
  if (diagnostics.length) return { ok: false, config: null, diagnostics, lines, hash };
  const parsed = NeurouterYaml.safeParse(doc.toJS());
  if (!parsed.success) {
    for (const i of parsed.error.issues) {
      const p = i.path.join('.');
      let line = lines.get(p);
      for (let k = i.path.length; line === undefined && k > 0; k--) line = lines.get(i.path.slice(0, k).join('.'));
      diagnostics.push({ severity: 'error', code: 'config_invalid', message: `${p || '(root)'}: ${i.message}`, line: line ?? 1, col: 1, pointer: file });
    }
    return { ok: false, config: null, diagnostics, lines, hash };
  }
  diagnostics.push(...configWarnings(parsed.data, (p) => lines.get(p) ?? 1, file));
  return { ok: true, config: parsed.data, diagnostics, lines, hash };
}

/** YAML auth → runtime descriptor (secret REFERENCES only). */
export function authDescriptor(a: YamlUpstreamAuth): UpstreamAuthDescriptor {
  switch (a.type) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', secret: a.secret };
    case 'header':
      return { type: 'header', header: { name: a.header.name, secret: a.header.secret } };
    case 'query':
      return { type: 'query', query: { name: a.query.name, secret: a.query.secret } };
    case 'basic':
      return { type: 'basic', username: a.username, secret: a.secret };
    case 'oauth_client_credentials':
      return { type: 'oauth_client_credentials', tokenUrl: a.oauth_client_credentials.tokenUrl, clientId: a.oauth_client_credentials.clientId, clientSecret: a.oauth_client_credentials.clientSecret, scopes: a.oauth_client_credentials.scopes };
    case 'oauth_passthrough':
      return {
        type: 'oauth_passthrough',
        ...(a.oauth_passthrough ? { authorizationUrl: a.oauth_passthrough.authorizationUrl, tokenUrl: a.oauth_passthrough.tokenUrl, clientId: a.oauth_passthrough.clientId, ...(a.oauth_passthrough.clientSecret ? { clientSecret: a.oauth_passthrough.clientSecret } : {}), scopes: a.oauth_passthrough.scopes } : {}),
        ...(a.forwardInboundToken ? { forwardInboundToken: true } : {}),
        ...(a.upstreamAudience ? { upstreamAudience: a.upstreamAudience } : {}),
      };
  }
}

export interface ReconcileResult {
  ok: boolean;
  diagnostics: Diagnostic[];
  servers: { created: string[]; updated: string[]; removed: string[] };
  environments: { created: number; updated: number; removed: number };
  dryRun: boolean;
}

export interface ConfigSyncDeps {
  db: Kysely<MainDB>;
  clock: Clock;
  coord: CoordinationStore;
  servers: ServersService;
  settings: SettingsService;
  audit: AuditRecorder;
  fetchSpec: SpecFetcher;
  tenantId: string;
}

/**
 * GitOps reconcile (§6.2): parse → validate → resolve `path:` relative to the file → upsert servers
 * and environments as `managed_by = 'file'` (+ config path/line). File-managed rows that disappear
 * from the file become `removed_from_config` (never deleted, A26). Spec changes create a new revision
 * and build; overlay files are published as `source: file` revisions.
 */
export class ConfigSync {
  constructor(private readonly d: ConfigSyncDeps) {}

  async loadFile(path: string, opts: { dryRun?: boolean } = {}): Promise<ReconcileResult> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (err) {
      const diagnostics: Diagnostic[] = [{ severity: 'error', code: 'config_unreadable', message: `${path}: ${(err as Error).message}`, line: 1, col: 1 }];
      await this.saveState(path, null, 'error', diagnostics);
      return { ok: false, diagnostics, servers: { created: [], updated: [], removed: [] }, environments: { created: 0, updated: 0, removed: 0 }, dryRun: Boolean(opts.dryRun) };
    }
    return this.apply(text, path, opts);
  }

  async apply(text: string, path: string, opts: { dryRun?: boolean } = {}): Promise<ReconcileResult> {
    const parsed = parseConfigYaml(text, path);
    const out: ReconcileResult = { ok: parsed.ok, diagnostics: [...parsed.diagnostics], servers: { created: [], updated: [], removed: [] }, environments: { created: 0, updated: 0, removed: 0 }, dryRun: Boolean(opts.dryRun) };
    if (!parsed.ok || !parsed.config) {
      if (!opts.dryRun) await this.saveState(path, parsed.hash, 'error', out.diagnostics);
      return out;
    }
    const cfg = parsed.config;
    const base = dirname(path);
    // resolve specs and overlays first (I/O), so a failure changes nothing
    const resolved: Array<{ s: YamlServer; index: number; bytes: Uint8Array; sourceUrl: string | null; overlay: string | null }> = [];
    for (const [index, s] of cfg.servers.entries()) {
      const line = parsed.lines.get(`servers.${index}`) ?? 1;
      try {
        const src = s.spec as { url?: string; path?: string };
        const bytes = src.url ? (await this.d.fetchSpec(src.url)).bytes : await readFile(isAbsolute(src.path!) ? src.path! : resolve(base, src.path!));
        const overlay = s.overlay ? await readFile(isAbsolute(s.overlay) ? s.overlay : resolve(base, s.overlay), 'utf8') : null;
        resolved.push({ s, index, bytes, sourceUrl: src.url ?? null, overlay });
      } catch (err) {
        out.diagnostics.push({ severity: 'error', code: 'spec_fetch_failed', message: `servers.${index} (${s.slug}): ${(err as Error).message}`, line, col: 1, pointer: path });
      }
    }
    if (out.diagnostics.some((d) => d.severity === 'error')) {
      out.ok = false;
      if (!opts.dryRun) await this.saveState(path, parsed.hash, 'error', out.diagnostics);
      return out;
    }
    // per-environment code limits above the instance cap are clamped at runtime: say so
    const cap = await this.d.settings.get('codeLimitsCap');
    for (const [si, s] of cfg.servers.entries()) {
      for (const [ei, e] of (s.environments ?? []).entries()) {
        if (!e.limits?.code) continue;
        const { over } = clampCodeLimits({ ...cap, ...e.limits.code }, cap);
        for (const o of over) out.diagnostics.push({ severity: 'warning', code: 'limits_capped', message: `servers.${si}.environments.${ei}.limits.code.${o.field}: ${o.value} is above the instance cap ${o.cap}; ${o.cap} applies`, line: parsed.lines.get(`servers.${si}.environments.${ei}.limits.code.${o.field}`) ?? parsed.lines.get(`servers.${si}.environments.${ei}`) ?? 1, col: 1, pointer: path });
      }
    }
    if (opts.dryRun) return out;

    const tenantId = this.d.tenantId;
    const seenServers = new Set<string>();
    for (const r of resolved) {
      const { s, index } = r;
      const line = parsed.lines.get(`servers.${index}`) ?? 1;
      const specSource = { ...(r.sourceUrl ? { url: r.sourceUrl } : { path: (s.spec as { path?: string }).path }), ...((s.spec as { format?: string }).format ? { format: (s.spec as { format?: string }).format } : {}), ...((s.spec as { graphql?: unknown }).graphql ? { graphql: (s.spec as { graphql?: unknown }).graphql } : {}), ...((s.spec as { refresh?: string }).refresh ? { refresh: (s.spec as { refresh?: string }).refresh } : {}) };
      const exposure = { mode: s.exposure?.mode ?? 'auto', discovery: s.exposure?.discovery ?? 'auto', pinned: s.exposure?.pinned ?? [] };
      let server = await this.d.servers.bySlug(tenantId, s.slug);
      try {
        if (!server) {
          const created = await this.d.servers.create({
            tenantId,
            slug: s.slug,
            name: s.name ?? s.slug,
            description: s.description ?? '',
            spec: { bytes: r.bytes, sourceUrl: r.sourceUrl, ...((s.spec as { format?: string }).format ? { formatHint: (s.spec as { format?: string }).format as never } : {}) },
            specSource,
            exposure,
            opsTools: s.opsTools ?? {},
            publicReport: s.publicReport ?? false,
            managedBy: 'file',
            config: { path, line },
            overlay: r.overlay ? { yaml: r.overlay, source: 'file', message: `from ${s.overlay}` } : null,
            overlayPath: s.overlay ?? null,
            createdBy: null,
          });
          server = created.server;
          out.servers.created.push(s.slug);
          for (const d of created.build.result.diagnostics.filter((x) => x.severity === 'error')) out.diagnostics.push({ ...d, message: `${s.slug}: ${d.message}` });
        } else {
          await this.d.db
            .updateTable('servers')
            .set({ name: s.name ?? s.slug, description: s.description ?? '', spec_source: toJsonColumn(specSource), exposure: toJsonColumn(exposure), ops_tools: toJsonColumn({ ...this.d.servers.opsTools(server), ...(s.opsTools ?? {}) }), public_report: s.publicReport ? 1 : 0, overlay_path: s.overlay ?? null, status: 'active', managed_by: 'file', config_path: path, config_line: line, updated_at: this.d.clock.now() })
            .where('id', '=', server.id)
            .execute();
          const re = await this.d.servers.reimport(tenantId, server.id, { bytes: r.bytes, sourceUrl: r.sourceUrl }, null);
          if (r.overlay !== null) {
            const cur = await this.d.db.selectFrom('overlay_revisions').select(['hash']).where('id', '=', server.published_overlay_revision_id ?? '').executeTakeFirst();
            if (cur?.hash !== sha256Hex(r.overlay)) await this.d.servers.publishOverlay(tenantId, server.id, r.overlay, { message: `from ${s.overlay}`, source: 'file', createdBy: null, basedOnRev: null });
          }
          if (!re.unchanged || r.overlay !== null) out.servers.updated.push(s.slug);
          server = await this.d.servers.get(tenantId, server.id);
        }
      } catch (err) {
        out.diagnostics.push({ severity: 'error', code: 'config_apply_failed', message: `${s.slug}: ${(err as Error).message}`, line, col: 1, pointer: path });
        continue;
      }
      seenServers.add(server.id);
      const env = await this.reconcileEnvironments(server.id, s, index, parsed, path);
      out.environments.created += env.created;
      out.environments.updated += env.updated;
      out.environments.removed += env.removed;
    }
    // file-managed servers missing from the file → removed_from_config
    const managed = await this.d.db.selectFrom('servers').select(['id', 'slug']).where('tenant_id', '=', tenantId).where('managed_by', '=', 'file').where('status', '!=', 'removed_from_config').execute();
    for (const m of managed) {
      if (seenServers.has(m.id)) continue;
      await this.d.db.updateTable('servers').set({ status: 'removed_from_config', updated_at: this.d.clock.now() }).where('id', '=', m.id).execute();
      await this.d.db.updateTable('environments').set({ status: 'removed_from_config' }).where('server_id', '=', m.id).where('managed_by', '=', 'file').execute();
      out.servers.removed.push(m.slug);
    }
    await this.applySettings(cfg);
    out.ok = !out.diagnostics.some((d) => d.severity === 'error');
    await this.saveState(path, parsed.hash, out.ok ? 'ok' : 'error', out.diagnostics);
    this.d.audit.system('config.apply', { kind: 'config_apply', targetType: 'config', targetId: path, changes: { servers: out.servers, environments: out.environments } });
    await this.d.coord.publish(CONFIG_CHANGED, {});
    return out;
  }

  private async reconcileEnvironments(serverId: string, s: YamlServer, index: number, parsed: ParsedConfig, path: string): Promise<{ created: number; updated: number; removed: number }> {
    const res = { created: 0, updated: 0, removed: 0 };
    const now = this.d.clock.now();
    const existing = await this.d.servers.environments(serverId);
    const seen = new Set<string>();
    const latest = (await this.d.db.selectFrom('servers').select('latest_build_id').where('id', '=', serverId).executeTakeFirst())?.latest_build_id ?? null;
    for (const [ei, e] of (s.environments ?? []).entries()) {
      const line = parsed.lines.get(`servers.${index}.environments.${ei}`) ?? 1;
      const row = this.envColumns(e);
      let buildId: string | null | undefined;
      if (e.build) {
        const b = await this.d.db.selectFrom('builds').select('id').where('server_id', '=', serverId).where('hash', 'like', `${e.build}%`).where('status', '=', 'ok').executeTakeFirst();
        buildId = b?.id ?? null;
      }
      const cur = existing.find((x) => x.slug === e.slug);
      seen.add(e.slug);
      if (cur) {
        await this.d.db
          .updateTable('environments')
          .set({ ...row, status: 'active', managed_by: 'file', config_path: path, config_line: line, builtin: 0, updated_at: now, ...(buildId ? { build_id: buildId } : {}) })
          .where('id', '=', cur.id)
          .execute();
        res.updated++;
      } else {
        await this.d.db
          .insertInto('environments')
          .values({ id: newId(), tenant_id: this.d.tenantId, server_id: serverId, slug: e.slug, ...row, build_id: buildId ?? latest, status: 'active', managed_by: 'file', config_path: path, config_line: line, created_at: now, updated_at: now })
          .execute();
        res.created++;
      }
    }
    for (const x of existing) {
      if (seen.has(x.slug) || x.managed_by !== 'file' || x.builtin === 1) continue;
      await this.d.db.updateTable('environments').set({ status: 'removed_from_config', updated_at: now }).where('id', '=', x.id).execute();
      res.removed++;
    }
    return res;
  }

  envColumns(e: YamlEnvironment) {
    const confirm = effectiveConfirm(e.kind, e.writes.confirm);
    return {
      name: e.name ?? e.slug,
      kind: e.kind,
      base_url: e.baseUrl,
      auth: toJsonColumn(authDescriptor(e.auth)),
      headers: toJsonColumn(e.headers),
      writes: toJsonColumn({ enabled: e.writes.enabled, tools: e.writes.tools ?? null, confirm }),
      code_mode: e.codeMode ? (1 as const) : (0 as const),
      limits: toJsonColumn(e.limits ?? {}),
      policies: toJsonColumn(e.policies),
      allowed_hosts: toJsonColumn(e.allowedHosts ?? []),
      allow_http: e.allowHttp ? (1 as const) : (0 as const),
      auto_promote: (e.autoPromote ?? e.kind !== 'prod') ? (1 as const) : (0 as const),
    };
  }

  private async applySettings(cfg: NeurouterYaml): Promise<void> {
    const st = cfg.settings;
    if (!st) return;
    if (st.codeMode?.enabled !== undefined) await this.d.settings.set('codeModeEnabled', st.codeMode.enabled);
    if (st.evals?.model) await this.d.settings.set('evalModel', st.evals.model);
    if (st.evals?.judgeModel) await this.d.settings.set('judgeModel', st.evals.judgeModel);
    if (st.evals?.generatorModel) await this.d.settings.set('generatorModel', st.evals.generatorModel);
    if (st.evals?.fallbacks) await this.d.settings.set('evalFallbacks', st.evals.fallbacks);
    if (st.discovery) await this.d.settings.set('nativeSearchClients', st.discovery.nativeSearchClients);
    if (st.audit?.storeOutputs !== undefined) await this.d.settings.set('auditStoreFullOutput', st.audit.storeOutputs);
    if (st.audit?.webhook !== undefined || st.audit?.otelLogs !== undefined) {
      const cur = await this.d.settings.get('auditSinks');
      const w = st.audit.webhook;
      const secretRef = w?.secret && parseSecretRef(w.secret)?.kind === 'env' ? w.secret : null;
      await this.d.settings.set('auditSinks', {
        webhook: w ? { url: w.url, secretRef, enabled: w.enabled } : cur.webhook,
        otelLogs: { enabled: st.audit.otelLogs ?? cur.otelLogs.enabled },
      });
    }
    // settings.tasks: deprecated, ignored (warned by parseConfigYaml); evals.apiKey is read at boot (file-env.ts)
    if (st.evals?.effort) await this.d.settings.set('evalEffort', st.evals.effort);
    if (st.evals?.repeats) await this.d.settings.set('evalRepeats', st.evals.repeats);
    if (st.retentionDays) await this.d.settings.set('retentionDays', st.retentionDays);
    if (cfg.instance?.name) await this.d.settings.set('orgName', cfg.instance.name);
  }

  private async saveState(path: string, hash: string | null, status: 'ok' | 'error', diagnostics: Diagnostic[]): Promise<void> {
    const row = { path, hash, applied_at: this.d.clock.now(), status, diagnostics: toJsonColumn(diagnostics) };
    await this.d.db
      .insertInto('config_state')
      .values({ tenant_id: this.d.tenantId, ...row })
      .onConflict((oc) => oc.column('tenant_id').doUpdateSet(row))
      .execute();
  }

  async state(): Promise<{ path: string | null; hash: string | null; appliedAt: number | null; status: 'ok' | 'error' | null; diagnostics: Diagnostic[] }> {
    const r = await this.d.db.selectFrom('config_state').selectAll().where('tenant_id', '=', this.d.tenantId).executeTakeFirst();
    if (!r) return { path: null, hash: null, appliedAt: null, status: null, diagnostics: [] };
    return { path: r.path, hash: r.hash, appliedAt: r.applied_at, status: r.status, diagnostics: parseJsonColumn<Diagnostic[]>(r.diagnostics) ?? [] };
  }
}
