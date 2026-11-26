import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../test/fakes/app-context.js';
import { LoginService, roleFromClaims } from './login.js';
import type { OidcProvider } from './oidc.js';

function fakeProvider(claims: Record<string, unknown>): OidcProvider & { lastState: string } {
  const p = {
    issuer: 'https://idp.test',
    lastState: '',
    async authorizationUrl(x: { state: string }) {
      p.lastState = x.state;
      return `https://idp.test/authorize?state=${x.state}`;
    },
    async callback() {
      return { claims, idToken: 'id-token' };
    },
    async endSessionUrl() {
      return null;
    },
  };
  return p;
}

describe('OIDC login (single provider)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ BOOTSTRAP_ADMIN_EMAIL: 'boss@acme.dev' });
  }, 60_000);
  afterAll(async () => t?.close());

  const svc = (claims: Record<string, unknown>, domains: string[] = []) => {
    const s = t.s.services;
    const provider = fakeProvider(claims);
    return { provider, login: new LoginService(s.dbs.main.db, s.clock, s.envelope, s.users, s.audit, { redirectUri: 'http://console.test/api/auth/oidc/callback', scopes: 'openid email', groupsClaim: 'groups', adminGroups: ['platform-admins'], defaultRole: 'viewer', allowedEmailDomains: domains }, provider) };
  };

  it('maps roles from groups; default viewer; bootstrap email is admin', async () => {
    expect(roleFromClaims({ groups: ['platform-admins'] }, { groupsClaim: 'groups', adminGroups: ['platform-admins'], defaultRole: 'viewer' })).toBe('admin');
    for (const [email, groups, role] of [['ann@acme.dev', ['platform-admins'], 'admin'], ['bob@acme.dev', [], 'viewer'], ['boss@acme.dev', [], 'admin']] as const) {
      const { provider, login } = svc({ sub: email, email, groups });
      await login.start('/servers');
      const out = await login.finish(new URL(`http://console.test/api/auth/oidc/callback?code=x&state=${provider.lastState}`));
      expect(out.ok).toBe(true);
      const u = await t.s.services.users.get((out as { userId: string }).userId);
      expect(u.role).toBe(role);
      if (out.ok) expect(out.returnTo).toBe('/servers');
    }
  });

  it('enforces allowed domains and single-use state', async () => {
    const { provider, login } = svc({ sub: 'x', email: 'eve@evil.dev' }, ['acme.dev']);
    await login.start(undefined);
    const url = new URL(`http://console.test/api/auth/oidc/callback?code=x&state=${provider.lastState}`);
    expect(await login.finish(url)).toMatchObject({ ok: false, error: 'domain_not_allowed' });
    expect(await login.finish(url)).toMatchObject({ ok: false, reason: 'unknown_state' });
  });
});
