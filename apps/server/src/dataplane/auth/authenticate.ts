import { isClientBlocked } from '../../kernel/tenancy/client-blocks.js';
import type { Kysely } from 'kysely';
import { OAUTH_SCOPE_MAP, Scope, type OAuthScope } from '@neurouter/shared';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { hmacSha256, sha256, timingSafeEqualBuf } from '../../kernel/lib/crypto.js';
import { parseJsonColumn } from '../../kernel/lib/json.js';
import type { Principal } from '../pipeline/context.js';
import type { ExternalJwtVerifier } from './external-jwt.js';

export const AUTH_REVOKED_CHANNEL = 'auth.revoked';

export const API_KEY_PREFIX = 'nrk_live_';
const KEY_ID_RE = /^[0-9A-HJKMNP-TV-Z]{10}$/;
const SECRET_RE = /^[0-9A-Za-z]{40,64}$/;

/** `nrk_live_<10-char Crockford key id>_<base62 secret>` (§13.2). */
export function parseApiKey(token: string): { keyId: string; secret: string } | null {
  if (!token.startsWith(API_KEY_PREFIX)) return null;
  const rest = token.slice(API_KEY_PREFIX.length);
  if (rest.indexOf('_') !== 10) return null;
  const keyId = rest.slice(0, 10);
  const secret = rest.slice(11);
  if (!KEY_ID_RE.test(keyId) || !SECRET_RE.test(secret)) return null;
  return { keyId, secret };
}

export interface AuthTarget {
  tenantId: string;
  serverId: string;
  environmentId: string;
  /** The MCP resource URI of `/mcp/{server}/{env}`. */
  resourceUri: string;
}

export type AuthOutcome =
  | { ok: true; principal: Principal; credentialKey: string }
  | { ok: false; error: 'missing_token' | 'invalid_token' | 'insufficient_scope'; reason: string };

/**
 * Bearer authentication for `/mcp/{server}/{env}` (§13.2–13.4; ADAPT Hub auth/mcp/authenticate.ts):
 * `nrk_live_…` API keys (HMAC-SHA256 with HASH_PEPPER, constant time) bound to one server+env;
 * `nrk_at_…` OAuth access tokens audience-bound to the endpoint's resource URI; external-AS JWTs.
 * Results are cached for 30 s and dropped on `auth.revoked`.
 */
export class McpAuthenticator {
  private readonly cache = new Map<string, { at: number; outcome: AuthOutcome }>();
  private readonly lastTouched = new Map<string, number>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly opts: { pepper: string; cacheTtlMs?: number; external?: ExternalJwtVerifier | null; resourceBase?: { publicUrl: string; aliases?: readonly string[] } },
    coord?: CoordinationStore,
  ) {
    coord?.subscribe(AUTH_REVOKED_CHANNEL, () => this.cache.clear());
  }

  clearCache(): void {
    this.cache.clear();
  }

  async authenticate(authorization: string | undefined, target: AuthTarget, meta: { ip?: string | null } = {}): Promise<AuthOutcome> {
    if (!authorization) return { ok: false, error: 'missing_token', reason: 'no Authorization header' };
    const m = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (!m) return { ok: false, error: 'invalid_token', reason: 'not a Bearer token' };
    const token = m[1]!;
    const key = `${target.tenantId}|${target.environmentId}|${sha256(token).toString('base64url')}`;
    const now = this.clock.now();
    const hit = this.cache.get(key);
    let outcome: AuthOutcome;
    if (hit && now - hit.at < (this.opts.cacheTtlMs ?? 30_000)) {
      outcome = hit.outcome;
    } else {
      if (token.startsWith(API_KEY_PREFIX)) outcome = await this.apiKey(token, target, now);
      else if (token.startsWith('nrk_at_')) outcome = await this.oauthToken(token, target, now);
      else if (this.opts.external && token.split('.').length === 3) outcome = await this.opts.external.verify(token, target.resourceUri);
      else outcome = { ok: false, error: 'invalid_token', reason: 'unknown token format' };
      if (this.cache.size > 10_000) this.cache.clear();
      this.cache.set(key, { at: now, outcome });
    }
    if (outcome.ok) this.touch(outcome.principal, now, meta.ip ?? null);
    return outcome;
  }

  private async apiKey(token: string, t: AuthTarget, now: number): Promise<AuthOutcome> {
    const parsed = parseApiKey(token);
    if (!parsed) return { ok: false, error: 'invalid_token', reason: 'malformed api key' };
    const k = await this.db
      .selectFrom('api_keys as k')
      .innerJoin('users as u', 'u.id', 'k.owner_user_id')
      .select(['k.id', 'k.secret_hash', 'k.revoked_at', 'k.expires_at', 'k.server_id', 'k.environment_id', 'k.scopes', 'k.profile', 'k.purpose', 'k.name', 'k.rate_limit', 'k.tenant_id', 'k.owner_user_id', 'u.status as ustatus'])
      .where('k.key_id', '=', parsed.keyId)
      .executeTakeFirst();
    if (!k || !timingSafeEqualBuf(hmacSha256(this.opts.pepper, parsed.secret), k.secret_hash)) return { ok: false, error: 'invalid_token', reason: 'unknown api key' };
    if (k.revoked_at !== null) return { ok: false, error: 'invalid_token', reason: 'api key revoked' };
    if (k.expires_at !== null && k.expires_at <= now) return { ok: false, error: 'invalid_token', reason: 'api key expired' };
    if (k.ustatus !== 'active') return { ok: false, error: 'invalid_token', reason: 'owner disabled' };
    // keys are bound to one server + environment (§9.1): another endpoint → invalid_token
    if (k.tenant_id !== t.tenantId || k.server_id !== t.serverId || k.environment_id !== t.environmentId) return { ok: false, error: 'invalid_token', reason: 'api key bound to another environment' };
    const scopes = (parseJsonColumn<string[]>(k.scopes) ?? []).filter((s): s is Scope => Scope.safeParse(s).success);
    return {
      ok: true,
      credentialKey: k.id,
      principal: { type: 'api_key', userId: k.owner_user_id, apiKeyId: k.id, scopes, profile: k.profile, purpose: k.purpose, name: k.name, rateLimit: parseJsonColumn(k.rate_limit) },
    };
  }

  private async oauthToken(token: string, t: AuthTarget, now: number): Promise<AuthOutcome> {
    const row = await this.db
      .selectFrom('oauth_tokens as t')
      .innerJoin('users as u', 'u.id', 't.user_id')
      .select(['t.id', 't.tenant_id', 't.revoked_at', 't.expires_at', 't.resource', 't.environment_id', 't.scopes', 't.client_id', 't.user_id', 't.family_id', 'u.status as ustatus', 'u.email'])
      .where('t.token_hash', '=', hmacSha256(this.opts.pepper, token))
      .where('t.kind', '=', 'access')
      .executeTakeFirst();
    if (!row || row.revoked_at !== null || row.expires_at <= now) return { ok: false, error: 'invalid_token', reason: 'unknown, revoked or expired token' };
    if (row.ustatus !== 'active') return { ok: false, error: 'invalid_token', reason: 'user disabled' };
    // the token's tenant must be the endpoint's tenant (spec §3.2), then environment + RFC 8707 resource
    if (row.tenant_id !== t.tenantId || row.environment_id !== t.environmentId || !sameResource(row.resource, t.resourceUri, this.opts.resourceBase)) return { ok: false, error: 'invalid_token', reason: 'token audience mismatch' };
    const raw = row.scopes.split(/\s+/).filter(Boolean);
    const scopes = [...new Set(raw.map((s) => OAUTH_SCOPE_MAP[s as OAuthScope]).filter(Boolean))];
    if (!scopes.includes('tools:read')) return { ok: false, error: 'insufficient_scope', reason: 'missing scope mcp:tools' };
    const client = await this.db.selectFrom('oauth_clients').select(['status', 'client_name']).where('id', '=', row.client_id).executeTakeFirst();
    if (client?.status === 'blocked') return { ok: false, error: 'invalid_token', reason: 'client blocked' };
    if (await isClientBlocked(this.db, row.tenant_id, row.client_id)) return { ok: false, error: 'invalid_token', reason: 'client blocked in this organization' };
    return { ok: true, credentialKey: row.family_id, principal: { type: 'user', userId: row.user_id, oauthTokenId: row.id, oauthClientId: row.client_id, scopes, familyId: row.family_id, name: row.email } };
  }

  /** `last_used_at` updated asynchronously, at most once a minute per credential. */
  private touch(p: Principal, now: number, ip: string | null): void {
    const id = p.type === 'api_key' ? p.apiKeyId : p.type === 'user' ? p.oauthTokenId : null;
    if (!id) return;
    const last = this.lastTouched.get(id) ?? 0;
    if (now - last < 60_000) return;
    this.lastTouched.set(id, now);
    if (this.lastTouched.size > 50_000) this.lastTouched.clear();
    // tenant-scope: child-of-scoped (the credential just authenticated for this endpoint)
    const work = p.type === 'api_key' ? this.db.updateTable('api_keys').set({ last_used_at: now, last_used_ip: ip }).where('id', '=', id).execute() : this.db.updateTable('oauth_tokens').set({ last_used_at: now }).where('id', '=', id).execute();
    void work.catch(() => {});
  }
}

/** RFC 8707 audience check; tolerate a differently-cased host; former base URLs (`NEUROUTER_RESOURCE_ALIASES`) count as the current one. */
export function sameResource(a0: string, b0: string, base?: { publicUrl: string; aliases?: readonly string[] }): boolean {
  const canon = (r: string) => {
    for (const al of base?.aliases ?? []) {
      const root = al.replace(/\/+$/, '');
      if (r.toLowerCase().startsWith(`${root.toLowerCase()}/mcp/`)) return `${base!.publicUrl}${r.slice(root.length)}`;
    }
    return r;
  };
  const a = canon(a0);
  const b = canon(b0);
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search;
  } catch {
    return false;
  }
}
