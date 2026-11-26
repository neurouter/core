import { gzipSync } from 'node:zlib';
import type { Kysely, Selectable } from 'kysely';
import { detectSpec, type CompileResult } from '@neurouter/compiler';
import { DEFAULT_OPS_TOGGLES, type OpsToolToggles, type OverlaySource, type SpecFormat } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { EnvironmentsTable, MainDB, ServersTable } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { sha256Hex } from '../../kernel/lib/crypto.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import { CONFIG_CHANGED, type ExposureConfig } from '../../kernel/runtime-config.js';
import { contentHash, type BuildOutcome, type BuildsService } from './builds.service.js';

export type ServerRowDb = Selectable<ServersTable>;
export type EnvironmentRowDb = Selectable<EnvironmentsTable>;

export interface SpecInput {
  bytes: Uint8Array;
  sourceUrl: string | null;
  contentType?: string | null;
  formatHint?: 'openapi' | 'graphql-sdl' | 'graphql-introspection' | SpecFormat;
}

export interface ServerCreateInput {
  tenantId: string;
  slug: string;
  name: string;
  description?: string;
  spec: SpecInput;
  specSource: Record<string, unknown>;
  exposure?: Partial<ExposureConfig>;
  opsTools?: Partial<OpsToolToggles>;
  publicReport?: boolean;
  managedBy?: 'file' | 'console';
  config?: { path: string; line: number } | null;
  overlay?: { yaml: string; source: OverlaySource; message: string } | null;
  overlayPath?: string | null;
  createdBy: string | null;
}

export const SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;

/** Format detection (§8.2 step 1); Swagger 2.0 is rejected by the compiler (A41). */
export function detectFormat(bytes: Uint8Array, hint?: SpecInput['formatHint']): SpecFormat {
  const d = detectSpec(bytes, hint === 'openapi' ? undefined : (hint as never));
  return (d.format ?? 'openapi-3.1') as SpecFormat;
}

/**
 * Servers, spec revisions and overlay revisions (§7.2 `0002_servers`, §14.4–14.6). Every server
 * gets the built-in `mock` environment (A42) unless one named `mock` is declared.
 */
export class ServersService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly builds: BuildsService,
    private readonly audit: AuditRecorder,
    /** Agent contract written to servers created without one (contract-v2 D4: new servers get v2; existing rows keep v1). */
    private readonly newServerContract: 1 | 2 = 2,
  ) {}

  async bySlug(tenantId: string, slug: string): Promise<ServerRowDb | undefined> {
    return this.db.selectFrom('servers').selectAll().where('tenant_id', '=', tenantId).where('slug', '=', slug).executeTakeFirst();
  }

  async get(tenantId: string, id: string): Promise<ServerRowDb> {
    const s = await this.db.selectFrom('servers').selectAll().where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    if (!s) throw AppError.notFound('Server');
    return s;
  }

  async create(input: ServerCreateInput): Promise<{ server: ServerRowDb; build: BuildOutcome }> {
    if (!SLUG_RE.test(input.slug)) throw AppError.validation('Invalid slug', [{ path: ['slug'], message: 'Use 3–40 lower-case letters, digits and dashes, starting with a letter', code: 'invalid_slug' }]);
    if (await this.bySlug(input.tenantId, input.slug)) throw AppError.conflict(`A server named "${input.slug}" already exists`);
    const format = detectFormat(input.spec.bytes, input.spec.formatHint);
    const now = this.clock.now();
    const id = newId();
    await this.db
      .insertInto('servers')
      .values({
        id,
        tenant_id: input.tenantId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? '',
        kind: format.startsWith('graphql') ? 'graphql' : 'openapi',
        spec_source: toJsonColumn(input.specSource),
        exposure: toJsonColumn({ mode: 'auto', discovery: 'auto', pinned: [], contract: this.newServerContract, ...(input.exposure ?? {}) }),
        ops_tools: toJsonColumn({ ...DEFAULT_OPS_TOGGLES, ...(input.opsTools ?? {}) }),
        public_report: input.publicReport ? 1 : 0,
        overlay_path: input.overlayPath ?? null,
        status: 'active',
        managed_by: input.managedBy ?? 'console',
        config_path: input.config?.path ?? null,
        config_line: input.config?.line ?? null,
        created_by: input.createdBy,
        created_at: now,
        updated_at: now,
      })
      .execute();
    await this.ensureMockEnv(input.tenantId, id);
    const rev = await this.insertSpecRevision(input.tenantId, id, input.spec, format, input.createdBy, null);
    let overlayRevId: string | null = null;
    if (input.overlay) overlayRevId = await this.insertOverlayRevision(input.tenantId, id, input.overlay.yaml, input.overlay.source, input.overlay.message, input.createdBy, null);
    const build = await this.builds.build(id, rev.id, overlayRevId);
    await this.db.updateTable('servers').where('tenant_id', '=', input.tenantId).set({ current_spec_revision_id: rev.id, published_overlay_revision_id: overlayRevId }).where('id', '=', id).execute();
    await this.db.updateTable('spec_revisions').where('tenant_id', '=', input.tenantId).set({ title: build.result.title, api_version: build.result.apiVersion, operation_count: build.result.operationCount }).where('id', '=', rev.id).execute();
    this.audit.admin({ tenantId: input.tenantId, actorUserId: input.createdBy, action: 'server.create', targetType: 'server', targetId: id, serverId: id, after: { slug: input.slug, name: input.name, managedBy: input.managedBy ?? 'console' } });
    return { server: await this.get(input.tenantId, id), build };
  }

  async ensureMockEnv(tenantId: string, serverId: string): Promise<void> {
    const has = await this.db.selectFrom('environments').where('tenant_id', '=', tenantId).select('id').where('server_id', '=', serverId).where('slug', '=', 'mock').executeTakeFirst();
    if (has) return;
    const now = this.clock.now();
    await this.db
      .insertInto('environments')
      .values({ id: newId(), tenant_id: tenantId, server_id: serverId, slug: 'mock', name: 'Mock', kind: 'dev', base_url: 'mock:', writes: toJsonColumn({ enabled: true, tools: null, confirm: 'none' }), code_mode: 1, builtin: 1, status: 'active', managed_by: 'console', created_at: now, updated_at: now })
      .execute();
  }

  private async insertSpecRevision(tenantId: string, serverId: string, spec: SpecInput, format: SpecFormat, createdBy: string | null, summary: unknown): Promise<{ id: string; rev: number }> {
    const last = await this.db.selectFrom('spec_revisions').where('tenant_id', '=', tenantId).select((eb) => eb.fn.max('rev').as('m')).where('server_id', '=', serverId).executeTakeFirst();
    const rev = Number(last?.m ?? 0) + 1;
    const id = newId();
    await this.db
      .insertInto('spec_revisions')
      .values({ id, tenant_id: tenantId, server_id: serverId, rev, format, source_url: spec.sourceUrl, content_type: spec.contentType ?? null, content_hash: contentHash(spec.bytes), content: gzipBytes(spec.bytes), content_bytes: spec.bytes.byteLength, summary: toJsonColumn(summary ?? {}), created_by: createdBy, created_at: this.clock.now() })
      .execute();
    return { id, rev };
  }

  async insertOverlayRevision(tenantId: string, serverId: string, yaml: string, source: OverlaySource, message: string, createdBy: string | null, basedOnRev: number | null): Promise<string> {
    const last = await this.db.selectFrom('overlay_revisions').where('tenant_id', '=', tenantId).select((eb) => eb.fn.max('rev').as('m')).where('server_id', '=', serverId).executeTakeFirst();
    const rev = Number(last?.m ?? 0) + 1;
    const id = newId();
    await this.db.insertInto('overlay_revisions').values({ id, tenant_id: tenantId, server_id: serverId, rev, yaml, hash: sha256Hex(yaml), message: message.slice(0, 500), source, based_on_rev: basedOnRev, created_by: createdBy, created_at: this.clock.now() }).execute();
    return id;
  }

  /** New spec bytes (re-import / refresh): same hash → unchanged; else new revision + build + summary. */
  async reimport(tenantId: string, serverId: string, spec: SpecInput, createdBy: string | null): Promise<{ revisionId: string; build: BuildOutcome | null; unchanged: boolean; summary: unknown }> {
    const s = await this.get(tenantId, serverId);
    const hash = contentHash(spec.bytes);
    if (s.current_spec_revision_id) {
      const cur = await this.db.selectFrom('spec_revisions').where('tenant_id', '=', tenantId).select(['content_hash']).where('id', '=', s.current_spec_revision_id).executeTakeFirst();
      if (cur?.content_hash === hash) return { revisionId: s.current_spec_revision_id, build: null, unchanged: true, summary: { added: [], removed: [], changed: [], orphanedOverlayKeys: [] } };
    }
    const format = detectFormat(spec.bytes, spec.formatHint);
    const rev = await this.insertSpecRevision(tenantId, serverId, spec, format, createdBy, null);
    const prevBuild = s.latest_build_id;
    const build = await this.builds.build(serverId, rev.id, s.published_overlay_revision_id);
    const overlayKeys = await this.overlayKeys(s.published_overlay_revision_id);
    const summary = await this.builds.summaryVs(prevBuild, build.result, overlayKeys);
    await this.db.updateTable('spec_revisions').where('tenant_id', '=', tenantId).set({ summary: toJsonColumn(summary), title: build.result.title, api_version: build.result.apiVersion, operation_count: build.result.operationCount }).where('id', '=', rev.id).execute();
    if (build.build.status === 'ok') await this.db.updateTable('servers').where('tenant_id', '=', tenantId).set({ current_spec_revision_id: rev.id, updated_at: this.clock.now() }).where('id', '=', serverId).execute();
    this.audit.admin({ tenantId, actorUserId: createdBy, action: 'spec.reimport', targetType: 'server', targetId: serverId, serverId, after: { rev: rev.rev, build: build.build.id } });
    return { revisionId: rev.id, build, unchanged: false, summary };
  }

  async overlayKeys(overlayRevisionId: string | null): Promise<string[]> {
    const yaml = await this.builds.overlayYaml(overlayRevisionId);
    if (!yaml) return [];
    const { parseOverlay } = await import('@neurouter/compiler');
    const p = parseOverlay(yaml);
    return Object.keys((p.overlay as { tools?: Record<string, unknown> } | null)?.tools ?? {});
  }

  /** Publishes overlay YAML as a new revision and builds it (§14.6 publish / revert / file). */
  async publishOverlay(tenantId: string, serverId: string, yaml: string, opts: { message: string; source: OverlaySource; createdBy: string | null; basedOnRev: number | null; pinTo?: string[] }): Promise<{ revisionId: string; build: BuildOutcome; result: CompileResult }> {
    const s = await this.get(tenantId, serverId);
    if (!s.current_spec_revision_id) throw AppError.conflict('Server has no spec');
    // compile first: a failing overlay never becomes a revision
    const result = await this.builds.compileWith(serverId, yaml);
    if (!result.ok) throw new AppError('build_failed', 'The overlay does not compile', { extensions: { diagnostics: result.diagnostics.filter((d) => d.severity === 'error') } });
    const revisionId = await this.insertOverlayRevision(tenantId, serverId, yaml, opts.source, opts.message, opts.createdBy, opts.basedOnRev);
    const build = await this.builds.build(serverId, s.current_spec_revision_id, revisionId, { overlayYaml: yaml });
    await this.db.updateTable('servers').where('tenant_id', '=', tenantId).set({ published_overlay_revision_id: revisionId, updated_at: this.clock.now() }).where('id', '=', serverId).execute();
    if (opts.pinTo?.length) for (const envId of opts.pinTo) await this.builds.pin(envId, build.build.id);
    await this.coord.publish(CONFIG_CHANGED, { serverId });
    return { revisionId, build, result };
  }

  async environments(serverId: string): Promise<EnvironmentRowDb[]> {
    // tenant-scope: child-of-scoped (server id from a tenant-scoped guard)
    return this.db.selectFrom('environments').selectAll().where('server_id', '=', serverId).orderBy('created_at').execute();
  }

  opsTools(s: ServerRowDb): OpsToolToggles {
    return { ...DEFAULT_OPS_TOGGLES, ...(parseJsonColumn<Partial<OpsToolToggles>>(s.ops_tools) ?? {}) };
  }
}

function gzipBytes(b: Uint8Array): Buffer {
  return gzipSync(Buffer.from(b));
}
