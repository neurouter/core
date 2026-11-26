import { describe, expect, it } from 'vitest';
import { ClientCredentialsCache, CredentialResolver, type SecretResolver } from './credentials.js';

const secrets: SecretResolver = async (ref) => ({ 'env:TOKEN': 't0k', 'secret:KEY': 'k3y', 'env:CS': 'cs' })[ref] ?? null;
const ctx = { tenantId: 't1', environmentId: 'e1', userId: 'u1', publicUrl: 'https://nr.test' };

describe('upstream credentials per environment (§13.5)', () => {
  const r = new CredentialResolver(secrets, {
    upstreamTokens: async (_t, env, user) => (env === 'e1' && user === 'u1' ? 'delegated' : null),
    clientCredentials: new ClientCredentialsCache(async (_d, secret) => ({ access_token: `cc-${secret}`, expires_in: 3600 })),
  });

  it('none / bearer / header / query / basic', async () => {
    expect(await r.resolve({ type: 'none' }, ctx)).toEqual({ ok: true, headers: {}, query: {}, required: false });
    expect(await r.resolve({ type: 'bearer', secret: 'env:TOKEN' }, ctx)).toMatchObject({ ok: true, headers: { authorization: 'Bearer t0k' } });
    expect(await r.resolve({ type: 'header', header: { name: 'X-API-Key', secret: 'secret:KEY' } }, ctx)).toMatchObject({ ok: true, headers: { 'x-api-key': 'k3y' } });
    expect(await r.resolve({ type: 'query', query: { name: 'api_key', secret: 'secret:KEY' } }, ctx)).toMatchObject({ ok: true, query: { api_key: 'k3y' } });
    expect(await r.resolve({ type: 'basic', username: 'bot', secret: 'env:TOKEN' }, ctx)).toMatchObject({ ok: true, headers: { authorization: `Basic ${Buffer.from('bot:t0k').toString('base64')}` } });
  });

  it('client credentials (cached token) and missing refs → credential_missing', async () => {
    expect(await r.resolve({ type: 'oauth_client_credentials', tokenUrl: 'https://a/t', clientId: 'c', clientSecret: 'env:CS' }, ctx)).toMatchObject({ ok: true, headers: { authorization: 'Bearer cc-cs' } });
    expect(await r.resolve({ type: 'bearer', secret: 'env:MISSING' }, ctx)).toEqual({ ok: false, code: 'credential_missing', ref: 'env:MISSING' });
    expect(await r.resolve({ type: 'header', header: { name: 'x', secret: 'secret:NOPE' } }, ctx)).toMatchObject({ ok: false, code: 'credential_missing' });
  });

  it('oauth_passthrough: delegated token, or upstream_auth_required with the connect URL', async () => {
    expect(await r.resolve({ type: 'oauth_passthrough', authorizationUrl: 'https://a/au', tokenUrl: 'https://a/t', clientId: 'c' }, ctx)).toMatchObject({ ok: true, headers: { authorization: 'Bearer delegated' } });
    expect(await r.resolve({ type: 'oauth_passthrough' }, { ...ctx, userId: 'u2' })).toEqual({ ok: false, code: 'upstream_auth_required', connectUrl: 'https://nr.test/oauth/upstream/e1/connect' });
  });

  it('forwardInboundToken only when the inbound audience contains the upstream audience', async () => {
    const d = { type: 'oauth_passthrough' as const, forwardInboundToken: true, upstreamAudience: 'https://api.acme.test' };
    expect(await r.resolve(d, { ...ctx, inbound: { bearer: 'jwt', audiences: ['https://nr.test/mcp/a/b', 'https://api.acme.test'] } })).toMatchObject({ ok: true, headers: { authorization: 'Bearer jwt' } });
    expect(await r.resolve(d, { ...ctx, inbound: { bearer: 'jwt', audiences: ['https://nr.test/mcp/a/b'] } })).toMatchObject({ ok: false, code: 'upstream_auth_required' });
  });

  it('presence: ok / missing / not_required', async () => {
    expect(await r.presence({ type: 'none' }, 'e1', 't1')).toBe('not_required');
    expect(await r.presence({ type: 'bearer', secret: 'env:TOKEN' }, 'e1', 't1')).toBe('ok');
    expect(await r.presence({ type: 'bearer', secret: 'env:NOPE' }, 'e1', 't1')).toBe('missing');
  });
});
