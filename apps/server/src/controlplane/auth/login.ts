import type { Kysely } from 'kysely';
import * as oidc from 'openid-client';
import { isSafeReturnTo, type LoginErrorCode, type Role } from '@neurouter/shared';
import { INSTANCE_SCOPE_ID } from '../../kernel/tenancy/index.js';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { sha256 } from '../../kernel/lib/crypto.js';
import { pack, unpack } from '../../kernel/secrets/envelope.js';
import type { EnvelopeService } from '../../kernel/secrets/envelope.service.js';
import type { UsersService } from '../users/users.service.js';
import type { OidcProvider } from './oidc.js';

export interface LoginConfig {
  redirectUri: string;
  scopes: string;
  groupsClaim: string;
  adminGroups: readonly string[];
  defaultRole: Role;
  allowedEmailDomains: readonly string[];
  /** An email with a pending invite may sign in outside `allowedEmailDomains` (multi-tenancy spec §2.4). */
  invited?: (email: string) => Promise<boolean>;
}

export type LoginOutcome = { ok: true; userId: string; returnTo: string; idToken: string | null } | { ok: false; error: Exclude<LoginErrorCode, 'session_expired'>; reason: string };

const STATE_TTL_MS = 10 * 60_000;
const stateAad = (stateHashHex: string) => `neurouter:oidc-state:${stateHashHex}`;

/** Role from claims (§13.1): admin when a group claim is in OIDC_ADMIN_GROUPS, else OIDC_DEFAULT_ROLE (bootstrap email handled by UsersService). */
export function roleFromClaims(claims: Record<string, unknown>, cfg: Pick<LoginConfig, 'groupsClaim' | 'adminGroups' | 'defaultRole'>): Role {
  const raw = claims[cfg.groupsClaim];
  const groups = Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? raw.split(/[ ,]+/) : [];
  return groups.some((g) => cfg.adminGroups.includes(g)) ? 'admin' : cfg.defaultRole;
}

/**
 * Single-provider OIDC sign-in (ADAPT Hub auth/web/login.ts): state + nonce + PKCE (verifier sealed
 * with the envelope key), email-domain allow-list, user upsert with role from claims.
 */
export class LoginService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly envelope: EnvelopeService,
    private readonly users: UsersService,
    private readonly audit: AuditRecorder,
    private readonly cfg: LoginConfig,
    private readonly provider: OidcProvider | null,
  ) {}

  get oidcEnabled(): boolean {
    return this.provider !== null;
  }

  async start(returnTo: string | undefined): Promise<string> {
    if (!this.provider) throw new Error('OIDC is not configured');
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();
    const verifier = oidc.randomPKCECodeVerifier();
    const challenge = await oidc.calculatePKCECodeChallenge(verifier);
    const stateHash = sha256(state);
    // sign-in happens before any tenant is known: the login state is sealed under the instance scope
    const sealed = await this.envelope.seal(INSTANCE_SCOPE_ID, Buffer.from(verifier), stateAad(stateHash.toString('hex')));
    await this.db
      .insertInto('oidc_login_states')
      .values({ state_hash: stateHash, code_verifier_enc: Buffer.concat([Buffer.from(sealed.dekId.padEnd(36).slice(0, 36)), pack(sealed)]), nonce, return_to: isSafeReturnTo(returnTo) ? returnTo : '/', expires_at: this.clock.now() + STATE_TTL_MS })
      .execute();
    return this.provider.authorizationUrl({ redirectUri: this.cfg.redirectUri, scope: this.cfg.scopes, state, nonce, codeChallenge: challenge });
  }

  async finish(currentUrl: URL, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<LoginOutcome> {
    const fail = (error: Exclude<LoginErrorCode, 'session_expired'>, reason: string, userId: string | null = null): LoginOutcome => {
      this.audit.auth({ tenantId: null, userId, action: 'auth.login', status: 'blocked', reason, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
      return { ok: false, error, reason };
    };
    if (!this.provider) return fail('idp_error', 'oidc_not_configured');
    const state = currentUrl.searchParams.get('state');
    if (!state) return fail('idp_error', 'missing_state');
    const stateHash = sha256(state);
    const row = await this.db.selectFrom('oidc_login_states').selectAll().where('state_hash', '=', stateHash).executeTakeFirst();
    if (!row) return fail('idp_error', 'unknown_state');
    await this.db.deleteFrom('oidc_login_states').where('state_hash', '=', stateHash).execute();
    if (row.expires_at <= this.clock.now()) return fail('idp_error', 'state_expired');
    const idpError = currentUrl.searchParams.get('error');
    if (idpError) return fail(idpError === 'access_denied' ? 'access_denied' : 'idp_error', `idp:${idpError.slice(0, 64)}`);
    let verifier: string;
    try {
      const dekId = row.code_verifier_enc.subarray(0, 36).toString().trim();
      const sealed = unpack(row.code_verifier_enc.subarray(36));
      verifier = (await this.envelope.open(INSTANCE_SCOPE_ID, { dekId, ...sealed }, stateAad(stateHash.toString('hex')))).toString();
    } catch {
      return fail('idp_error', 'state_decrypt_failed');
    }
    let claims: Record<string, unknown>;
    let idToken: string | null;
    try {
      ({ claims, idToken } = await this.provider.callback(currentUrl, { codeVerifier: verifier, state, nonce: row.nonce }));
    } catch (err) {
      return fail('idp_error', `callback_failed:${(err as Error).message.slice(0, 120)}`);
    }
    const sub = typeof claims.sub === 'string' ? claims.sub : null;
    const email = typeof claims.email === 'string' ? claims.email.trim().toLowerCase() : null;
    if (!sub || !email) return fail('access_denied', 'missing_sub_or_email');
    const verified = claims.email_verified === undefined ? true : claims.email_verified === true || claims.email_verified === 'true';
    if (!verified) return fail('access_denied', 'email_not_verified');
    if (!this.domainAllowed(email) && !(await this.cfg.invited?.(email))) return fail('domain_not_allowed', 'email_domain_not_allowed');
    const name = typeof claims.name === 'string' && claims.name.trim() ? claims.name.trim().slice(0, 200) : email.split('@')[0]!;
    const user = await this.users.upsertOidc({ email, name, issuer: this.provider.issuer, subject: sub, role: roleFromClaims(claims, this.cfg) });
    if (user.status !== 'active') return fail('disabled', 'user_disabled', user.id);
    this.audit.auth({ tenantId: user.tenant_id, userId: user.id, action: 'auth.login', reason: 'oidc', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
    return { ok: true, userId: user.id, returnTo: row.return_to, idToken };
  }

  private domainAllowed(email: string): boolean {
    if (this.cfg.allowedEmailDomains.length === 0) return true;
    const domain = email.slice(email.lastIndexOf('@') + 1);
    return this.cfg.allowedEmailDomains.some((d) => d.toLowerCase() === domain);
  }

  async purgeExpiredStates(): Promise<void> {
    await this.db.deleteFrom('oidc_login_states').where('expires_at', '<=', this.clock.now()).execute();
  }
}
