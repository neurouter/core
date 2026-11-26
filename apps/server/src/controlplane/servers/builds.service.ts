import { gunzipSync, gzipSync } from 'node:zlib';
import type { Kysely, Selectable } from 'kysely';
import { compile, COMPILER_VERSION, diffSpecs, type CompileResult } from '@neurouter/compiler';
import type { Diagnostic, SpecFormat, ToolDef } from '@neurouter/shared';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { BuildsTable, MainDB } from '../../kernel/db/schema.js';
import { indexBuildTools } from '../../kernel/db/tools-fts.js';
import type { Dialect } from '../../kernel/db/url.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { sha256Hex } from '../../kernel/lib/crypto.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import { CONFIG_CHANGED } from '../../kernel/runtime-config.js';

export type BuildRow = Selectable<BuildsTable>;

export interface BuildOutcome {
  build: BuildRow;
  result: CompileResult;
  created: boolean;
}

/** Text indexed for search beyond name/title/description: Python signature, params, example titles (§9.4). */
export function searchText(t: ToolDef): string {
  const props = (t.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
  const params = Object.entries(props)
    .map(([k, v]) => `${k} ${typeof v?.description === 'string' ? v.description.slice(0, 120) : ''}`)
    .join(' ');
  const ex = t.examples.map((e) => e.title ?? '').join(' ');
  return `${t.pySignature} ${params} ${ex} ${t.tags.join(' ')}`.slice(0, 4000);
}

export function gz(v: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(v), 'utf8'));
}

export function gunz<T>(b: Buffer | null | undefined): T | null {
  return b ? (JSON.parse(gunzipSync(b).toString('utf8')) as T) : null;
}

/**
 * Builds (§7.2, §8): compile(spec revision + overlay revision) once per hash, store tools (+ FTS),
 * stubs and the mock model; pin to dev/qa (and mock) environments, prod only with autoPromote (A3).
 */
export class BuildsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly dialect: Dialect,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly opts: { onBuild?: (buildId: string) => void } = {},
  ) {}

  async specBytes(specRevisionId: string): Promise<{ bytes: Buffer; format: SpecFormat; hash: string }> {
    const r = await this.db.selectFrom('spec_revisions').select(['content', 'format', 'content_hash']).where('id', '=', specRevisionId).executeTakeFirstOrThrow();
    return { bytes: gunzipSync(r.content), format: r.format, hash: r.content_hash };
  }

  /** Pure compile (no writes): previews, overlay validation, suggestion validation. */
  async compileWith(serverId: string, overlayYaml: string | null, specRevisionId?: string): Promise<CompileResult> {
    const s = await this.db.selectFrom('servers').select(['slug', 'spec_source', 'current_spec_revision_id', 'exposure']).where('id', '=', serverId).executeTakeFirstOrThrow();
    const revId = specRevisionId ?? s.current_spec_revision_id;
    if (!revId) throw new Error('server has no spec');
    const spec = await this.specBytes(revId);
    const src = parseJsonColumn<{ graphql?: { selectionDepth?: number; endpointPath?: string } }>(s.spec_source) ?? {};
    const exposure = parseJsonColumn<{ discovery?: 'auto' | 'full' | 'search'; pinned?: string[] }>(s.exposure) ?? {};
    return compile({
      spec: { bytes: spec.bytes, format: spec.format, ...(src.graphql ? { graphql: src.graphql } : {}) },
      ...(overlayYaml ? { overlay: overlayYaml } : {}),
      namespace: s.slug.replace(/-/g, '_'),
      options: { ...(exposure.discovery ? { discovery: exposure.discovery } : {}), ...(exposure.pinned ? { pinned: exposure.pinned } : {}) },
    });
  }

  async overlayYaml(overlayRevisionId: string | null): Promise<string | null> {
    if (!overlayRevisionId) return null;
    const r = await this.db.selectFrom('overlay_revisions').select('yaml').where('id', '=', overlayRevisionId).executeTakeFirst();
    return r?.yaml ?? null;
  }

  /** Creates (or reuses by hash) the build for spec rev × overlay rev. Temporary builds are never pinned. */
  async build(serverId: string, specRevisionId: string, overlayRevisionId: string | null, opts: { temporary?: boolean; overlayYaml?: string | null; pin?: boolean } = {}): Promise<BuildOutcome> {
    const yaml = opts.overlayYaml !== undefined ? opts.overlayYaml : await this.overlayYaml(overlayRevisionId);
    const result = await this.compileWith(serverId, yaml, specRevisionId);
    const s = await this.db.selectFrom('servers').select(['tenant_id']).where('id', '=', serverId).executeTakeFirstOrThrow();
    const existing = await this.db.selectFrom('builds').selectAll().where('tenant_id', '=', s.tenant_id).where('server_id', '=', serverId).where('hash', '=', result.hash).executeTakeFirst();
    if (existing) {
      if (!opts.temporary && existing.status === 'ok' && opts.pin !== false) await this.afterBuild(serverId, existing.id, existing.temporary === 1 ? 'promote' : 'pin');
      return { build: existing, result, created: false };
    }
    const id = newId();
    const status = result.ok ? 'ok' : 'error';
    const visible = result.tools.filter((t) => !t.hidden);
    const row = {
      id,
      tenant_id: s.tenant_id,
      server_id: serverId,
      spec_revision_id: specRevisionId,
      overlay_revision_id: overlayRevisionId,
      temporary: opts.temporary ? (1 as const) : (0 as const),
      compiler_version: COMPILER_VERSION,
      hash: result.hash,
      status: status as 'ok' | 'error',
      diagnostics: toJsonColumn(result.diagnostics),
      tool_count: result.tools.length,
      visible_count: visible.length,
      write_tool_count: visible.filter((t) => t.risk.write).length,
      hidden_count: result.tools.length - visible.length,
      lint: toJsonColumn(result.lint),
      lint_score: result.lint.score,
      orphaned_overlay_keys: toJsonColumn(result.orphanedOverlayKeys),
      profiles: toJsonColumn(result.profiles),
      python_stubs: gz(result.pythonStubs),
      mock_model: result.mockModel ? gz(result.mockModel) : null,
      created_at: this.clock.now(),
    };
    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('builds').values(row).execute();
      if (status === 'ok') {
        const rows = result.tools.map((t) => ({
          id: newId(),
          tenant_id: s.tenant_id,
          build_id: id,
          server_id: serverId,
          key: t.key,
          name: t.name,
          py_name: t.pyName,
          title: t.title,
          description: t.description,
          kind: t.kind,
          write: t.risk.write ? (1 as const) : (0 as const),
          hidden: t.hidden ? (1 as const) : (0 as const),
          pinned: t.pinned ? (1 as const) : (0 as const),
          deprecated: t.deprecated ? (1 as const) : (0 as const),
          tags: toJsonColumn(t.tags),
          def: toJsonColumn(t),
          def_hash: t.defHash,
          search_text: searchText(t),
        }));
        for (let i = 0; i < rows.length; i += 25) await trx.insertInto('tools').values(rows.slice(i, i + 25)).execute();
        await indexBuildTools(trx, this.dialect, id);
      }
    });
    const build = await this.db.selectFrom('builds').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
    if (status === 'ok' && !opts.temporary && opts.pin !== false) await this.afterBuild(serverId, id, 'pin');
    if (status === 'ok') this.opts.onBuild?.(id);
    return { build, result, created: true };
  }

  /** latest_build_id + pins: dev/qa/mock environments follow the latest build; prod only with autoPromote. */
  private async afterBuild(serverId: string, buildId: string, _why: 'pin' | 'promote'): Promise<void> {
    await this.db.updateTable('builds').set({ temporary: 0 }).where('id', '=', buildId).execute();
    await this.db.updateTable('servers').set({ latest_build_id: buildId, updated_at: this.clock.now() }).where('id', '=', serverId).execute();
    const envs = await this.db.selectFrom('environments').select(['id', 'kind', 'auto_promote', 'build_id']).where('server_id', '=', serverId).execute();
    for (const e of envs) {
      if (e.kind === 'prod' && !(e.auto_promote === 1)) {
        if (!e.build_id) await this.db.updateTable('environments').set({ build_id: buildId }).where('id', '=', e.id).execute();
        continue;
      }
      await this.db.updateTable('environments').set({ build_id: buildId, updated_at: this.clock.now() }).where('id', '=', e.id).execute();
    }
    await this.coord.publish(CONFIG_CHANGED, { serverId });
  }

  async pin(environmentId: string, buildId: string): Promise<void> {
    await this.db.updateTable('environments').set({ build_id: buildId, updated_at: this.clock.now() }).where('id', '=', environmentId).execute();
    await this.coord.publish(CONFIG_CHANGED, { environmentId });
  }

  async tools(buildId: string): Promise<ToolDef[]> {
    const rows = await this.db.selectFrom('tools').select('def').where('build_id', '=', buildId).orderBy('seq').execute();
    return rows.map((r) => parseJsonColumn<ToolDef>(r.def)!);
  }

  diagnostics(b: BuildRow): Diagnostic[] {
    return parseJsonColumn<Diagnostic[]>(b.diagnostics) ?? [];
  }

  /** Spec change summary vs the previous revision's latest build (§14.5 SpecChangeSummary). */
  async summaryVs(prevBuildId: string | null, next: CompileResult, overlayKeys: string[]) {
    const prev = prevBuildId ? await this.tools(prevBuildId) : [];
    return diffSpecs(prev, next.tools, overlayKeys);
  }
}

export function contentHash(bytes: Uint8Array): string {
  return sha256Hex(Buffer.from(bytes));
}
