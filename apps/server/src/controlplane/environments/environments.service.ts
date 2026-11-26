import type { Kysely, Selectable } from 'kysely';
import { clampCodeLimits, type CodeLimits, type EnvironmentCreate, type EnvironmentPatch, type UpstreamAuthIn, type WritesConfig } from '@neurouter/shared';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { Config } from '../../kernel/config/load.js';
import type { EnvironmentsTable, MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import { CONFIG_CHANGED, environmentRuntime, type UpstreamAuthDescriptor } from '../../kernel/runtime-config.js';

export type EnvRow = Selectable<EnvironmentsTable>;

/** API `UpstreamAuthIn` (secret refs) → runtime descriptor (§13.5). */
export function authFromApi(a: UpstreamAuthIn): UpstreamAuthDescriptor {
  switch (a.type) {
    case 'none':
      return { type: 'none' };
    case 'bearer':
      return { type: 'bearer', secret: a.secretRef };
    case 'header':
      return { type: 'header', header: { name: a.headerName, secret: a.secretRef } };
    case 'query':
      return { type: 'query', query: { name: a.paramName, secret: a.secretRef } };
    case 'basic':
      return { type: 'basic', username: a.username, secret: a.secretRef };
    case 'oauth_client_credentials':
      return { type: 'oauth_client_credentials', tokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecretRef, scopes: a.scopes };
    case 'oauth_passthrough':
      return {
        type: 'oauth_passthrough',
        ...(a.authorizationUrl ? { authorizationUrl: a.authorizationUrl } : {}),
        ...(a.tokenUrl ? { tokenUrl: a.tokenUrl } : {}),
        ...(a.clientId ? { clientId: a.clientId } : {}),
        ...(a.clientSecretRef ? { clientSecret: a.clientSecretRef } : {}),
        scopes: a.scopes,
        ...(a.mode === 'forward_inbound' ? { forwardInboundToken: true } : {}),
        ...(a.upstreamAudience ? { upstreamAudience: a.upstreamAudience } : {}),
      };
  }
}

/** 409 `config_managed` when a file-managed resource is changed in `file`/`hybrid` mode (§14.1). */
export function assertConsoleManaged(config: Config, row: { managed_by: string; config_path: string | null; config_line: number | null }, what: string): void {
  if (row.managed_by !== 'file' || config.configMode === 'console') return;
  throw new AppError('config_managed', `${what} is defined in neurouter.yaml; change it there`, { extensions: { configPath: row.config_path ?? 'neurouter.yaml', configLine: row.config_line ?? null } });
}

/** Environments (§14.7): CRUD, writes (read-only default; prod confirm rules), pins, health. */
export class EnvironmentsService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly config: Config,
    private readonly tenantId: string,
  ) {}

  async get(id: string): Promise<EnvRow> {
    const e = await this.db.selectFrom('environments').selectAll().where('tenant_id', '=', this.tenantId).where('id', '=', id).executeTakeFirst();
    if (!e) throw AppError.notFound('Environment');
    return e;
  }

  private async changed(e: { id: string; server_id: string }): Promise<void> {
    await this.coord.publish(CONFIG_CHANGED, { serverId: e.server_id, environmentId: e.id });
  }

  async create(serverId: string, body: EnvironmentCreate): Promise<EnvRow> {
    const clash = await this.db.selectFrom('environments').where('tenant_id', '=', this.tenantId).select('id').where('server_id', '=', serverId).where('slug', '=', body.slug).executeTakeFirst();
    if (clash) throw AppError.conflict(`An environment named "${body.slug}" already exists`);
    const s = await this.db.selectFrom('servers').where('tenant_id', '=', this.tenantId).select(['latest_build_id']).where('id', '=', serverId).executeTakeFirstOrThrow();
    const now = this.clock.now();
    const id = newId();
    if (body.baseUrl === 'mock:' && body.auth.type !== 'none') throw AppError.validation('Mock environments take no credential', [{ path: ['auth'], message: 'Use auth type none for mock:', code: 'invalid_auth' }]);
    await this.db
      .insertInto('environments')
      .values({
        id,
        tenant_id: this.tenantId,
        server_id: serverId,
        slug: body.slug,
        name: body.name ?? body.slug,
        kind: body.kind,
        base_url: body.baseUrl,
        build_id: s.latest_build_id,
        auto_promote: (body.autoPromote ?? body.kind !== 'prod') ? 1 : 0,
        auth: toJsonColumn(authFromApi(body.auth)),
        headers: toJsonColumn(body.headers ?? {}),
        writes: toJsonColumn({ enabled: false, tools: null, confirm: body.kind === 'prod' ? 'elicit' : 'none' }),
        code_mode: body.codeMode === false ? 0 : 1,
        limits: toJsonColumn(body.limits ?? {}),
        allowed_hosts: toJsonColumn(body.allowedHosts ?? []),
        allow_http: body.allowHttp ? 1 : 0,
        status: 'active',
        managed_by: 'console',
        created_at: now,
        updated_at: now,
      })
      .execute();
    const e = await this.get(id);
    await this.changed(e);
    return e;
  }

  async update(id: string, body: EnvironmentPatch): Promise<EnvRow> {
    const e = await this.get(id);
    assertConsoleManaged(this.config, e, 'This environment');
    if (e.builtin === 1 && body.baseUrl && body.baseUrl !== 'mock:') throw AppError.validation('The built-in mock environment always uses mock:', [{ path: ['baseUrl'], message: 'must be mock:', code: 'builtin_mock' }]);
    const set: Record<string, unknown> = { updated_at: this.clock.now() };
    if (body.name !== undefined) set.name = body.name;
    if (body.kind !== undefined) set.kind = body.kind;
    if (body.baseUrl !== undefined) set.base_url = body.baseUrl;
    if (body.auth !== undefined) set.auth = toJsonColumn(authFromApi(body.auth));
    if (body.headers !== undefined) set.headers = toJsonColumn(body.headers);
    if (body.codeMode !== undefined) set.code_mode = body.codeMode ? 1 : 0;
    if (body.limits !== undefined) set.limits = toJsonColumn(body.limits);
    if (body.allowedHosts !== undefined) set.allowed_hosts = toJsonColumn(body.allowedHosts);
    if (body.allowHttp !== undefined) set.allow_http = body.allowHttp ? 1 : 0;
    if (body.autoPromote !== undefined) set.auto_promote = body.autoPromote ? 1 : 0;
    if (body.policies !== undefined) set.policies = toJsonColumn(body.policies);
    if (body.status !== undefined) set.status = body.status;
    if (body.discovery !== undefined) set.discovery_override = body.discovery === null ? null : toJsonColumn(body.discovery);
    if (body.kind === 'prod' && e.kind !== 'prod') {
      const w = environmentRuntime(e).writes;
      if (w.enabled && w.confirm === 'none') set.writes = toJsonColumn({ ...w, confirm: 'elicit' });
    }
    await this.db.updateTable('environments').where('tenant_id', '=', this.tenantId).set(set).where('id', '=', id).execute();
    await this.changed(e);
    return this.get(id);
  }

  async delete(id: string, confirm: string): Promise<void> {
    const e = await this.get(id);
    assertConsoleManaged(this.config, e, 'This environment');
    if (e.builtin === 1) throw AppError.conflict('The built-in mock environment cannot be deleted');
    if (confirm !== e.slug) throw AppError.validation('Type the environment slug to confirm', [{ path: ['confirm'], message: `must equal ${e.slug}`, code: 'confirm_mismatch' }]);
    await this.db.deleteFrom('environments').where('tenant_id', '=', this.tenantId).where('id', '=', id).execute();
    await this.changed(e);
  }

  /** Environment-wide write switch (§9.7): prod needs elicit|deny_without_elicitation and the typed slug. */
  async setWrites(id: string, body: WritesConfig): Promise<EnvRow> {
    const e = await this.get(id);
    assertConsoleManaged(this.config, e, 'This environment');
    if (e.kind === 'prod' && body.enabled) {
      if (body.confirm === 'none') throw AppError.validation('Production writes need a confirmation mode', [{ path: ['confirm'], message: 'confirm "none" is not allowed for prod', code: 'prod_confirm_none' }]);
      if (body.confirmEnvironmentSlug !== e.slug) throw AppError.validation('Type the environment slug to enable production writes', [{ path: ['confirmEnvironmentSlug'], message: `must equal ${e.slug}`, code: 'confirm_mismatch' }]);
    }
    const confirm = e.kind === 'prod' && body.confirm === 'none' ? 'elicit' : body.confirm;
    await this.db.updateTable('environments').where('tenant_id', '=', this.tenantId).set({ writes: toJsonColumn({ enabled: body.enabled, tools: body.tools ?? null, confirm }), updated_at: this.clock.now() }).where('id', '=', id).execute();
    await this.changed(e);
    return this.get(id);
  }

  /** One matrix cell: enables writes on the env with an allow-list containing the tool (or removes it). */
  async setToolWrite(id: string, toolName: string, body: { enabled: boolean; confirm?: 'elicit' | 'deny_without_elicitation'; confirmEnvironmentSlug?: string }, allWriteTools: string[]): Promise<EnvRow> {
    const e = await this.get(id);
    assertConsoleManaged(this.config, e, 'This environment');
    if (!allWriteTools.includes(toolName)) throw AppError.validation('Not a write tool of this environment\'s build', [{ path: ['toolName'], message: 'unknown write tool', code: 'unknown_tool' }]);
    const w = environmentRuntime(e).writes;
    let tools = w.enabled ? (w.tools ?? [...allWriteTools]) : [];
    if (body.enabled) {
      if (e.kind === 'prod' && !w.enabled && body.confirmEnvironmentSlug !== e.slug) throw AppError.validation('Type the environment slug to enable production writes', [{ path: ['confirmEnvironmentSlug'], message: `must equal ${e.slug}`, code: 'confirm_mismatch' }]);
      if (!tools.includes(toolName)) tools.push(toolName);
    } else tools = tools.filter((t) => t !== toolName);
    let confirm = body.confirm ?? w.confirm;
    if (e.kind === 'prod' && confirm === 'none') confirm = 'elicit';
    const enabled = tools.length > 0;
    const all = tools.length === allWriteTools.length && allWriteTools.every((t) => tools.includes(t));
    await this.db.updateTable('environments').where('tenant_id', '=', this.tenantId).set({ writes: toJsonColumn({ enabled, tools: enabled ? (all ? null : tools) : null, confirm }), updated_at: this.clock.now() }).where('id', '=', id).execute();
    await this.changed(e);
    return this.get(id);
  }

  async pinBuild(id: string, buildId: string): Promise<EnvRow> {
    const e = await this.get(id);
    const b = await this.db.selectFrom('builds').where('tenant_id', '=', this.tenantId).select(['server_id', 'status']).where('id', '=', buildId).executeTakeFirst();
    if (!b || b.server_id !== e.server_id) throw AppError.validation('The build belongs to another server', [{ path: ['buildId'], message: 'build of another server', code: 'build_mismatch' }]);
    if (b.status !== 'ok') throw AppError.validation('Cannot pin a failed build', [{ path: ['buildId'], message: 'failed build', code: 'build_failed' }]);
    await this.db.updateTable('environments').where('tenant_id', '=', this.tenantId).set({ build_id: buildId, updated_at: this.clock.now() }).where('id', '=', id).execute();
    await this.changed(e);
    return this.get(id);
  }

  async recordHealth(id: string, h: { status: 'up' | 'down' | 'unknown'; latencyMs: number | null; error: string | null }): Promise<void> {
    await this.db.updateTable('environments').where('tenant_id', '=', this.tenantId).set({ health: toJsonColumn({ ...h, checkedAt: this.clock.now() }) }).where('id', '=', id).execute();
  }

  headersOf(e: EnvRow): Record<string, string> {
    return parseJsonColumn<Record<string, string>>(e.headers) ?? {};
  }
}

/** 422 when per-environment code limits exceed the instance cap (settings `codeLimitsCap`, §10.5). */
export function assertWithinCodeCap(limits: { code?: Partial<CodeLimits> } | undefined, cap: CodeLimits): void {
  if (!limits?.code) return;
  const { over } = clampCodeLimits({ ...cap, ...limits.code } as CodeLimits, cap);
  if (!over.length) return;
  throw AppError.validation(
    `Code limits exceed the instance cap: ${over.map((o) => `${o.field} ${o.value} > ${o.cap}`).join(', ')}`,
    over.map((o) => ({ path: ['limits', 'code', o.field], message: `at most ${o.cap} (instance cap)`, code: 'over_cap' })),
  );
}
