import type { Kysely } from 'kysely';
import { DEFAULT_CODE_LIMITS_CAP } from '@neurouter/shared';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';
import { INSTANCE_SCOPE_ID } from '../tenancy/index.js';

/** Runtime settings stored in the `settings` table (backend §14.13) with their defaults. */
export interface SettingValues {
  auditRetentionDays: number;
  auditStoreFullOutput: boolean;
  auditFullOutputMaxBytes: number;
  cimdPolicy: { mode: 'any' | 'allowlist'; allowedHosts: string[] };
  dcrEnabled: boolean;
  metricsRetention: { minuteDays: number; hourDays: number };
  /** SIEM export; `secretRef`: `env:NAME` (neurouter.yaml) or `stored` (console, encrypted named secret settings/audit/webhook_secret). */
  auditSinks: { webhook: { url: string | null; secretRef: string | null; enabled: boolean }; otelLogs: { enabled: boolean } };
  /** Set once at first boot (audit genesis, HKDF salt). */
  installId: string | null;
  /** Block tool calls when audit events can't be queued. */
  auditFailClosed: boolean;
  auditFtsEnabled: boolean;
  /** Param keys whose (redacted) values are full-text indexed; `*` = all keys. */
  auditSearchParamKeys: string[];
  metricsToolLabel: boolean;
  /* Neurouter */
  orgName: string | null;
  /** Global code-mode kill switch (neurouter.yaml `settings.codeMode.enabled`). */
  codeModeEnabled: boolean;
  /** Tenant caps on per-environment code limits. */
  codeLimitsCap: { maxToolCalls: number; wallTimeSec: number; cpuTimeSec: number; maxMemoryMb: number; maxConcurrentCalls: number; maxResultBytes: number };
  evalModel: string | null;
  judgeModel: string | null;
  generatorModel: string | null;
  evalEffort: 'low' | 'medium' | 'high';
  evalFallbacks: 'default' | 'off';
  evalRepeats: number;
  /** Stored (encrypted) provider key secret ids + last 4 chars; the provider's env key (e.g. OPENAI_API_KEY) wins. */
  openaiKeySecretId: string | null;
  openaiKeyLast4: string | null;
  anthropicKeySecretId: string | null;
  anthropicKeyLast4: string | null;
  geminiKeySecretId: string | null;
  geminiKeyLast4: string | null;
  /** Display name of the stored Anthropic provider (legacy single-provider setting). */
  modelProviderName: string;
  /** Display names of stored providers by kind (Anthropic falls back to `modelProviderName`). */
  modelProviderNames: Partial<Record<'openai' | 'anthropic' | 'gemini', string>>;
  /** Last test of the Anthropic provider (legacy); other kinds in `modelProviderLastTests`. */
  modelProviderLastTest: { at: number; ok: boolean } | null;
  modelProviderLastTests: Partial<Record<'openai' | 'anthropic' | 'gemini', { at: number; ok: boolean }>>;
  retentionDays: number | null;
  nativeSearchClients: string[];
  /** Ids of users who have signed in at least once with a local link (first-start banner). */
  firstAdminSignedIn: boolean;
}

export type SettingKey = keyof SettingValues;

export const SETTING_DEFAULTS: SettingValues = {
  auditRetentionDays: 90,
  auditStoreFullOutput: false,
  auditFullOutputMaxBytes: 65536,
  cimdPolicy: { mode: 'any', allowedHosts: [] },
  dcrEnabled: true,
  metricsRetention: { minuteDays: 14, hourDays: 400 },
  auditSinks: { webhook: { url: null, secretRef: null, enabled: false }, otelLogs: { enabled: false } },
  installId: null,
  auditFailClosed: true,
  auditFtsEnabled: true,
  auditSearchParamKeys: ['query', 'q', 'search', 'term', 'name', 'title', 'id', 'path', 'owner', 'repo', 'repository', 'project', 'branch', 'issue', 'goal', 'intent', 'tool'],
  metricsToolLabel: true,
  orgName: null,
  codeModeEnabled: true,
  codeLimitsCap: DEFAULT_CODE_LIMITS_CAP,
  evalModel: null,
  judgeModel: null,
  generatorModel: null,
  evalEffort: 'medium',
  evalFallbacks: 'default',
  evalRepeats: 3,
  openaiKeySecretId: null,
  openaiKeyLast4: null,
  anthropicKeySecretId: null,
  anthropicKeyLast4: null,
  geminiKeySecretId: null,
  geminiKeyLast4: null,
  modelProviderName: 'Anthropic',
  modelProviderNames: {},
  modelProviderLastTest: null,
  modelProviderLastTests: {},
  retentionDays: null,
  nativeSearchClients: [],
  firstAdminSignedIn: false,
};

/**
 * Instance keys (multi-tenancy spec §4.6): stored once under `INSTANCE_SCOPE_ID` and shared by all
 * tenants. Every other key is a tenant key, stored per tenant. Reading a tenant key needs a tenant id
 * (enforced by the types of `get`/`set`).
 */
export const INSTANCE_SETTING_KEYS = [
  'installId',
  'auditFailClosed',
  'auditFtsEnabled',
  'metricsToolLabel',
  'codeLimitsCap',
  'auditFullOutputMaxBytes',
  'auditRetentionDays',
  'metricsRetention',
  'cimdPolicy',
  'dcrEnabled',
  'nativeSearchClients',
  'firstAdminSignedIn',
] as const satisfies readonly SettingKey[];

export type InstanceSettingKey = (typeof INSTANCE_SETTING_KEYS)[number];
export type TenantSettingKey = Exclude<SettingKey, InstanceSettingKey>;

const INSTANCE_KEYS = new Set<string>(INSTANCE_SETTING_KEYS);
export const isInstanceSettingKey = (k: string): k is InstanceSettingKey => INSTANCE_KEYS.has(k);

export const SETTINGS_CHANNEL = 'settings.changed';

/** Cached scopes (instance + recently used tenants). */
const CACHE_MAX = 1000;

/**
 * Typed access to DB settings with a per-scope in-process cache (LRU, 1,000 scopes) invalidated
 * across replicas on `settings.changed {scope}` (spec §4.6, G5: no process-wide merge of every
 * tenant's rows).
 */
export class SettingsService {
  private readonly cache = new Map<string, Partial<SettingValues>>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord?: CoordinationStore,
  ) {
    coord?.subscribe(SETTINGS_CHANNEL, (payload) => {
      const scope = (payload as { scope?: unknown } | null)?.scope;
      if (typeof scope === 'string') this.cache.delete(scope);
      else this.cache.clear();
    });
  }

  private async load(scope: string): Promise<Partial<SettingValues>> {
    const hit = this.cache.get(scope);
    if (hit) {
      this.cache.delete(scope);
      this.cache.set(scope, hit);
      return hit;
    }
    const rows = await this.db.selectFrom('settings').select(['key', 'value']).where('tenant_id', '=', scope).execute();
    const out: Record<string, unknown> = {};
    const instance = scope === INSTANCE_SCOPE_ID;
    // a scope only holds its own kind of keys (stale copies left by the 0008 migration are ignored)
    for (const r of rows) if (isInstanceSettingKey(r.key) === instance) out[r.key] = parseJsonColumn(r.value);
    this.cache.set(scope, out as Partial<SettingValues>);
    while (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return out as Partial<SettingValues>;
  }

  private scopeOf(key: SettingKey, tenantId: string | undefined): string {
    if (isInstanceSettingKey(key)) return INSTANCE_SCOPE_ID;
    if (!tenantId) throw new Error(`setting ${key} is tenant-scoped; a tenant id is required`);
    return tenantId;
  }

  get<K extends InstanceSettingKey>(key: K): Promise<SettingValues[K]>;
  get<K extends TenantSettingKey>(key: K, tenantId: string): Promise<SettingValues[K]>;
  async get<K extends SettingKey>(key: K, tenantId?: string): Promise<SettingValues[K]> {
    const all = await this.load(this.scopeOf(key, tenantId));
    return (key in all ? all[key] : SETTING_DEFAULTS[key]) as SettingValues[K];
  }

  has(key: InstanceSettingKey): Promise<boolean>;
  has(key: TenantSettingKey, tenantId: string): Promise<boolean>;
  async has(key: SettingKey, tenantId?: string): Promise<boolean> {
    return key in (await this.load(this.scopeOf(key, tenantId)));
  }

  set<K extends InstanceSettingKey>(key: K, value: SettingValues[K], updatedBy?: string | null): Promise<void>;
  set<K extends TenantSettingKey>(key: K, value: SettingValues[K], updatedBy: string | null, tenantId: string): Promise<void>;
  async set<K extends SettingKey>(key: K, value: SettingValues[K], updatedBy: string | null = null, tenantId?: string): Promise<void> {
    const scope = this.scopeOf(key, tenantId);
    const now = this.clock.now();
    await this.db
      .insertInto('settings')
      .values({ tenant_id: scope, key, value: toJsonColumn(value), updated_by: updatedBy, updated_at: now })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: toJsonColumn(value), updated_by: updatedBy, updated_at: now }))
      .execute();
    this.cache.delete(scope);
    await this.coord?.publish(SETTINGS_CHANNEL, { key, scope });
  }

  /** Writes an instance value only when the key is absent (first-boot values shared by all replicas); returns the stored value. */
  async setIfAbsent<K extends InstanceSettingKey>(key: K, value: SettingValues[K]): Promise<SettingValues[K]> {
    await this.db
      .insertInto('settings')
      .values({ tenant_id: INSTANCE_SCOPE_ID, key, value: toJsonColumn(value), updated_by: null, updated_at: this.clock.now() })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .execute();
    this.cache.delete(INSTANCE_SCOPE_ID);
    return this.get(key);
  }
}
