import { gunzipSync } from 'node:zlib';
import type { Kysely, Selectable } from 'kysely';
import {
  clampCodeLimits,
  DEFAULT_OPS_TOGGLES,
  type ConfirmMode,
  type ContractVersion,
  type DiscoveryMode,
  type EnvironmentKind,
  type ExposureMode,
  type KillSwitchKind,
  type KillSwitchScope,
  type OpsToolToggles,
  type OutputSchemaMode,
  type ServerKind,
  type ToolDef,
  type UpstreamAuthType,
} from '@neurouter/shared';
import type { CoordinationStore } from './coordination/types.js';
import type { EnvironmentsTable, MainDB } from './db/schema.js';
import type { Clock } from './lib/clock.js';
import { hashCanonical } from './lib/jcs.js';
import { parseJsonColumn, toBool } from './lib/json.js';

/* ------------------------------------------------------------------ bundle types (§2) */

export interface ExposureConfig {
  mode: ExposureMode;
  discovery: DiscoveryMode;
  pinned: string[];
  /** Absent: the server predates contract 2 and serves contract 1 unless the client negotiates. */
  contract?: ContractVersion;
  outputSchema?: OutputSchemaMode;
}

export interface RateLimitSpec {
  perMinute: number;
  burst: number;
}

export interface CodeLimits {
  maxToolCalls: number;
  wallTimeSec: number;
  cpuTimeSec: number;
  maxMemoryMb: number;
  maxConcurrentCalls: number;
  maxResultBytes: number;
  /** agent-facing run_script result budget in characters (default `SCRIPT_RESULT_CHARS`, 8,192) */
  resultChars?: number;
}

export interface EnvLimits {
  rateLimit: RateLimitSpec | null;
  toolRateLimit: RateLimitSpec | null;
  timeoutMs: number;
  maxResponseBytes: number;
  code: CodeLimits;
}

export const DEFAULT_CODE_LIMITS: CodeLimits = { maxToolCalls: 200, wallTimeSec: 30, cpuTimeSec: 10, maxMemoryMb: 64, maxConcurrentCalls: 8, maxResultBytes: 1024 * 1024 };
export const DEFAULT_ENV_LIMITS: EnvLimits = { rateLimit: null, toolRateLimit: null, timeoutMs: 15_000, maxResponseBytes: 2 * 1024 * 1024, code: DEFAULT_CODE_LIMITS };

/** Upstream auth descriptor: secret REFERENCES only (`env:NAME` | `secret:NAME`), never values. */
export interface UpstreamAuthDescriptor {
  type: UpstreamAuthType;
  secret?: string;
  header?: { name: string; secret: string };
  query?: { name: string; secret: string };
  username?: string;
  tokenUrl?: string;
  clientId?: string;
  clientSecret?: string;
  scopes?: string[];
  authorizationUrl?: string;
  forwardInboundToken?: boolean;
  upstreamAudience?: string;
}

/** Basic YAML policy (§9.8). */
export interface PolicySpec {
  name: string;
  deny: {
    tools?: string[];
    tags?: string[];
    when?: { argMatches?: Record<string, string>; outsideHours?: string };
    sequence?: { first: { tags?: string[]; tools?: string[] }; then: { tags?: string[]; tools?: string[] }; within?: 'task' };
  };
  message?: string;
}

export interface WritesConfig {
  enabled: boolean;
  /** Allow-list of write tools; null = all write tools. */
  tools: string[] | null;
  confirm: ConfirmMode;
}

export interface EnvironmentRuntime {
  id: string;
  slug: string;
  name: string;
  kind: EnvironmentKind;
  baseUrl: string;
  isMock: boolean;
  auth: UpstreamAuthDescriptor;
  headers: Record<string, string>;
  writes: WritesConfig;
  codeMode: boolean;
  limits: EnvLimits;
  policies: PolicySpec[];
  allowedHosts: string[];
  allowHttp: boolean;
  status: 'active' | 'disabled' | 'removed_from_config';
  discoveryOverride: DiscoveryMode | null;
  /** Per-environment contract / outputSchema (stored in `discovery_override` next to `discovery`). */
  contractOverride: ContractVersion | null;
  outputSchemaOverride: OutputSchemaMode | null;
}

export interface KillSwitch {
  scope: KillSwitchScope;
  target: string;
  kind: KillSwitchKind;
  reason: string;
}

export interface RuntimeBuild {
  id: string;
  hash: string;
  /** Every tool of the build, hidden ones included (hidden = unknown to agents). */
  tools: ToolDef[];
  /** tool name → `tools.id` row (search index key). */
  toolRowIds: Record<string, string>;
  pythonStubs: Record<string, string>;
  pinned: string[];
  profiles: Record<string, string[]>;
  /** Lazily decoded compiler mock model (§16). */
  mockModel(): unknown;
}

export interface RuntimeBundle {
  /** sha256 of canonical JSON (JCS) of the agent-relevant configuration. */
  bundleHash: string;
  tenantId: string;
  server: { id: string; slug: string; name: string; description: string; kind: ServerKind; opsTools: OpsToolToggles; exposure: ExposureConfig; status: string };
  environment: EnvironmentRuntime;
  build: RuntimeBuild;
  killSwitches: KillSwitch[];
  /** Global code-mode kill switch (settings `codeModeEnabled`). */
  codeModeEnabled: boolean;
}

export interface RuntimeConfigSource {
  /** Active runtime bundle for one server + environment (cached, invalidated on `config.changed`). */
  get(tenantId: string, serverSlug: string, envSlug: string): Promise<RuntimeBundle | null>;
  /** Same, by environment id (eval runner, console test calls). */
  getByEnvironmentId(tenantId: string, environmentId: string): Promise<RuntimeBundle | null>;
  subscribe(fn: (e: { tenantId: string; serverId: string; environmentId: string }) => void): () => void;
  invalidate(): void;
  /** Same bundle with another (e.g. temporary) build of the same server — eval verify runs only. */
  withBuild(bundle: RuntimeBundle, buildId: string): Promise<RuntimeBundle | null>;
}

export const CONFIG_CHANGED = 'config.changed';
export const KILL_CHANGED = 'kill.changed';

/* ------------------------------------------------------------------ parsing helpers (shared by the console API) */

export function parseExposure(v: unknown): ExposureConfig {
  const e = (parseJsonColumn<Partial<ExposureConfig>>(v) ?? {}) as Partial<ExposureConfig>;
  return {
    mode: e.mode ?? 'auto',
    discovery: e.discovery ?? 'auto',
    pinned: Array.isArray(e.pinned) ? e.pinned : [],
    ...(e.contract === 1 || e.contract === 2 ? { contract: e.contract } : {}),
    ...(e.outputSchema === 'envelope' || e.outputSchema === 'none' || e.outputSchema === 'typed' ? { outputSchema: e.outputSchema } : {}),
  };
}

/** The contract a session gets when the client does not negotiate one (contract-v2 §1): environment, server, else 1. */
export function contractSetting(b: Pick<RuntimeBundle, 'server' | 'environment'>): ContractVersion {
  return b.environment.contractOverride ?? b.server.exposure.contract ?? 1;
}

/** `exposure.outputSchema`: environment override, server setting, else `envelope`. */
export function outputSchemaSetting(b: Pick<RuntimeBundle, 'server' | 'environment'>): OutputSchemaMode {
  return b.environment.outputSchemaOverride ?? b.server.exposure.outputSchema ?? 'envelope';
}

export function parseOpsTools(v: unknown): OpsToolToggles {
  return { ...DEFAULT_OPS_TOGGLES, ...(parseJsonColumn<Partial<OpsToolToggles>>(v) ?? {}) };
}

export function parseWrites(v: unknown, kind: EnvironmentKind): WritesConfig {
  const w = (parseJsonColumn<Partial<WritesConfig>>(v) ?? {}) as Partial<WritesConfig>;
  return { enabled: w.enabled === true, tools: Array.isArray(w.tools) ? w.tools : null, confirm: w.confirm ?? (kind === 'prod' ? 'elicit' : 'none') };
}

export function parseLimits(v: unknown): EnvLimits {
  const l = (parseJsonColumn<Partial<EnvLimits>>(v) ?? {}) as Partial<EnvLimits>;
  return {
    rateLimit: l.rateLimit ?? null,
    toolRateLimit: l.toolRateLimit ?? null,
    timeoutMs: l.timeoutMs ?? DEFAULT_ENV_LIMITS.timeoutMs,
    maxResponseBytes: l.maxResponseBytes ?? DEFAULT_ENV_LIMITS.maxResponseBytes,
    code: { ...DEFAULT_CODE_LIMITS, ...(l.code ?? {}) },
  };
}

type EnvRow = Selectable<EnvironmentsTable>;

export function environmentRuntime(e: EnvRow): EnvironmentRuntime {
  const baseUrl = e.base_url;
  const isMock = baseUrl.startsWith('mock:');
  let defaultHosts: string[] = [];
  if (!isMock) {
    try {
      defaultHosts = [new URL(baseUrl).host];
    } catch {
      defaultHosts = [];
    }
  }
  const hosts = parseJsonColumn<string[]>(e.allowed_hosts) ?? [];
  const override = parseJsonColumn<DiscoveryMode | { discovery?: DiscoveryMode; contract?: ContractVersion; outputSchema?: OutputSchemaMode }>(e.discovery_override);
  const ov = override && typeof override === 'object' ? override : null;
  return {
    id: e.id,
    slug: e.slug,
    name: e.name,
    kind: e.kind,
    baseUrl,
    isMock,
    auth: ((a) => (a && a.type ? a : { type: 'none' }))(parseJsonColumn<UpstreamAuthDescriptor>(e.auth)) as UpstreamAuthDescriptor,
    headers: parseJsonColumn<Record<string, string>>(e.headers) ?? {},
    writes: parseWrites(e.writes, e.kind),
    codeMode: toBool(e.code_mode),
    limits: parseLimits(e.limits),
    policies: parseJsonColumn<PolicySpec[]>(e.policies) ?? [],
    allowedHosts: hosts.length ? hosts : defaultHosts,
    allowHttp: toBool(e.allow_http),
    status: e.status,
    discoveryOverride: typeof override === 'string' ? override : (ov?.discovery ?? null),
    contractOverride: ov?.contract === 1 || ov?.contract === 2 ? ov.contract : null,
    outputSchemaOverride: ov?.outputSchema === 'envelope' || ov?.outputSchema === 'none' || ov?.outputSchema === 'typed' ? ov.outputSchema : null,
  };
}

export function decodeGzipJson<T>(blob: Buffer | null | undefined): T | null {
  if (!blob) return null;
  return JSON.parse(gunzipSync(blob).toString('utf8')) as T;
}

/* ------------------------------------------------------------------ DB implementation */

interface CacheEntry {
  at: number;
  bundle: RuntimeBundle | null;
}

/**
 * MVP RuntimeConfigSource (§2): reads the DB, caches per (server, env) for 30 s and drops the cache
 * on the coordination channels `config.changed` / `kill.changed`. A later RemoteRuntimeConfigSource
 * pulls signed bundles from a control plane over HTTPS.
 */
export class DbRuntimeConfigSource implements RuntimeConfigSource {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly builds = new Map<string, RuntimeBuild>();
  private readonly listeners = new Set<(e: { tenantId: string; serverId: string; environmentId: string }) => void>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly opts: { ttlMs?: number; codeModeEnabled: (tenantId: string) => Promise<boolean>; codeLimitsCap?: () => Promise<CodeLimits> },
  ) {
    coord.subscribe(CONFIG_CHANGED, (payload) => {
      this.cache.clear();
      const p = (payload ?? {}) as { tenantId?: string; serverId?: string; environmentId?: string };
      for (const l of this.listeners) l({ tenantId: p.tenantId ?? '', serverId: p.serverId ?? '', environmentId: p.environmentId ?? '' });
    });
    coord.subscribe(KILL_CHANGED, () => {
      this.cache.clear();
      for (const l of this.listeners) l({ tenantId: '', serverId: '', environmentId: '' });
    });
  }

  invalidate(): void {
    this.cache.clear();
  }

  subscribe(fn: (e: { tenantId: string; serverId: string; environmentId: string }) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  async get(tenantId: string, serverSlug: string, envSlug: string): Promise<RuntimeBundle | null> {
    const key = `${tenantId}|${serverSlug}|${envSlug}`;
    const hit = this.cache.get(key);
    if (hit && this.clock.now() - hit.at < (this.opts.ttlMs ?? 30_000)) return hit.bundle;
    const row = await this.db
      .selectFrom('environments as e')
      .innerJoin('servers as s', 's.id', 'e.server_id')
      .select('e.id')
      .where('s.tenant_id', '=', tenantId)
      .where('s.slug', '=', serverSlug)
      .where('e.slug', '=', envSlug)
      .executeTakeFirst();
    const bundle = row ? await this.load(tenantId, row.id) : null;
    this.cache.set(key, { at: this.clock.now(), bundle });
    return bundle;
  }

  async getByEnvironmentId(tenantId: string, environmentId: string): Promise<RuntimeBundle | null> {
    const key = `${tenantId}|#${environmentId}`;
    const hit = this.cache.get(key);
    if (hit && this.clock.now() - hit.at < (this.opts.ttlMs ?? 30_000)) return hit.bundle;
    const bundle = await this.load(tenantId, environmentId);
    this.cache.set(key, { at: this.clock.now(), bundle });
    return bundle;
  }

  private async load(tenantId: string, environmentId: string): Promise<RuntimeBundle | null> {
    const e = await this.db.selectFrom('environments').selectAll().where('id', '=', environmentId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!e) return null;
    const s = await this.db.selectFrom('servers').selectAll().where('id', '=', e.server_id).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!s) return null;
    const buildId = e.build_id ?? s.latest_build_id;
    if (!buildId) return null;
    const build = await this.loadBuild(buildId, tenantId);
    if (!build) return null;
    const ks = await this.db.selectFrom('kill_switches').selectAll().where('tenant_id', '=', tenantId).execute();
    const killSwitches: KillSwitch[] = ks.map((k) => ({ scope: k.scope, target: k.target, kind: k.kind, reason: k.reason }));
    const environment = environmentRuntime(e);
    // the instance cap wins over per-environment code limits (§10.5)
    if (this.opts.codeLimitsCap) environment.limits = { ...environment.limits, code: clampCodeLimits(environment.limits.code, await this.opts.codeLimitsCap()).limits };
    const server = { id: s.id, slug: s.slug, name: s.name, description: s.description, kind: s.kind, opsTools: parseOpsTools(s.ops_tools), exposure: parseExposure(s.exposure), status: s.status };
    const codeModeEnabled = await this.opts.codeModeEnabled(tenantId);
    const bundleHash = hashCanonical({ server, environment, build: build.hash, killSwitches, codeModeEnabled });
    return { bundleHash, tenantId, server, environment, build, killSwitches, codeModeEnabled };
  }

  async withBuild(bundle: RuntimeBundle, buildId: string): Promise<RuntimeBundle | null> {
    const own = await this.db.selectFrom('builds').select('server_id').where('id', '=', buildId).where('tenant_id', '=', bundle.tenantId).executeTakeFirst();
    if (!own || own.server_id !== bundle.server.id) return null;
    const build = await this.loadBuild(buildId, bundle.tenantId);
    if (!build) return null;
    return { ...bundle, build, bundleHash: hashCanonical({ base: bundle.bundleHash, build: build.hash }) };
  }

  /** Builds are immutable: cached by (tenant, id) (bounded). */
  async loadBuild(buildId: string, tenantId: string): Promise<RuntimeBuild | null> {
    const key = `${tenantId}|${buildId}`;
    const cached = this.builds.get(key);
    if (cached) return cached;
    const b = await this.db.selectFrom('builds').selectAll().where('id', '=', buildId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!b || b.status !== 'ok') return null;
    const rows = await this.db.selectFrom('tools').select(['id', 'name', 'def']).where('build_id', '=', buildId).where('tenant_id', '=', tenantId).orderBy('seq').execute();
    const tools = rows.map((r) => parseJsonColumn<ToolDef>(r.def)!);
    let mock: unknown = undefined;
    const mockBlob = b.mock_model;
    const build: RuntimeBuild = {
      id: b.id,
      hash: b.hash,
      tools,
      toolRowIds: Object.fromEntries(rows.map((r) => [r.name, r.id])),
      pythonStubs: decodeGzipJson<Record<string, string>>(b.python_stubs) ?? {},
      pinned: tools.filter((t) => t.pinned && !t.hidden).map((t) => t.name),
      profiles: parseJsonColumn<Record<string, string[]>>(b.profiles) ?? {},
      mockModel: () => {
        if (mock === undefined) mock = decodeGzipJson(mockBlob) ?? null;
        return mock;
      },
    };
    if (this.builds.size > 50) this.builds.delete(this.builds.keys().next().value!);
    this.builds.set(key, build);
    return build;
  }
}
