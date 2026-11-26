import { LLM_PROVIDER_KINDS, PROVIDER_ENV_KEYS, type LlmProviderKind } from '@neurouter/shared';
import type { NamedSecrets } from '../../kernel/secrets/named-secrets.js';
import type { SettingsService } from '../../kernel/settings/settings.service.js';

/** Stored provider keys: named secret `settings/<kind>/api_key` (Anthropic's predates the others and keeps its id). */
export const providerSecret = (kind: LlmProviderKind) => ({ owner: 'settings' as const, ownerId: kind, name: 'api_key' });

export const SECRET_ID_SETTING = { openai: 'openaiKeySecretId', anthropic: 'anthropicKeySecretId', gemini: 'geminiKeySecretId' } as const;
export const LAST4_SETTING = { openai: 'openaiKeyLast4', anthropic: 'anthropicKeyLast4', gemini: 'geminiKeyLast4' } as const;

export interface ModelKeyDeps {
  env: Record<string, string | undefined>;
  settings: SettingsService;
  namedSecrets: NamedSecrets;
  tenantId: string;
}

/** The key a provider uses: its env variable wins over the stored, encrypted key. */
export async function providerKey(d: ModelKeyDeps, kind: LlmProviderKind): Promise<{ key: string; source: 'env' | 'stored' } | null> {
  const env = d.env[PROVIDER_ENV_KEYS[kind]];
  if (env) return { key: env, source: 'env' };
  if (!(await d.settings.get(SECRET_ID_SETTING[kind]))) return null;
  const s = providerSecret(kind);
  const v = await d.namedSecrets.get(d.tenantId, s.owner, s.ownerId, s.name);
  return v ? { key: v, source: 'stored' } : null;
}

/** All provider keys (null where none is configured). */
export async function providerKeys(d: ModelKeyDeps): Promise<Record<LlmProviderKind, string | null>> {
  const out = {} as Record<LlmProviderKind, string | null>;
  for (const k of LLM_PROVIDER_KINDS) out[k] = (await providerKey(d, k))?.key ?? null;
  return out;
}

/** True when any provider has a key (env or stored) — without decrypting anything. */
export async function anyProviderKey(d: Pick<ModelKeyDeps, 'env' | 'settings'>): Promise<boolean> {
  for (const k of LLM_PROVIDER_KINDS) if (d.env[PROVIDER_ENV_KEYS[k]] || (await d.settings.get(SECRET_ID_SETTING[k]))) return true;
  return false;
}

export async function storeProviderKey(d: Pick<ModelKeyDeps, 'settings' | 'namedSecrets' | 'tenantId'>, kind: LlmProviderKind, value: string, by: string): Promise<void> {
  const s = providerSecret(kind);
  await d.namedSecrets.set(d.tenantId, s.owner, s.ownerId, s.name, value, by);
  await d.settings.set(SECRET_ID_SETTING[kind], `${s.owner}:${s.ownerId}`, by);
  await d.settings.set(LAST4_SETTING[kind], value.slice(-4), by);
}

export async function clearProviderKey(d: Pick<ModelKeyDeps, 'settings' | 'namedSecrets' | 'tenantId'>, kind: LlmProviderKind, by: string): Promise<void> {
  const s = providerSecret(kind);
  await d.namedSecrets.delete(d.tenantId, s.owner, s.ownerId, s.name);
  await d.settings.set(SECRET_ID_SETTING[kind], null, by);
  await d.settings.set(LAST4_SETTING[kind], null, by);
}
