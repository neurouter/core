import type { Insertable, Kysely } from 'kysely';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { MainDB, OauthTokensTable } from '../../kernel/db/schema.js';
import { toIso, toIsoOrNull, type Clock } from '../../kernel/lib/clock.js';
import { hmacSha256, randomToken, sha256 } from '../../kernel/lib/crypto.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn } from '../../kernel/lib/json.js';
import { OAuthError } from './cimd.js';
import { AUTH_REVOKED_CHANNEL, type ClientRow } from './clients.service.js';
import { verifyPkceS256 } from './pkce.js';
import { sameResource, type ResourceBase } from './resource.js';
import { isClientBlocked } from '../../kernel/tenancy/client-blocks.js';

export const CODE_TTL_MS = 60_000;
export const ACCESS_PREFIX = 'nrk_at_';
export const REFRESH_PREFIX = 'nrk_rt_';

export interface TokenResponse {
  access_token: string;
  token_type: 'Bearer';
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

/** Consented grant per (user, client, environment) for the console (§14.8 OAuthGrantRow). */
export interface OAuthGrantRow {
  id: string;
  user: { id: string; email: string };
  client: { id: string; clientId: string; name: string };
  environment: { id: string; slug: string; kind: string; server: { id: string; slug: string } };
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

/** A stable uuid derived from a hash (the token family of an authorization code). */
export function uuidFromHash(h: Buffer): string {
  const x = Buffer.from(sha256(h).subarray(0, 16));
  x[6] = (x[6]! & 0x0f) | 0x80;
  x[8] = (x[8]! & 0x3f) | 0x80;
  const s = x.toString('hex');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

/**
 * Codes and tokens of the Neurouter AS (§13.3; ADAPT Hub oauth/tokens.service.ts): single-use 60 s
 * codes (reuse revokes everything issued from the code), opaque `nrk_at_` access tokens bound to one
 * `/mcp/{server}/{env}` resource, rotating `nrk_rt_` refresh tokens (reuse of a rotated token revokes
 * the family). Only HMAC(HASH_PEPPER) hashes are stored; revocations reach replicas via `auth.revoked`.
 */
export class OAuthTokensService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly coord: CoordinationStore,
    private readonly audit: AuditRecorder,
    private readonly o: { pepper: string; accessTtlSec: number; refreshTtlDays: number; resourceBase?: ResourceBase },
  ) {}

  private hash(token: string): Buffer {
    return hmacSha256(this.o.pepper, token);
  }

  async issueCode(input: { clientRowId: string; userId: string; serverId: string; environmentId: string; redirectUri: string; codeChallenge: string; scopes: string[]; resource: string; tenantId: string }): Promise<string> {
    const code = randomToken(32);
    await this.db
      .insertInto('oauth_codes')
      .values({ code_hash: this.hash(code), tenant_id: input.tenantId, client_id: input.clientRowId, user_id: input.userId, server_id: input.serverId, environment_id: input.environmentId, redirect_uri: input.redirectUri, code_challenge: input.codeChallenge, scopes: input.scopes.join(' '), resource: input.resource, expires_at: this.clock.now() + CODE_TTL_MS, consumed_at: null })
      .execute();
    return code;
  }

  private async mint(input: { tenantId: string; clientRowId: string; userId: string; serverId: string; environmentId: string; scopes: string; resource: string; familyId: string; parentId: string | null; withRefresh: boolean }): Promise<TokenResponse> {
    const now = this.clock.now();
    const base = { tenant_id: input.tenantId, client_id: input.clientRowId, user_id: input.userId, server_id: input.serverId, environment_id: input.environmentId, scopes: input.scopes, resource: input.resource, family_id: input.familyId, parent_id: input.parentId, revoked_at: null, last_used_at: null, created_at: now };
    const access = `${ACCESS_PREFIX}${randomToken(32)}`;
    const rows: Insertable<OauthTokensTable>[] = [{ ...base, id: newId(), token_hash: this.hash(access), kind: 'access', expires_at: now + this.o.accessTtlSec * 1000 }];
    let refresh: string | undefined;
    if (input.withRefresh) {
      refresh = `${REFRESH_PREFIX}${randomToken(32)}`;
      rows.push({ ...base, id: newId(), token_hash: this.hash(refresh), kind: 'refresh', expires_at: now + this.o.refreshTtlDays * 86_400_000 });
    }
    await this.db.insertInto('oauth_tokens').values(rows).execute();
    return { access_token: access, token_type: 'Bearer', expires_in: this.o.accessTtlSec, ...(refresh ? { refresh_token: refresh } : {}), scope: input.scopes };
  }

  async revokeFamily(familyId: string, tenantId: string, reason: string): Promise<number> {
    const res = await this.db.updateTable('oauth_tokens').set({ revoked_at: this.clock.now() }).where('family_id', '=', familyId).where('tenant_id', '=', tenantId).where('revoked_at', 'is', null).executeTakeFirst();
    const n = Number(res.numUpdatedRows);
    if (n) {
      await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthFamilyId: familyId, tenantId });
      this.audit.auth({ tenantId, userId: null, action: 'oauth.token_family.revoke', reason: `${familyId}: ${reason}` });
    }
    return n;
  }

  /** `grant_type=authorization_code` (PKCE S256, exact redirect_uri, same client, same resource; single use). */
  async redeemCode(client: ClientRow, p: { code?: string | undefined; redirectUri?: string | undefined; codeVerifier?: string | undefined; resource?: string | undefined }): Promise<TokenResponse> {
    if (!p.code) throw new OAuthError('invalid_request', 'code is required');
    const codeHash = this.hash(p.code);
    const familyId = uuidFromHash(codeHash);
    const now = this.clock.now();
    const claimed = await this.db.updateTable('oauth_codes').set({ consumed_at: now }).where('code_hash', '=', codeHash).where('consumed_at', 'is', null).executeTakeFirst();
    const row = await this.db.selectFrom('oauth_codes').selectAll().where('code_hash', '=', codeHash).executeTakeFirst();
    if (!row) throw new OAuthError('invalid_grant', 'Unknown authorization code');
    if (!Number(claimed.numUpdatedRows)) {
      await this.revokeFamily(familyId, row.tenant_id, 'authorization code reused');
      throw new OAuthError('invalid_grant', 'Authorization code already used');
    }
    if (Number(row.expires_at) <= now) throw new OAuthError('invalid_grant', 'Authorization code expired');
    if (row.client_id !== client.id) throw new OAuthError('invalid_grant', 'Authorization code was issued to another client');
    if (await isClientBlocked(this.db, row.tenant_id, client.id)) throw new OAuthError('invalid_grant', 'This client is blocked in this organization');
    if (!p.redirectUri || p.redirectUri !== row.redirect_uri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    if (!verifyPkceS256(p.codeVerifier, row.code_challenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    if (!p.resource) throw new OAuthError('invalid_target', 'resource is required (RFC 8707)');
    if (!sameResource(p.resource, row.resource, this.o.resourceBase)) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    const grants = parseJsonColumn<string[]>(client.grant_types) ?? ['authorization_code'];
    const out = await this.mint({ tenantId: row.tenant_id, clientRowId: client.id, userId: row.user_id, serverId: row.server_id, environmentId: row.environment_id, scopes: row.scopes, resource: row.resource, familyId, parentId: null, withRefresh: grants.includes('refresh_token') });
    this.audit.auth({ tenantId: row.tenant_id, userId: row.user_id, action: 'oauth.token.issue', reason: `client ${client.client_id} → ${row.resource}` });
    return out;
  }

  /** `grant_type=refresh_token` with rotation; reuse of a rotated token revokes the family. */
  async refresh(client: ClientRow, p: { refreshToken?: string | undefined; resource?: string | undefined; scope?: string | undefined }): Promise<TokenResponse> {
    if (!p.refreshToken) throw new OAuthError('invalid_request', 'refresh_token is required');
    const now = this.clock.now();
    // tenant-scope: by-secret-hash
    const t = await this.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', this.hash(p.refreshToken)).where('kind', '=', 'refresh').executeTakeFirst();
    if (!t) throw new OAuthError('invalid_grant', 'Unknown refresh token');
    if (t.client_id !== client.id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
    if (await isClientBlocked(this.db, t.tenant_id, client.id)) throw new OAuthError('invalid_grant', 'This client is blocked in this organization');
    if (t.revoked_at !== null) {
      const rotated = await this.db.selectFrom('oauth_tokens').where('tenant_id', '=', t.tenant_id).select('id').where('parent_id', '=', t.id).limit(1).executeTakeFirst();
      if (rotated) await this.revokeFamily(t.family_id, t.tenant_id, 'rotated refresh token reused');
      throw new OAuthError('invalid_grant', 'Refresh token is no longer valid');
    }
    if (Number(t.expires_at) <= now) throw new OAuthError('invalid_grant', 'Refresh token expired');
    if (p.resource && !sameResource(p.resource, t.resource, this.o.resourceBase)) throw new OAuthError('invalid_target', 'A refresh token cannot be used for another environment');
    if (p.scope) {
      const asked = p.scope.split(/\s+/).filter(Boolean);
      const had = t.scopes.split(/\s+/);
      if (asked.some((s) => !had.includes(s))) throw new OAuthError('invalid_scope', 'A refresh cannot widen the scope');
    }
    const consent = await this.db.selectFrom('oauth_consents').where('tenant_id', '=', t.tenant_id).select('id').where('user_id', '=', t.user_id).where('client_id', '=', t.client_id).where('environment_id', '=', t.environment_id).where('revoked_at', 'is', null).executeTakeFirst();
    const user = await this.db.selectFrom('users').select('status').where('id', '=', t.user_id).executeTakeFirst();
    if (!consent || user?.status !== 'active') {
      await this.revokeFamily(t.family_id, t.tenant_id, 'consent or user no longer active');
      throw new OAuthError('invalid_grant', 'The authorization was revoked');
    }
    const res = await this.db.updateTable('oauth_tokens').where('tenant_id', '=', t.tenant_id).set({ revoked_at: now, last_used_at: now }).where('id', '=', t.id).where('revoked_at', 'is', null).executeTakeFirst();
    if (!Number(res.numUpdatedRows)) {
      await this.revokeFamily(t.family_id, t.tenant_id, 'concurrent refresh token reuse');
      throw new OAuthError('invalid_grant', 'Refresh token is no longer valid');
    }
    const scopes = p.scope ? [...new Set(['mcp:tools', ...p.scope.split(/\s+/).filter(Boolean)])].join(' ') : t.scopes;
    return this.mint({ tenantId: t.tenant_id, clientRowId: client.id, userId: t.user_id, serverId: t.server_id, environmentId: t.environment_id, scopes, resource: t.resource, familyId: t.family_id, parentId: t.id, withRefresh: true });
  }

  /** RFC 7009: refresh token → whole family; access token → that token. Unknown tokens are ignored. */
  async revoke(client: ClientRow, token: string | undefined): Promise<void> {
    if (!token) throw new OAuthError('invalid_request', 'token is required');
    // tenant-scope: by-secret-hash
    const t = await this.db.selectFrom('oauth_tokens').selectAll().where('token_hash', '=', this.hash(token)).executeTakeFirst();
    if (!t || t.client_id !== client.id) return;
    if (t.kind === 'refresh') {
      await this.revokeFamily(t.family_id, t.tenant_id, 'revoked by client');
      return;
    }
    await this.db.updateTable('oauth_tokens').where('tenant_id', '=', t.tenant_id).set({ revoked_at: this.clock.now() }).where('id', '=', t.id).where('revoked_at', 'is', null).execute();
    await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthTokenId: t.id });
  }

  /* ---------------------------------------------------------------- grants (console §14.8) */

  /** Grants of one tenant. */
  async grants(tenantId: string, q: { environmentId?: string | undefined; userId?: string | undefined } = {}): Promise<OAuthGrantRow[]> {
    let qb = this.db
      .selectFrom('oauth_consents as c')
      .innerJoin('oauth_clients as cl', 'cl.id', 'c.client_id')
      .innerJoin('users as u', 'u.id', 'c.user_id')
      .innerJoin('environments as e', 'e.id', 'c.environment_id')
      .innerJoin('servers as s', 's.id', 'e.server_id')
      .select(['c.id', 'c.client_id', 'c.user_id', 'c.environment_id', 'c.scopes', 'c.created_at', 'cl.client_name', 'cl.client_id as public_client_id', 'u.email', 'e.slug as env_slug', 'e.kind as env_kind', 's.id as server_id', 's.slug as server_slug'])
      .where('c.tenant_id', '=', tenantId)
      .where('c.revoked_at', 'is', null);
    if (q.environmentId) qb = qb.where('c.environment_id', '=', q.environmentId);
    if (q.userId) qb = qb.where('c.user_id', '=', q.userId);
    const rows = await qb.orderBy('c.created_at', 'desc').execute();
    const used = rows.length ? await this.db.selectFrom('oauth_tokens').select(['client_id', 'user_id', 'environment_id', (eb) => eb.fn.max('last_used_at').as('last')]).where('tenant_id', '=', tenantId).groupBy(['client_id', 'user_id', 'environment_id']).execute() : [];
    return rows.map((r) => {
      const last = used.find((u) => u.client_id === r.client_id && u.user_id === r.user_id && u.environment_id === r.environment_id)?.last;
      return {
        id: r.id,
        user: { id: r.user_id, email: r.email },
        client: { id: r.client_id, clientId: r.public_client_id, name: r.client_name },
        environment: { id: r.environment_id, slug: r.env_slug, kind: r.env_kind, server: { id: r.server_id, slug: r.server_slug } },
        scopes: r.scopes.split(/\s+/).filter(Boolean),
        createdAt: toIso(Number(r.created_at)),
        lastUsedAt: toIsoOrNull(last ? Number(last) : null),
      };
    });
  }

  /** Revokes a consent and every token for (user, client, environment). */
  async revokeGrant(tenantId: string, id: string, by: { id: string } | null): Promise<void> {
    const c = await this.db.selectFrom('oauth_consents').selectAll().where('id', '=', id).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!c || c.revoked_at !== null) throw AppError.notFound('OAuth grant');
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('oauth_consents').set({ revoked_at: now }).where('id', '=', id).where('tenant_id', '=', tenantId).execute();
      await trx.updateTable('oauth_tokens').set({ revoked_at: now }).where('tenant_id', '=', tenantId).where('user_id', '=', c.user_id).where('client_id', '=', c.client_id).where('environment_id', '=', c.environment_id).where('revoked_at', 'is', null).execute();
    });
    await this.coord.publish(AUTH_REVOKED_CHANNEL, { oauthConsentId: id });
    this.audit.auth({ tenantId, userId: by?.id ?? null, action: 'oauth.grant.revoke', reason: `consent ${id} client ${c.client_id} environment ${c.environment_id}` });
  }

  /** Housekeeping: expired codes, authorization requests, long-dead tokens. */
  async cleanup(now = this.clock.now()): Promise<{ codes: number; requests: number; tokens: number }> {
    const codes = await this.db.deleteFrom('oauth_codes').where('expires_at', '<', now - 3_600_000).executeTakeFirst();
    // tenant-scope: system-job (expired rows of every tenant)
    const requests = await this.db.deleteFrom('oauth_authz_requests').where('expires_at', '<', now).executeTakeFirst();
    // tenant-scope: system-job (expired rows of every tenant)
    const tokens = await this.db.deleteFrom('oauth_tokens').where('expires_at', '<', now - 86_400_000).executeTakeFirst();
    return { codes: Number(codes.numDeletedRows), requests: Number(requests.numDeletedRows), tokens: Number(tokens.numDeletedRows) };
  }
}
