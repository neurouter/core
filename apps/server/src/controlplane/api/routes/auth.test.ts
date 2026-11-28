import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintConsoleLink } from '../../../console.js';
import { createTestContext, importPetstore, type TestContext } from '../../../test/fakes/app-context.js';

describe('console auth: local link, me, logout', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  }, 60_000);
  afterAll(async () => t?.close());

  it('auth.config is public', async () => {
    const r = await t.json(null, { url: '/api/auth/config' }, 200);
    expect(r).toMatchObject({ localLink: true, demoReadOnly: false, oidc: { enabled: false } });
    expect((await t.as(null, { url: '/api/auth/oidc/start' })).statusCode).toBe(404);
  });

  it('a minted link signs in once (Me + cookie), then is single-use', async () => {
    const url = await mintConsoleLink(t.s.services);
    expect(url).toMatch(/^http:\/\/console\.test\/auth\/link#t=/);
    const token = url.split('#t=')[1]!;
    const r = await t.as(null, { method: 'POST', url: '/api/auth/link', payload: { token } });
    expect(r.statusCode).toBe(200);
    const me = JSON.parse(r.body);
    // the bootstrap admin owns the install's organization (multi-tenancy spec §2.2)
    expect(me.user).toMatchObject({ email: 'admin@localhost', role: 'owner', anonymous: false });
    expect(me.capabilities).toEqual(expect.arrayContaining(['settings:write', 'members:manage', 'tenant:delete']));
    expect(me.tenant).toMatchObject({ slug: 'default', role: 'owner', kind: 'org', status: 'active' });
    expect(me.tenants).toHaveLength(1);
    expect(me.tenancy).toEqual({ multi: false });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const me2 = await t.s.app.inject({ url: '/api/me', headers: { cookie } });
    expect(JSON.parse(me2.body).user.email).toBe('admin@localhost');
    expect((await t.as(null, { method: 'POST', url: '/api/auth/link', payload: { token } })).statusCode).toBe(401);
    const out = await t.s.app.inject({ method: 'POST', url: '/api/auth/logout', headers: { cookie, 'x-csrf-token': me.csrfToken } });
    expect(JSON.parse(out.body)).toEqual({ endSessionUrl: null });
    expect((await t.s.app.inject({ url: '/api/me', headers: { cookie } })).statusCode).toBe(401);
  });

  it('me.get without a session is 401 outside demo mode; badges', async () => {
    expect((await t.as(null, { url: '/api/me' })).statusCode).toBe(401);
    expect(await t.json(t.admin, { url: '/api/me/badges' }, 200)).toEqual({ inboxOpen: 0, evalsRunning: 0 });
  });
});

describe('demo mode (NEUROUTER_DEMO_READ_ONLY)', () => {
  let t: TestContext;
  let serverId: string;
  beforeAll(async () => {
    t = await createTestContext({ NEUROUTER_DEMO_READ_ONLY: 'true' });
    serverId = (await importPetstore(t)).id;
  }, 60_000);
  afterAll(async () => t?.close());

  it('anonymous GET /api/me creates a viewer session; mutations → 403 demo_read_only; allow-listed ones pass; secrets masked', async () => {
    const r = await t.as(null, { url: '/api/me' });
    const me = JSON.parse(r.body);
    expect(me.user).toMatchObject({ anonymous: true, role: 'viewer' });
    const cookie = String(r.headers['set-cookie']).split(';')[0]!;
    const h = { cookie, 'x-csrf-token': me.csrfToken };
    expect((await t.s.app.inject({ url: '/api/servers', headers: h })).statusCode).toBe(200);
    const m = await t.s.app.inject({ method: 'PATCH', url: `/api/servers/${serverId}`, payload: { description: 'x' }, headers: h });
    expect(m.statusCode).toBe(403);
    expect(JSON.parse(m.body).reason).toBe('demo_read_only');
    const v = await t.s.app.inject({ method: 'POST', url: '/api/overlays/validate', payload: { serverId, yaml: 'overlay: 1\n' }, headers: h });
    expect(v.statusCode).toBe(200);
    const url = await t.s.app.inject({ method: 'POST', url: '/api/spec-previews', payload: { source: { url: 'https://example.com/spec.yaml' } }, headers: h });
    expect(url.statusCode).toBe(403);
    const gql = await t.s.app.inject({ method: 'POST', url: '/api/spec-previews', payload: { source: { graphqlEndpoint: 'https://example.com/graphql' } }, headers: h });
    expect(gql.statusCode).toBe(403);
    await t.json(t.admin, { method: 'POST', url: `/api/servers/${serverId}/environments`, payload: { slug: 'prod', kind: 'prod', baseUrl: 'https://api.example.com', auth: { type: 'bearer', secretRef: 'env:PET_TOKEN' } } }, 201);
    const envs = JSON.parse((await t.s.app.inject({ url: `/api/servers/${serverId}/environments`, headers: h })).body);
    const prod = envs.items.find((e: any) => e.slug === 'prod');
    expect(prod.auth.secretRef).toBe('env:••••');
  });

  it('signed-in admins keep full access in demo mode', async () => {
    expect((await t.as(t.admin, { method: 'PATCH', url: `/api/servers/${serverId}`, payload: { description: 'Demo' } })).statusCode).toBe(200);
  });
});
