import type { Kysely } from 'kysely';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { hmacSha256, hmacSha256Hex, randomToken, timingSafeEqualStr } from '../../kernel/lib/crypto.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import { OAuthError } from './cimd.js';
import type { OAuthClientsService, ResolvedClient } from './clients.service.js';
import { parseScope, SCOPE_DESCRIPTIONS, type McpOAuthScope } from './metadata.js';
import { PKCE_CHALLENGE_RE } from './pkce.js';
import { isLoopbackRedirect, redirectUriMatches, withParams } from './redirect-uri.js';
import { resolveResource, type ResolvedResource } from './resource.js';
import { isClientBlocked } from '../../kernel/tenancy/client-blocks.js';
import type { TenantResolver } from '../../kernel/tenancy/types.js';
import type { ConsoleSessionUser } from './session.js';
import type { OAuthTokensService } from './tokens.service.js';

export const AUTHZ_REQUEST_TTL_MS = 10 * 60_000;

interface AuthzParams {
  redirect_uri: string;
  requested: McpOAuthScope[];
  /** Scopes the user may grant for this environment (others are never offered). */
  grantable: McpOAuthScope[];
  state: string | null;
  code_challenge: string;
  resource: string;
  environment_id: string;
  server_id: string;
}

export type AuthorizeOutcome =
  | { kind: 'error_page'; status: number; error: string; description: string }
  | { kind: 'redirect'; location: string }
  | { kind: 'login'; location: string }
  | { kind: 'consent'; location: string; requestId: string; cookieValue: string };

export interface ConsentView {
  requestId: string;
  csrfToken: string;
  client: { name: string; id: string; idHost: string | null; verified: boolean; clientUri: string | null; localhostOnly: boolean; redirectHost: string };
  server: { slug: string; name: string };
  environment: { slug: string; name: string; kind: 'dev' | 'qa' | 'prod' };
  scopes: Array<{ name: McpOAuthScope; description: string; checked: boolean; disabled: boolean; note?: string }>;
  user: { email: string };
}

/** Scopes this environment can grant (§13.3): mcp:tools always; mcp:write only with writes on; mcp:code only with code mode on. */
export function grantableScopes(r: ResolvedResource, codeModeEnabled: boolean): McpOAuthScope[] {
  const out: McpOAuthScope[] = ['mcp:tools'];
  if (r.environment.writesEnabled) out.push('mcp:write');
  if (r.environment.codeMode && codeModeEnabled) out.push('mcp:code');
  return out;
}

/**
 * Authorization endpoint + consent of the Neurouter AS (§13.3; ADAPT Hub oauth/authorize.ts). The
 * resource (RFC 8707) is required and must be one of our `/mcp/{server}/{env}` endpoints, so every
 * token is audience-bound to one environment (A5). Confused-deputy protections as Hub: exact redirect
 * URI matching, errors before redirect_uri validation are shown (not redirected), a single-use request
 * bound to the signed-in user, an HMAC consent cookie bound to (request, user) plus the session CSRF
 * token, `state` round-tripped untouched and `iss` always sent (RFC 9207).
 */
export class AuthorizationService {
  private readonly cookieKey: Buffer;

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly clients: OAuthClientsService,
    private readonly tokens: OAuthTokensService,
    private readonly audit: AuditRecorder,
    private readonly o: {
      issuer: string;
      publicUrl: string;
      pepper: string;
      codeModeEnabled: (tenantId: string) => Promise<boolean>;
      /** Spec §3.4: consent needs a membership in the resource's tenant. */
      isMember: (tenantId: string, userId: string) => Promise<boolean>;
      tenancy: Pick<TenantResolver, 'forMcp'>;
      resourceAliases?: readonly string[];
      loginUrl: (returnTo: string) => string;
    },
  ) {
    this.cookieKey = hmacSha256(o.pepper, 'neurouter-core:oauth-consent-cookie');
  }

  private base() {
    return { publicUrl: this.o.publicUrl, aliases: this.o.resourceAliases ?? [], tenancy: this.o.tenancy };
  }

  consentCookieValue(requestId: string, userId: string): string {
    return `${requestId}.${hmacSha256Hex(this.cookieKey, `${requestId}:${userId}`)}`;
  }

  private cookieMatches(value: string | undefined, requestId: string, userId: string): boolean {
    return !!value && timingSafeEqualStr(value, this.consentCookieValue(requestId, userId));
  }

  async authorize(q: Record<string, string | undefined>, resumeUrl: string, user: ConsoleSessionUser | null): Promise<AuthorizeOutcome> {
    const page = (error: string, description: string, status = 400): AuthorizeOutcome => ({ kind: 'error_page', status, error, description });
    let client: ResolvedClient;
    try {
      client = await this.clients.resolve(q.client_id ?? '');
    } catch (err) {
      if (err instanceof OAuthError) return page(err.error, err.description);
      throw err;
    }
    let redirectUri = q.redirect_uri;
    if (!redirectUri) {
      if (client.redirectUris.length !== 1) return page('invalid_request', 'redirect_uri is required');
      redirectUri = client.redirectUris[0]!;
    }
    if (!redirectUriMatches(client.redirectUris, redirectUri)) return page('invalid_request', `redirect_uri ${redirectUri} is not registered for ${client.row.client_name}`);
    const state = q.state ?? null;
    const back = (error: string, description: string): AuthorizeOutcome => ({ kind: 'redirect', location: withParams(redirectUri!, { error, error_description: description, state, iss: this.o.issuer }) });
    if (q.response_type !== 'code') return back('unsupported_response_type', 'response_type must be code');
    if (!client.grantTypes.includes('authorization_code')) return back('unauthorized_client', 'This client may not use the authorization code grant');
    if (!q.code_challenge || !PKCE_CHALLENGE_RE.test(q.code_challenge)) return back('invalid_request', 'code_challenge (PKCE S256) is required');
    if (q.code_challenge_method !== 'S256') return back('invalid_request', 'code_challenge_method must be S256');
    if (!q.resource) return back('invalid_target', `resource is required (RFC 8707); use ${this.o.publicUrl}/mcp/{server}/{environment}`);
    const target = await resolveResource(this.db, this.base(), q.resource);
    if (!target) return back('invalid_target', 'Unknown or disabled resource; expected an MCP endpoint of this server');
    const requested = parseScope(q.scope);
    if (!requested) return back('invalid_scope', 'Unsupported scope; supported: mcp:tools mcp:write mcp:code');
    if (!user) return { kind: 'login', location: this.o.loginUrl(resumeUrl) };
    // the signed-in user must belong to the resource's tenant; a client blocked by that tenant gets no code (G2, G14)
    if (!(await this.o.isMember(target.tenantId, user.id))) return page('access_denied', `You are not a member of the organization that owns ${target.server.slug}/${target.environment.slug}. Sign in with another account.`, 403);
    if (await isClientBlocked(this.db, target.tenantId, client.row.id)) return back('access_denied', 'This client has been blocked by an administrator');
    const grantable = grantableScopes(target, await this.o.codeModeEnabled(target.tenantId));
    const id = newId();
    const params: AuthzParams = { redirect_uri: redirectUri, requested, grantable, state, code_challenge: q.code_challenge, resource: target.resource, environment_id: target.environment.id, server_id: target.server.id };
    await this.db.insertInto('oauth_authz_requests').values({ id, tenant_id: target.tenantId, client_id: client.row.id, params: toJsonColumn(params), user_id: user.id, csrf_token: randomToken(16), expires_at: this.clock.now() + AUTHZ_REQUEST_TTL_MS }).execute();
    return { kind: 'consent', location: `/oauth/consent?request=${id}`, requestId: id, cookieValue: this.consentCookieValue(id, user.id) };
  }

  private async request(requestId: string, viewer: ConsoleSessionUser) {
    const r = await this.db.selectFrom('oauth_authz_requests').selectAll().where('id', '=', requestId).executeTakeFirst();
    if (!r) throw new OAuthError('invalid_request', 'Unknown authorization request; start again from your MCP client', 404);
    if (r.user_id !== viewer.id) throw new OAuthError('access_denied', 'This authorization request belongs to another user', 403);
    if (Number(r.expires_at) <= this.clock.now()) throw new OAuthError('invalid_request', 'This authorization request has expired; start again from your MCP client', 410);
    const client = await this.clients.byRowId(r.client_id);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 404);
    return { r, client, params: parseJsonColumn<AuthzParams>(r.params)! };
  }

  async view(requestId: string, viewer: ConsoleSessionUser): Promise<ConsentView> {
    const { client, params } = await this.request(requestId, viewer);
    const target = await resolveResource(this.db, this.base(), params.resource);
    if (!target) throw new OAuthError('invalid_target', 'The environment is no longer available', 410);
    const cimd = client.registration_type === 'cimd';
    const redirectUris = parseJsonColumn<string[]>(client.redirect_uris) ?? [];
    const notes: Partial<Record<McpOAuthScope, string>> = { 'mcp:write': 'writes are off in this environment', 'mcp:code': 'code mode is off in this environment' };
    return {
      requestId,
      csrfToken: viewer.csrfToken,
      client: { name: client.client_name, id: client.client_id, idHost: cimd ? new URL(client.client_id).host : null, verified: cimd, clientUri: client.client_uri, localhostOnly: redirectUris.length > 0 && redirectUris.every(isLoopbackRedirect), redirectHost: hostOf(params.redirect_uri) },
      server: { slug: target.server.slug, name: target.server.name },
      environment: { slug: target.environment.slug, name: target.environment.name, kind: target.environment.kind },
      scopes: (['mcp:tools', 'mcp:write', 'mcp:code'] as McpOAuthScope[]).map((name) => {
        const can = params.grantable.includes(name);
        return {
          name,
          description: SCOPE_DESCRIPTIONS[name],
          // mcp:tools always; mcp:write unchecked by default even when requested; mcp:code checked when requested
          checked: name === 'mcp:tools' || (can && name === 'mcp:code' && params.requested.includes(name)),
          disabled: name === 'mcp:tools' || !can,
          ...(can ? {} : { note: notes[name] }),
        };
      }),
      user: { email: viewer.email },
    };
  }

  async decide(requestId: string, body: { decision: 'approve' | 'deny'; scopes?: string[]; csrf?: string }, viewer: ConsoleSessionUser, consentCookie: string | undefined, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ redirectTo: string }> {
    const { client, params, r } = await this.request(requestId, viewer);
    if (!body.csrf || !timingSafeEqualStr(body.csrf, viewer.csrfToken)) throw new OAuthError('access_denied', 'The consent form is missing its CSRF token; restart from your MCP client', 403);
    if (!this.cookieMatches(consentCookie, requestId, viewer.id)) throw new OAuthError('access_denied', 'The consent cookie is missing or does not match this request; restart the authorization from your MCP client', 403);
    const del = await this.db.deleteFrom('oauth_authz_requests').where('id', '=', requestId).where('tenant_id', '=', r.tenant_id).executeTakeFirst();
    if (!Number(del.numDeletedRows)) throw new OAuthError('invalid_request', 'This authorization request was already decided', 409);
    const base = { state: params.state, iss: this.o.issuer };
    if (body.decision !== 'approve') {
      this.audit.auth({ tenantId: r.tenant_id, userId: viewer.id, action: 'oauth.consent.deny', decision: 'denied_acl', status: 'blocked', reason: `client ${client.client_id} → ${params.resource}`, ...meta });
      return { redirectTo: withParams(params.redirect_uri, { error: 'access_denied', error_description: 'The user denied the request', ...base }) };
    }
    if (!(await this.o.isMember(r.tenant_id, viewer.id))) throw new OAuthError('access_denied', 'You are not a member of the organization that owns this resource', 403);
    if (await isClientBlocked(this.db, r.tenant_id, client.id)) throw new OAuthError('access_denied', 'This client has been blocked by an administrator', 403);
    // granted = mcp:tools ∪ (checked ∩ grantable); never wider than what this environment allows
    const scopes = [...new Set(['mcp:tools', ...(body.scopes ?? []).filter((s): s is McpOAuthScope => params.grantable.includes(s as McpOAuthScope))])];
    const now = this.clock.now();
    await this.db
      .insertInto('oauth_consents')
      .values({ id: newId(), tenant_id: r.tenant_id, user_id: viewer.id, client_id: client.id, environment_id: params.environment_id, scopes: scopes.join(' '), redirect_uri: params.redirect_uri, created_at: now, revoked_at: null })
      .onConflict((oc) => oc.columns(['user_id', 'client_id', 'environment_id']).doUpdateSet({ scopes: scopes.join(' '), redirect_uri: params.redirect_uri, created_at: now, revoked_at: null }))
      .execute();
    const code = await this.tokens.issueCode({ tenantId: r.tenant_id, clientRowId: client.id, userId: viewer.id, serverId: params.server_id, environmentId: params.environment_id, redirectUri: params.redirect_uri, codeChallenge: params.code_challenge, scopes, resource: params.resource });
    this.audit.auth({ tenantId: r.tenant_id, userId: viewer.id, action: 'oauth.consent.approve', reason: `client ${client.client_id} → ${params.resource} (${scopes.join(' ')})`, ...meta });
    return { redirectTo: withParams(params.redirect_uri, { code, ...base }) };
  }
}

function hostOf(uri: string): string {
  try {
    const u = new URL(uri);
    return u.host || u.protocol;
  } catch {
    return uri;
  }
}
