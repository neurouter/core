import type { UpstreamAuthDescriptor } from '../../kernel/runtime-config.js';

/** Resolves a secret reference (`env:NAME` | `secret:NAME`) at call time; null when missing. */
export type SecretResolver = (ref: string, scope: { environmentId: string }) => Promise<string | null>;

/** Returns the end user's delegated upstream token for an `oauth_passthrough` environment (broker mode). */
export type UpstreamTokenSource = (environmentId: string, userId: string) => Promise<string | null>;

export type CredentialOutcome =
  | { ok: true; headers: Record<string, string>; query: Record<string, string>; required: boolean }
  | { ok: false; code: 'credential_missing'; ref: string }
  | { ok: false; code: 'upstream_auth_required'; connectUrl: string };

export interface CredentialContext {
  environmentId: string;
  userId: string | null;
  /** Inbound external-AS bearer and its audiences (forwardInboundToken, §13.4). */
  inbound?: { bearer: string; audiences: string[] } | null;
  publicUrl: string;
}

/** Client-credentials tokens cached per environment, in memory only, until expires_in − 60 s. */
export class ClientCredentialsCache {
  private readonly cache = new Map<string, { token: string; exp: number }>();
  constructor(private readonly fetchToken: (d: UpstreamAuthDescriptor, clientSecret: string) => Promise<{ access_token: string; expires_in?: number }>) {}

  async get(envId: string, d: UpstreamAuthDescriptor, clientSecret: string, now: number): Promise<string> {
    const hit = this.cache.get(envId);
    if (hit && hit.exp > now) return hit.token;
    const t = await this.fetchToken(d, clientSecret);
    this.cache.set(envId, { token: t.access_token, exp: now + Math.max(0, (t.expires_in ?? 3600) - 60) * 1000 });
    return t.access_token;
  }

  clear(envId?: string): void {
    if (envId) this.cache.delete(envId);
    else this.cache.clear();
  }
}

/**
 * Upstream credential injection per environment (§13.5). Secrets never leave this module except as
 * request headers/query to the upstream; they are not logged, audited or returned.
 */
export class CredentialResolver {
  constructor(
    private readonly secrets: SecretResolver,
    private readonly opts: { upstreamTokens?: UpstreamTokenSource; clientCredentials?: ClientCredentialsCache; now?: () => number } = {},
  ) {}

  async resolve(auth: UpstreamAuthDescriptor, ctx: CredentialContext): Promise<CredentialOutcome> {
    const sec = async (ref: string | undefined): Promise<string | null> => (ref ? this.secrets(ref, { environmentId: ctx.environmentId }) : null);
    const missing = (ref: string | undefined): CredentialOutcome => ({ ok: false, code: 'credential_missing', ref: ref ?? '(none)' });
    switch (auth.type) {
      case 'none':
        return { ok: true, headers: {}, query: {}, required: false };
      case 'bearer': {
        const v = await sec(auth.secret);
        return v ? { ok: true, headers: { authorization: `Bearer ${v}` }, query: {}, required: true } : missing(auth.secret);
      }
      case 'header': {
        const v = await sec(auth.header?.secret ?? auth.secret);
        const name = auth.header?.name ?? 'x-api-key';
        return v ? { ok: true, headers: { [name.toLowerCase()]: v }, query: {}, required: true } : missing(auth.header?.secret ?? auth.secret);
      }
      case 'query': {
        const v = await sec(auth.query?.secret ?? auth.secret);
        const name = auth.query?.name ?? 'api_key';
        return v ? { ok: true, headers: {}, query: { [name]: v }, required: true } : missing(auth.query?.secret ?? auth.secret);
      }
      case 'basic': {
        const v = await sec(auth.secret);
        if (!v) return missing(auth.secret);
        return { ok: true, headers: { authorization: `Basic ${Buffer.from(`${auth.username ?? ''}:${v}`).toString('base64')}` }, query: {}, required: true };
      }
      case 'oauth_client_credentials': {
        const cs = await sec(auth.clientSecret);
        if (!cs || !this.opts.clientCredentials) return missing(auth.clientSecret);
        const token = await this.opts.clientCredentials.get(ctx.environmentId, auth, cs, (this.opts.now ?? Date.now)());
        return { ok: true, headers: { authorization: `Bearer ${token}` }, query: {}, required: true };
      }
      case 'oauth_passthrough': {
        // external-AS mode: forward the inbound token only when its audience includes the upstream (§13.4)
        if (auth.forwardInboundToken && ctx.inbound) {
          if (auth.upstreamAudience && ctx.inbound.audiences.includes(auth.upstreamAudience)) return { ok: true, headers: { authorization: `Bearer ${ctx.inbound.bearer}` }, query: {}, required: true };
          return { ok: false, code: 'upstream_auth_required', connectUrl: `${ctx.publicUrl}/oauth/upstream/${ctx.environmentId}/connect` };
        }
        const token = ctx.userId && this.opts.upstreamTokens ? await this.opts.upstreamTokens(ctx.environmentId, ctx.userId) : null;
        if (!token) return { ok: false, code: 'upstream_auth_required', connectUrl: `${ctx.publicUrl}/oauth/upstream/${ctx.environmentId}/connect` };
        return { ok: true, headers: { authorization: `Bearer ${token}` }, query: {}, required: true };
      }
    }
  }

  /** Credential presence for environment health / console (`ok | missing | not_required`). */
  async presence(auth: UpstreamAuthDescriptor, environmentId: string): Promise<'ok' | 'missing' | 'not_required'> {
    if (auth.type === 'none') return 'not_required';
    if (auth.type === 'oauth_passthrough') return 'ok';
    const ref = auth.type === 'header' ? (auth.header?.secret ?? auth.secret) : auth.type === 'query' ? (auth.query?.secret ?? auth.secret) : auth.type === 'oauth_client_credentials' ? auth.clientSecret : auth.secret;
    if (!ref) return 'missing';
    return (await this.secrets(ref, { environmentId })) ? 'ok' : 'missing';
  }
}
