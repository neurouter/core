import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { ExternalJwtVerifier } from './external-jwt.js';

type Key = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

const ISS = 'https://auth.acme.test';
const RES = 'https://nr.test/mcp/api/prod';

describe('external AS passthrough (§13.4)', () => {
  let priv: Key;
  let other: Key;
  let verifier: ExternalJwtVerifier;

  beforeAll(async () => {
    const kp = await generateKeyPair('RS256');
    priv = kp.privateKey;
    other = (await generateKeyPair('RS256')).privateKey;
    const jwk: JWK = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256' };
    verifier = new ExternalJwtVerifier({ issuer: ISS, audience: 'auto', requiredScopes: ['mcp:tools'] }, { keySource: createLocalJWKSet({ keys: [jwk] }) });
  });

  const sign = (claims: Record<string, unknown>, opts: { key?: Key; exp?: string | number; iss?: string; aud?: string | string[] } = {}) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? ISS)
      .setAudience(opts.aud ?? RES)
      .setSubject('user-42')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(opts.key ?? priv);

  it('accepts a valid token and maps scopes; credential key is ext:iss|sub', async () => {
    const out = await verifier.verify(await sign({ scope: 'mcp:tools mcp:write' }), RES);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.credentialKey).toBe(`ext:${ISS}|user-42`);
    expect(out.principal).toMatchObject({ type: 'external', subject: 'user-42', issuer: ISS });
    expect(out.principal.scopes.sort()).toEqual(['tools:read', 'tools:write']);
  });

  it('rejects wrong audience (token for another endpoint), wrong issuer, expired, foreign signature', async () => {
    expect((await verifier.verify(await sign({ scope: 'mcp:tools' }, { aud: 'https://nr.test/mcp/api/dev' }), RES)).ok).toBe(false);
    expect((await verifier.verify(await sign({ scope: 'mcp:tools' }, { iss: 'https://evil.test' }), RES)).ok).toBe(false);
    expect((await verifier.verify(await sign({ scope: 'mcp:tools' }, { exp: Math.floor(Date.now() / 1000) - 3600 }), RES)).ok).toBe(false);
    expect((await verifier.verify(await sign({ scope: 'mcp:tools' }, { key: other }), RES)).ok).toBe(false);
  });

  it('rejects alg none and missing required scopes', async () => {
    const b = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b({ alg: 'none', typ: 'JWT' })}.${b({ iss: ISS, aud: RES, sub: 'x', exp: Math.floor(Date.now() / 1000) + 300, scope: 'mcp:tools' })}.`;
    expect((await verifier.verify(none, RES)).ok).toBe(false);
    const out = await verifier.verify(await sign({ scope: 'mcp:write' }), RES);
    expect(out).toMatchObject({ ok: false, error: 'insufficient_scope' });
  });
});
