import { describe, expect, it } from 'vitest';
import { server } from '@/test/msw-server';
import { createDb } from './db';
import { contractFixtures, tenancyGuard } from './fixtures';
import { createContractHandlers } from './handlers';
import { BLUEFIN_TENANT, createTenancy } from './tenancy';

function setup(preset: 'single' | 'multi' = 'single') {
  const db = createDb({ speed: 0 });
  db.tenancy = createTenancy(preset);
  server.use(...createContractHandlers(contractFixtures(db), { guard: tenancyGuard(db) }));
  return db;
}
const json = (method: string, body?: unknown, headers: Record<string, string> = {}) => ({ method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });

describe('mock tenancy', () => {
  it('me reflects the signed-in user, role and organization', async () => {
    setup();
    const me = await (await fetch('/api/me')).json();
    expect(me).toMatchObject({ user: { email: 'maya.lindqvist@acme.test', role: 'owner' }, tenant: { slug: 'acme', role: 'owner' }, tenancy: { multi: false } });
    expect(me.capabilities).toContain('members:manage');
  });

  it('the tenant header picks the organization; an unknown one falls back to the active one', async () => {
    setup('multi');
    const bluefin = await (await fetch('/api/me', { headers: { 'x-neurouter-tenant': BLUEFIN_TENANT.slug } })).json();
    expect(bluefin.tenant).toMatchObject({ slug: 'bluefin', role: 'viewer' });
    expect(bluefin.capabilities).not.toContain('servers:write');
    expect(bluefin.tenants).toHaveLength(2);
    const other = await (await fetch('/api/me', { headers: { 'x-neurouter-tenant': 'nope' } })).json();
    expect(other.tenant.slug).toBe('acme');
  });

  it('invite flow: create link, preview and accept as the invited email, then listed as a member', async () => {
    const db = setup();
    const created = await (await fetch('/api/members/invites', json('POST', { email: 'sam.new@acme.test', role: 'admin' }))).json();
    expect(created.url).toMatch(/\/invite#t=[a-f0-9]{32,}$/);
    const token = created.url.split('#t=')[1];
    // someone else signs in: the invite is for another email
    await fetch('/api/auth/link', json('POST', { token: 'as:someone.else@example.test' }));
    expect(await (await fetch('/api/invites/preview', json('POST', { token }))).json()).toMatchObject({ emailMatches: false, alreadyMember: false, role: 'admin' });
    const mismatch = await fetch('/api/invites/accept', json('POST', { token }));
    expect(mismatch.status).toBe(403);
    expect(await mismatch.json()).toMatchObject({ reason: 'invite_email_mismatch' });
    // the invited user: no organization yet, so tenant-scoped endpoints answer 403 no_tenant
    await fetch('/api/auth/link', json('POST', { token: 'as:sam.new@acme.test' }));
    const me = await (await fetch('/api/me')).json();
    expect(me).toMatchObject({ tenant: null, tenants: [], capabilities: [] });
    expect(await (await fetch('/api/servers')).json()).toMatchObject({ status: 403, reason: 'no_tenant' });
    const accepted = await (await fetch('/api/invites/accept', json('POST', { token }))).json();
    expect(accepted.tenant).toMatchObject({ slug: 'acme', role: 'admin' });
    // single use
    expect((await fetch('/api/invites/preview', json('POST', { token }))).status).toBe(404);
    const members = await (await fetch('/api/members')).json();
    expect(members.items.map((m: { email: string }) => m.email)).toContain('sam.new@acme.test');
    expect(db.tenancy.invites.find((i) => i.email === 'sam.new@acme.test')?.acceptedAt).toBeTruthy();
  });

  it('enforces role capabilities and keeps an active owner', async () => {
    setup();
    expect((await fetch('/api/members/usr_maya', json('PATCH', { role: 'admin' }))).status).toBe(409);
    expect((await fetch('/api/members/usr_maya', json('DELETE'))).status).toBe(409);
    expect((await fetch('/api/members/usr_jon', json('PATCH', { role: 'owner' }))).status).toBe(200);
    expect((await fetch('/api/members/usr_maya', json('PATCH', { role: 'admin' }))).status).toBe(200);
    await fetch('/api/auth/link', json('POST', { token: 'as:priya.raman@acme.test' }));
    expect((await fetch('/api/members')).status).toBe(200);
    expect((await fetch('/api/members/invites')).status).toBe(403);
    expect((await fetch('/api/members/invites', json('POST', { email: 'x@y.test', role: 'viewer' }))).status).toBe(403);
  });

  it('lists invites pending first and revokes them', async () => {
    setup();
    const list = await (await fetch('/api/members/invites')).json();
    expect(list.items.map((i: { status: string }) => i.status)).toEqual(['pending', 'expired']);
    expect((await fetch(`/api/members/invites/${list.items[0].id}`, json('DELETE'))).status).toBe(204);
    const after = await (await fetch('/api/members/invites')).json();
    expect(after.items.map((i: { status: string }) => i.status)).toEqual(['revoked', 'expired']);
  });

  it('sign-out ends the session (401) and switch remembers the active organization', async () => {
    setup('multi');
    expect((await (await fetch('/api/tenants/switch', json('POST', { slug: 'bluefin' }))).json()).tenant.slug).toBe('bluefin');
    expect((await (await fetch('/api/me')).json()).tenant.slug).toBe('bluefin');
    expect((await fetch('/api/tenants/switch', json('POST', { slug: 'nope' }))).status).toBe(404);
    await fetch('/api/auth/logout', json('POST'));
    expect((await fetch('/api/me')).status).toBe(401);
  });
});
