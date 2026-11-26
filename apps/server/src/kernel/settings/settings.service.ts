import type { Kysely } from 'kysely';
import type { CoordinationStore } from '../coordination/types.js';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { parseJsonColumn, toJsonColumn } from '../lib/json.js';

/** Runtime settings stored in the `settings` table (backend §14.13) with their defaults. */
export interface SettingValues {
  auditRetentionDays: number;
  auditStoreFullOutput: boolean;
  auditFullOutputMaxBytes: number;
  cimdPolicy: { mode: 'any' | 'allowlist'; allowedHosts: string[] };
  dcrEnabled: boolean;
  metricsRetention: { minuteDays: number; hourDays: number };
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
  /** Stored (encrypted) Anthropic key secret id; ANTHROPIC_API_KEY env wins. */
  anthropicKeySecretId: string | null;
  anthropicKeyLast4: string | null;
  modelProviderName: string;
  modelProviderLastTest: { at: number; ok: boolean } | null;
  labelInferredTasks: boolean;
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
  codeLimitsCap: { maxToolCalls: 1000, wallTimeSec: 120, cpuTimeSec: 60, maxMemoryMb: 512, maxConcurrentCalls: 32, maxResultBytes: 4 * 1024 * 1024 },
  evalModel: null,
  judgeModel: null,
  generatorModel: null,
  evalEffort: 'medium',
  evalFallbacks: 'default',
  evalRepeats: 3,
  anthropicKeySecretId: null,
  anthropicKeyLast4: null,
  modelProviderName: 'Anthropic',
  modelProviderLastTest: null,
  labelInferredTasks: false,
  retentionDays: null,
  nativeSearchClients: [],
  firstAdminSignedIn: false,
};

export const SETTINGS_CHANNEL = 'settings.changed';

/** Typed access to DB settings with an in-process cache invalidated across replicas. */
export class SettingsService {
  private cache: Partial<SettingValues> | null = null;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord?: CoordinationStore,
  ) {
    coord?.subscribe(SETTINGS_CHANNEL, () => {
      this.cache = null;
    });
  }

  private async load(): Promise<Partial<SettingValues>> {
    if (this.cache) return this.cache;
    const rows = await this.db.selectFrom('settings').select(['key', 'value']).execute();
    const out: Record<string, unknown> = {};
    for (const r of rows) out[r.key] = parseJsonColumn(r.value);
    this.cache = out as Partial<SettingValues>;
    return this.cache;
  }

  async get<K extends SettingKey>(key: K): Promise<SettingValues[K]> {
    const all = await this.load();
    return (key in all ? all[key] : SETTING_DEFAULTS[key]) as SettingValues[K];
  }

  async has(key: SettingKey): Promise<boolean> {
    return key in (await this.load());
  }

  async set<K extends SettingKey>(key: K, value: SettingValues[K], updatedBy: string | null = null): Promise<void> {
    const now = this.clock.now();
    await this.db
      .insertInto('settings')
      .values({ key, value: toJsonColumn(value), updated_by: updatedBy, updated_at: now })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doUpdateSet({ value: toJsonColumn(value), updated_by: updatedBy, updated_at: now }))
      .execute();
    this.cache = null;
    await this.coord?.publish(SETTINGS_CHANNEL, { key });
  }

  /** Writes the value only when the key is absent (first-boot values shared by all replicas); returns the stored value. */
  async setIfAbsent<K extends SettingKey>(key: K, value: SettingValues[K]): Promise<SettingValues[K]> {
    await this.db
      .insertInto('settings')
      .values({ key, value: toJsonColumn(value), updated_by: null, updated_at: this.clock.now() })
      .onConflict((oc) => oc.columns(['tenant_id', 'key']).doNothing())
      .execute();
    this.cache = null;
    return this.get(key);
  }
}
