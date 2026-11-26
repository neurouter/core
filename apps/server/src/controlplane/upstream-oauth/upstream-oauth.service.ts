import type { Kysely } from 'kysely';
import { isSafeReturnTo } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { hmacSha256, randomToken } from '../../kernel/lib/crypto.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn } from '../../kernel/lib/json.js';
import type { FetchLike } from '../../kernel/lib/net/safe-fetch.js';
import type { UpstreamAuthDescriptor } from '../../kernel/runtime-config.js';
import { pack, unpack } from '../../kernel/secrets/envelope.js';
import type { EnvelopeService } from '../../kernel/secrets/envelope.service.js';
import { s256 } from '../oauth/pkce.js';

export const UPSTREAM_STATE_TTL_MS = 10 * 60_000;
/** Refresh on use when the access token expires within this window. */
export const REFRESH_SKEW_MS = 60_000;

/** `(environmentId, userId) → access token | null` consumed by the data plane's CredentialResolver. */
export type UpstreamTokenSource = (tenantId: string, environmentId: string, userId: string) => Promise<string | null>;

const tokenAad = (envId: string, userId: string, kind: 'access' | 'refresh') => `neurouter-core:upstream-token:${envId}:${userId}:${kind}`;
const stateAad = (hashHex: string) => `neurouter-core:upstream-oauth-state:${hashHex}`;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
}

/**
 * Upstream OAuth broker (§13.5 `oauth_passthrough`, broker mode; ADAPT Hub upstream-oauth service):
 * the end user connects once per environment (authorization code + PKCE against the API's own AS
 * configured on the environment), tokens are stored encrypted in `upstream_tokens` and refreshed on
 * use under a cluster lock. The MCP client's Neurouter token never reaches the upstream.
 */
export class UpstreamOAuthService {
  constructor(
    private readonly d: {
      db: Kysely<MainDB>;
      clock: Clock;
      envelope: EnvelopeService;
      coord: CoordinationStore;
      audit: AuditRecorder;
      /** Resolves `env:` / `secret:` refs for the environment (client secret). */
      secrets: (ref: string, scope: { tenantId: string; environmentId: string }) => Promise<string | null>;
      fetch: (allowHttp: boolean) => FetchLike;
      publicUrl: string;
      pepper: string;
      /** Spec §3.5: the signed-in user must belong to the environment's tenant. */
      isMember: (tenantId: string, userId: string) => Promise<boolean>;
      log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
    },
  ) {}

  get callbackUrl(): string {
    return `${this.d.publicUrl}/oauth/upstream/callback`;
  }

  private async environment(environmentId: string) {
    const e = await this.d.db.selectFrom('environments').select(['id', 'tenant_id', 'slug', 'auth', 'allow_http', 'status']).where('id', '=', environmentId).executeTakeFirst();
    if (!e) throw AppError.notFound('Environment');
    const auth = (parseJsonColumn<UpstreamAuthDescriptor>(e.auth) ?? { type: 'none' }) as UpstreamAuthDescriptor;
    if (auth.type !== 'oauth_passthrough' || !auth.authorizationUrl || !auth.tokenUrl || !auth.clientId) throw AppError.conflict('This environment does not use per-user OAuth (oauth_passthrough broker mode)');
    return { ...e, auth };
  }

  private async clientSecret(env: { id: string; tenant_id: string }, auth: UpstreamAuthDescriptor): Promise<string | null> {
    return auth.clientSecret ? this.d.secrets(auth.clientSecret, { tenantId: env.tenant_id, environmentId: env.id }) : null;
  }

  /** Starts a connection: single-use state bound to the user (10 min) + PKCE S256. Returns the upstream authorize URL. */
  async authorizeUrl(environmentId: string, viewer: { id: string }, returnTo: string | undefined): Promise<string> {
    const env = await this.environment(environmentId);
    // tenant-scope: by-id lookup above; membership of the environment's tenant is checked here (spec §3.5)
    if (!(await this.d.isMember(env.tenant_id, viewer.id))) throw AppError.notFound('Environment');
    if (env.status !== 'active') throw AppError.conflict('This environment is disabled');
    const state = randomToken(32);
    const verifier = randomToken(48);
    const hash = hmacSha256(this.d.pepper, state);
    const sealed = await this.d.envelope.seal(Buffer.from(verifier), stateAad(hash.toString('hex')));
    await this.d.db
      .insertInto('upstream_oauth_states')
      .values({
        state_hash: hash,
        tenant_id: env.tenant_id,
        user_id: viewer.id,
        environment_id: env.id,
        code_verifier_enc: Buffer.concat([Buffer.from(sealed.dekId.padEnd(36).slice(0, 36)), pack(sealed)]),
        redirect_after: returnTo && isSafeReturnTo(returnTo) && !returnTo.startsWith('/api/') ? returnTo : '/connect',
        expires_at: this.d.clock.now() + UPSTREAM_STATE_TTL_MS,
      })
      .execute();
    const u = new URL(env.auth.authorizationUrl!);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('client_id', env.auth.clientId!);
    u.searchParams.set('redirect_uri', this.callbackUrl);
    u.searchParams.set('state', state);
    u.searchParams.set('code_challenge', s256(verifier));
    u.searchParams.set('code_challenge_method', 'S256');
    if (env.auth.scopes?.length) u.searchParams.set('scope', env.auth.scopes.join(' '));
    return u.toString();
  }

  /** `/oauth/upstream/callback`: state (single use, same user) → code exchange with PKCE → encrypted tokens. Returns where to send the browser. */
  async callback(q: Record<string, string | undefined>, viewer: { id: string } | null): Promise<string> {
    const fail = (to: string, code: string, envId?: string) => {
      const u = new URL(to, 'http://x');
      u.searchParams.set('error', code);
      if (envId) u.searchParams.set('environment', envId);
      return `${u.pathname}${u.search}`;
    };
    if (!q.state) return fail('/connect', 'invalid_state');
    const hash = hmacSha256(this.d.pepper, q.state);
    const row = await this.d.db.selectFrom('upstream_oauth_states').selectAll().where('state_hash', '=', hash).executeTakeFirst();
    if (!row) return fail('/connect', 'invalid_state');
    await this.d.db.deleteFrom('upstream_oauth_states').where('state_hash', '=', hash).execute();
    const back = row.redirect_after;
    if (!viewer || viewer.id !== row.user_id) return fail(back, 'session_mismatch', row.environment_id);
    if (Number(row.expires_at) <= this.d.clock.now()) return fail(back, 'expired', row.environment_id);
    if (q.error) return fail(back, /^[a-z_]{1,64}$/.test(q.error) ? q.error : 'upstream_error', row.environment_id);
    if (!q.code) return fail(back, 'invalid_request', row.environment_id);
    try {
      const env = await this.environment(row.environment_id);
      if (env.tenant_id !== row.tenant_id || !(await this.d.isMember(env.tenant_id, viewer.id))) return fail(back, 'session_mismatch', row.environment_id);
      const dekId = row.code_verifier_enc.subarray(0, 36).toString().trim();
      const verifier = (await this.d.envelope.open({ dekId, ...unpack(row.code_verifier_enc.subarray(36)) }, stateAad(hash.toString('hex')))).toString();
      const tokens = await this.tokenRequest(env, env.auth, env.allow_http === 1, { grant_type: 'authorization_code', code: q.code, redirect_uri: this.callbackUrl, code_verifier: verifier });
      await this.save(env.tenant_id, env.id, row.user_id, tokens, null);
      this.d.audit.auth({ tenantId: env.tenant_id, userId: viewer.id, action: 'upstream_oauth.connect', reason: `environment ${env.id}` });
      const u = new URL(back, 'http://x');
      u.searchParams.set('connected', env.id);
      return `${u.pathname}${u.search}`;
    } catch (err) {
      this.d.log.warn({ err, environmentId: row.environment_id }, 'upstream OAuth callback failed');
      return fail(back, 'token_exchange_failed', row.environment_id);
    }
  }

  private async tokenRequest(env: { id: string; tenant_id: string }, auth: UpstreamAuthDescriptor, allowHttp: boolean, params: Record<string, string>): Promise<TokenResponse> {
    const body = new URLSearchParams({ ...params, client_id: auth.clientId! });
    const secret = await this.clientSecret(env, auth);
    if (secret) body.set('client_secret', secret);
    const res = await this.d.fetch(allowHttp)(auth.tokenUrl!, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: body.toString() });
    const json = (await res.json().catch(() => ({}))) as TokenResponse & { error?: string };
    if (!res.ok || !json.access_token) throw Object.assign(new Error(`token endpoint answered ${res.status}${json.error ? ` (${json.error})` : ''}`), { oauthError: json.error ?? null });
    return json;
  }

  /** Encrypts and upserts the user's tokens (keeps the old refresh token when the AS does not rotate). */
  async save(tenantId: string, envId: string, userId: string, t: TokenResponse, previousRefresh: string | null): Promise<void> {
    const now = this.d.clock.now();
    const access = await this.d.envelope.seal(Buffer.from(t.access_token), tokenAad(envId, userId, 'access'));
    const refreshValue = t.refresh_token ?? previousRefresh;
    const refresh = refreshValue ? await this.d.envelope.seal(Buffer.from(refreshValue), tokenAad(envId, userId, 'refresh')) : null;
    const values = {
      dek_id: access.dekId,
      access_nonce: access.nonce,
      access_ciphertext: access.ciphertext,
      refresh_nonce: refresh?.nonce ?? null,
      refresh_ciphertext: refresh?.ciphertext ?? null,
      scopes: t.scope ?? '',
      expires_at: t.expires_in ? now + Number(t.expires_in) * 1000 : null,
      status: 'active' as const,
      updated_at: now,
    };
    await this.d.db
      .insertInto('upstream_tokens')
      .values({ id: newId(), tenant_id: tenantId, environment_id: envId, user_id: userId, created_at: now, ...values })
      .onConflict((oc) => oc.columns(['tenant_id', 'environment_id', 'user_id']).doUpdateSet(values))
      .execute();
  }

  private async readRefresh(row: { dek_id: string; refresh_nonce: Buffer | null; refresh_ciphertext: Buffer | null; environment_id: string; user_id: string }): Promise<string | null> {
    if (!row.refresh_ciphertext || !row.refresh_nonce) return null;
    return (await this.d.envelope.open({ dekId: row.dek_id, nonce: row.refresh_nonce, ciphertext: row.refresh_ciphertext }, tokenAad(row.environment_id, row.user_id, 'refresh'))).toString('utf8');
  }

  /** The data plane's `UpstreamTokenSource`: decrypts the user's token, refreshing it first when it is about to expire. */
  token: UpstreamTokenSource = async (tenantId, environmentId, userId) => {
    let row = await this.d.db.selectFrom('upstream_tokens').selectAll().where('tenant_id', '=', tenantId).where('environment_id', '=', environmentId).where('user_id', '=', userId).executeTakeFirst();
    if (!row || row.status !== 'active') return null;
    if (row.expires_at !== null && Number(row.expires_at) - this.d.clock.now() <= REFRESH_SKEW_MS) {
      const r = await this.refresh(tenantId, environmentId, userId).catch((err: unknown) => {
        this.d.log.warn({ err, environmentId }, 'upstream token refresh failed');
        return 'failed' as const;
      });
      if (r === 'failed' || r === 'no_refresh_token') return Number(row.expires_at) > this.d.clock.now() ? this.decryptAccess(row) : null;
      row = await this.d.db.selectFrom('upstream_tokens').selectAll().where('tenant_id', '=', tenantId).where('environment_id', '=', environmentId).where('user_id', '=', userId).executeTakeFirst();
      if (!row || row.status !== 'active') return null;
    }
    return this.decryptAccess(row);
  };

  private async decryptAccess(row: { dek_id: string; access_nonce: Buffer; access_ciphertext: Buffer; environment_id: string; user_id: string }): Promise<string> {
    return (await this.d.envelope.open({ dekId: row.dek_id, nonce: row.access_nonce, ciphertext: row.access_ciphertext }, tokenAad(row.environment_id, row.user_id, 'access'))).toString('utf8');
  }

  /** Refreshes one user's token under a cluster-wide lock. `invalid_grant` → `refresh_failed` (user must reconnect). */
  async refresh(tenantId: string, environmentId: string, userId: string): Promise<'refreshed' | 'fresh' | 'failed' | 'no_refresh_token'> {
    return this.d.coord.withLock(`upstream-refresh:${environmentId}:${userId}`, 30_000, async () => {
      const row = await this.d.db.selectFrom('upstream_tokens').selectAll().where('tenant_id', '=', tenantId).where('environment_id', '=', environmentId).where('user_id', '=', userId).executeTakeFirst();
      if (!row || row.status !== 'active') return 'failed';
      if (row.expires_at === null || Number(row.expires_at) - this.d.clock.now() > REFRESH_SKEW_MS) return 'fresh';
      const refreshToken = await this.readRefresh(row);
      if (!refreshToken) return 'no_refresh_token';
      const env = await this.environment(environmentId);
      try {
        const t = await this.tokenRequest(env, env.auth, env.allow_http === 1, { grant_type: 'refresh_token', refresh_token: refreshToken });
        await this.save(env.tenant_id, env.id, userId, t, refreshToken);
        return 'refreshed';
      } catch (err) {
        const code = (err as { oauthError?: string | null }).oauthError;
        if (code === 'invalid_grant' || code === 'invalid_client' || code === 'unauthorized_client') {
          await this.d.db.updateTable('upstream_tokens').set({ status: 'refresh_failed', updated_at: this.d.clock.now() }).where('id', '=', row.id).where('tenant_id', '=', tenantId).execute();
          return 'failed';
        }
        throw err;
      }
    });
  }

  async disconnect(tenantId: string, environmentId: string, userId: string): Promise<void> {
    await this.d.db.deleteFrom('upstream_tokens').where('tenant_id', '=', tenantId).where('environment_id', '=', environmentId).where('user_id', '=', userId).execute();
    this.d.audit.auth({ tenantId, userId, action: 'upstream_oauth.disconnect', reason: `environment ${environmentId}` });
  }

  async cleanupStates(now = this.d.clock.now()): Promise<number> {
    const res = await this.d.db.deleteFrom('upstream_oauth_states').where('expires_at', '<', now).executeTakeFirst();
    return Number(res.numDeletedRows);
  }
}
