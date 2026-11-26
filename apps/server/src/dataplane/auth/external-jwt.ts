import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { OAUTH_SCOPE_MAP, type OAuthScope, type Scope } from '@neurouter/shared';
import type { AuthOutcome } from './authenticate.js';

export interface ExternalAsConfig {
  issuer: string;
  jwksUri?: string;
  /** 'auto' = the MCP resource URI of the endpoint. */
  audience: string;
  requiredScopes: string[];
  /** external scope → Neurouter scope (default: mcp:tools / mcp:write / mcp:code). */
  scopeMap?: Record<string, Scope>;
}

const ALGS = ['RS256', 'ES256', 'EdDSA'];

/**
 * External AS passthrough (§13.4, NEW): verifies JWT access tokens from the API's own authorization
 * server (iss, aud, exp/nbf ± 60 s, alg allow-list RS256/ES256/EdDSA, required scopes). JWKS are
 * discovered from the issuer metadata (cached 10 min by jose) unless `jwksUri` is set. Opaque tokens
 * are not supported (A16).
 */
export class ExternalJwtVerifier {
  private jwks: JWTVerifyGetKey | null = null;

  constructor(
    readonly config: ExternalAsConfig,
    private readonly opts: { fetchJson?: (url: string) => Promise<unknown>; keySource?: JWTVerifyGetKey } = {},
  ) {
    if (opts.keySource) this.jwks = opts.keySource;
  }

  private async keys(): Promise<JWTVerifyGetKey> {
    if (this.jwks) return this.jwks;
    let uri = this.config.jwksUri;
    if (!uri) {
      const get = this.opts.fetchJson ?? (async (u: string) => (await fetch(u)).json());
      const base = this.config.issuer.replace(/\/$/, '');
      for (const path of ['/.well-known/oauth-authorization-server', '/.well-known/openid-configuration']) {
        try {
          const meta = (await get(`${base}${path}`)) as { jwks_uri?: string };
          if (meta?.jwks_uri) {
            uri = meta.jwks_uri;
            break;
          }
        } catch {
          // try the next well-known path
        }
      }
      if (!uri) throw new Error('external AS metadata has no jwks_uri');
    }
    this.jwks = createRemoteJWKSet(new URL(uri), { cacheMaxAge: 10 * 60_000 });
    return this.jwks;
  }

  async verify(token: string, resourceUri: string): Promise<AuthOutcome> {
    let payload: JWTPayload;
    try {
      const res = await jwtVerify(token, await this.keys(), {
        issuer: this.config.issuer,
        audience: this.config.audience === 'auto' ? resourceUri : this.config.audience,
        algorithms: ALGS,
        clockTolerance: 60,
      });
      payload = res.payload;
    } catch (err) {
      return { ok: false, error: 'invalid_token', reason: `external token rejected: ${(err as Error).message.slice(0, 120)}` };
    }
    const raw = typeof payload.scope === 'string' ? payload.scope.split(/\s+/).filter(Boolean) : Array.isArray(payload.scp) ? (payload.scp as string[]) : [];
    for (const s of this.config.requiredScopes) if (!raw.includes(s)) return { ok: false, error: 'insufficient_scope', reason: `missing scope ${s}` };
    const map: Record<string, Scope> = this.config.scopeMap ?? (OAUTH_SCOPE_MAP as Record<OAuthScope, Scope>);
    const scopes = [...new Set(raw.map((s) => map[s]).filter((s): s is Scope => Boolean(s)))];
    if (!scopes.includes('tools:read')) return { ok: false, error: 'insufficient_scope', reason: 'missing scope mcp:tools' };
    const sub = String(payload.sub ?? '');
    if (!sub) return { ok: false, error: 'invalid_token', reason: 'token has no sub' };
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    return {
      ok: true,
      credentialKey: `ext:${this.config.issuer}|${sub}`,
      principal: { type: 'external', subject: sub, issuer: this.config.issuer, scopes, bearer: token, name: sub, ...({ audiences: aud } as object) } as never,
    };
  }
}
