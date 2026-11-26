import type { Kysely, Selectable } from 'kysely';
import type { Scope } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { ApiKeysTable, MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import { generateApiKey, hashSecret } from './api-key-format.js';

export type ApiKeyRowDb = Selectable<ApiKeysTable>;

export const AUTH_REVOKED_CHANNEL = 'auth.revoked';

export interface CreateKeyInput {
  tenantId: string;
  name: string;
  serverId: string;
  environmentId: string;
  scopes: Scope[];
  profile?: string | null;
  expiresInDays?: number | null;
  rateLimit?: { perMinute: number; burst: number } | null;
  ownerUserId: string;
  purpose?: 'user' | 'eval';
}

/** API keys bound to one server + environment (§13.2; ADAPT Hub identity/agents.service.ts). */
export class ApiKeysService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly pepper: string,
    private readonly audit: AuditRecorder,
    private readonly coord: CoordinationStore,
  ) {}

  async create(input: CreateKeyInput): Promise<{ key: ApiKeyRowDb; token: string; warnings: string[] }> {
    const env = await this.db.selectFrom('environments').select(['id', 'server_id', 'writes', 'code_mode', 'kind']).where('id', '=', input.environmentId).where('tenant_id', '=', input.tenantId).executeTakeFirst();
    if (!env || env.server_id !== input.serverId) throw AppError.validation('The environment does not belong to this server', [{ path: ['environmentId'], message: 'Environment of another server', code: 'environment_mismatch' }]);
    if (!input.scopes.length) throw AppError.validation('At least one scope is required', [{ path: ['scopes'], message: 'Pick at least one scope', code: 'too_small' }]);
    const days = input.expiresInDays === undefined ? 90 : input.expiresInDays;
    if (days !== null && days <= 0) throw AppError.validation('Expiry must be in the future', [{ path: ['expiresInDays'], message: 'Must be positive', code: 'invalid_expiry' }]);
    const g = generateApiKey();
    const now = this.clock.now();
    const id = newId();
    await this.db
      .insertInto('api_keys')
      .values({
        id,
        tenant_id: input.tenantId,
        key_id: g.keyId,
        secret_hash: hashSecret(this.pepper, g.secret),
        display_prefix: g.displayPrefix,
        name: input.name.slice(0, 200),
        purpose: input.purpose ?? 'user',
        owner_user_id: input.ownerUserId,
        server_id: input.serverId,
        environment_id: input.environmentId,
        scopes: toJsonColumn([...new Set(input.scopes)]),
        profile: input.profile ?? null,
        rate_limit: input.rateLimit ? toJsonColumn(input.rateLimit) : null,
        expires_at: days === null ? null : now + days * 86_400_000,
        created_at: now,
      })
      .execute();
    const warnings: string[] = [];
    const writes = parseJsonColumn<{ enabled?: boolean }>(env.writes) ?? {};
    if (input.scopes.includes('tools:write') && !writes.enabled) warnings.push('tools:write was granted but writes are off in this environment; write tools will be refused until writes are enabled.');
    if (input.scopes.includes('code:run') && env.code_mode !== 1) warnings.push('code:run was granted but code mode is off in this environment.');
    if (input.purpose !== 'eval') this.audit.auth({ tenantId: input.tenantId, userId: input.ownerUserId, action: 'api_key.create', reason: `${g.displayPrefix} ${input.scopes.join(' ')}` });
    return { key: await this.get(input.tenantId, id), token: g.token, warnings };
  }

  async get(tenantId: string, id: string): Promise<ApiKeyRowDb> {
    const k = await this.db.selectFrom('api_keys').selectAll().where('tenant_id', '=', tenantId).where('id', '=', id).executeTakeFirst();
    if (!k) throw AppError.notFound('API key');
    return k;
  }

  async rename(tenantId: string, id: string, name: string): Promise<ApiKeyRowDb> {
    await this.get(tenantId, id);
    await this.db.updateTable('api_keys').set({ name: name.slice(0, 200) }).where('id', '=', id).where('tenant_id', '=', tenantId).execute();
    return this.get(tenantId, id);
  }

  async revoke(tenantId: string, id: string, by: string | null): Promise<ApiKeyRowDb> {
    const k = await this.get(tenantId, id);
    if (k.revoked_at === null) {
      await this.db.updateTable('api_keys').set({ revoked_at: this.clock.now() }).where('id', '=', id).where('tenant_id', '=', tenantId).execute();
      await this.coord.publish(AUTH_REVOKED_CHANNEL, { apiKeyId: id, tenantId });
      if (k.purpose !== 'eval') this.audit.auth({ tenantId, userId: by, action: 'api_key.revoke', reason: k.display_prefix });
    }
    return this.get(tenantId, id);
  }

  static status(k: Pick<ApiKeyRowDb, 'revoked_at' | 'expires_at'>, now: number): 'active' | 'revoked' | 'expired' {
    if (k.revoked_at !== null) return 'revoked';
    if (k.expires_at !== null && k.expires_at <= now) return 'expired';
    return 'active';
  }
}
