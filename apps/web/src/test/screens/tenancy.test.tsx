import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { createDb } from '@/mocks/db';
import { meFixture } from '@/mocks/fixtures';
import { createTenancy } from '@/mocks/tenancy';
import { INVITE_TOKEN_KEY } from '@/features/members/invite-token';
import { getTenantSlug } from '@/lib/tenant';
import { renderRoute } from '@/test/render';

/** A mock db signed in as `userId` (the persona's role drives `me` and the member endpoints alike). */
function dbAs(userId: string | null, preset: 'single' | 'multi' = 'single') {
  const db = createDb({ speed: 0 });
  db.tenancy = createTenancy(preset);
  db.tenancy.sessionUserId = userId;
  return db;
}

/** A pending invite for `email` in Acme, returned as its token. */
function invite(db: ReturnType<typeof createDb>, email: string, role: 'admin' | 'viewer' = 'viewer') {
  const token = `test-invite-token-${email.replace(/\W/g, '')}`;
  db.tenancy.invites.push({ id: `inv_${token}`, tenantId: 'ten_acme', email, role, token, invitedBy: null, createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86_400_000).toISOString(), acceptedAt: null, revokedAt: null });
  return token;
}

describe('members page', () => {
  it('owner: members with role controls, pending invites first, invite link shown once', async () => {
    const { user } = await renderRoute('/settings/members', { db: dbAs('usr_maya') });
    const members = await screen.findByRole('table', { name: 'Members' });
    expect(await within(members).findByText('jon.okafor@acme.test')).toBeInTheDocument();
    expect(within(members).getByRole('combobox', { name: 'Role of Jon Okafor' })).toHaveValue('admin');
    expect(within(members).getByRole('button', { name: 'Remove Priya Raman' })).toBeInTheDocument();
    const invites = await screen.findByRole('table', { name: 'Invites' });
    const rows = await within(invites).findAllByRole('row');
    expect(within(rows[1]!).getByText('Pending')).toBeInTheDocument();
    expect(within(rows[2]!).getByText('Expired')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /invite member/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Invite a member' });
    await user.type(within(dialog).getByLabelText('Email'), 'sam.new@acme.test');
    await user.click(within(dialog).getByRole('radio', { name: /admin/i }));
    await user.click(within(dialog).getByRole('button', { name: 'Create invite link' }));
    const done = await screen.findByRole('dialog', { name: /invite link for sam.new@acme.test/i });
    expect(within(done).getByLabelText('Invite link').textContent).toMatch(/\/invite#t=\w{32,}/);
    expect(within(done).getByRole('button', { name: /copy link/i })).toBeInTheDocument();
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    expect(await within(invites).findByText('sam.new@acme.test')).toBeInTheDocument();
  });

  it('changing the last owner answers 409 and the role stays', async () => {
    const { user } = await renderRoute('/settings/members', { db: dbAs('usr_maya') });
    const select = await screen.findByRole('combobox', { name: 'Role of Maya Lindqvist' });
    await user.selectOptions(select, 'viewer');
    expect(await screen.findByText(/needs at least one active owner/)).toBeInTheDocument();
    await waitFor(() => expect(select).toHaveValue('owner'));
  });

  it('admin: can invite but not change roles or remove members', async () => {
    await renderRoute('/settings/members', { db: dbAs('usr_jon') });
    await screen.findByText('priya.raman@acme.test');
    expect(screen.getByRole('button', { name: /invite member/i })).toBeEnabled();
    expect(screen.queryByRole('combobox', { name: /Role of/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Invites' })).toBeInTheDocument();
  });

  it('viewer: read-only list, no invite button and no invites', async () => {
    await renderRoute('/settings/members', { db: dbAs('usr_priya') });
    await screen.findByText('maya.lindqvist@acme.test');
    expect(screen.queryByRole('button', { name: /invite member/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Invites' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: /Role of/ })).not.toBeInTheDocument();
  });

  it('is in the sidebar under Settings', async () => {
    await renderRoute('/settings/members', { db: dbAs('usr_priya') });
    const nav = await screen.findByRole('navigation', { name: 'Main navigation' });
    await waitFor(() => expect(within(nav).getByRole('link', { name: 'Members' })).toHaveAttribute('aria-current', 'page'));
  });
});

describe('invite accept page', () => {
  it('signed out: keeps the token for the tab and goes through the login page with returnTo=/invite', async () => {
    const db = dbAs(null);
    const token = invite(db, 'sam.new@acme.test');
    window.history.replaceState(null, '', `/invite#t=${token}`);
    const { router } = await renderRoute('/invite', { db });
    await waitFor(() => expect(router.state.location.pathname).toBe('/auth/login'));
    expect(router.state.location.search).toMatchObject({ returnTo: '/invite' });
    expect(window.sessionStorage.getItem(INVITE_TOKEN_KEY)).toBe(token);
    expect(window.location.hash).toBe('');
  });

  it('shows the preview and accepts: the new organization becomes the tab’s, then home', async () => {
    const db = dbAs('usr_newbie');
    db.tenancy.users.push({ id: 'usr_newbie', email: 'sam.new@acme.test', name: 'Sam New', lastLoginAt: null });
    window.sessionStorage.setItem(INVITE_TOKEN_KEY, invite(db, 'sam.new@acme.test', 'admin'));
    const { user, router } = await renderRoute('/invite', { db });
    expect(await screen.findByRole('heading', { name: 'Join Acme Corp' })).toBeInTheDocument();
    expect(screen.getByText("You're invited as admin.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Accept invite' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
    expect(getTenantSlug()).toBe('acme');
    expect(window.sessionStorage.getItem(INVITE_TOKEN_KEY)).toBeNull();
    expect(db.tenancy.memberships.some((m) => m.userId === 'usr_newbie' && m.role === 'admin')).toBe(true);
  });

  it('another account: says which email the invite was sent to and offers to switch', async () => {
    const db = dbAs('usr_other');
    db.tenancy.users.push({ id: 'usr_other', email: 'sam@personal.test', name: 'Sam', lastLoginAt: null });
    window.sessionStorage.setItem(INVITE_TOKEN_KEY, invite(db, 'sam.new@acme.test'));
    await renderRoute('/invite', { db });
    expect(await screen.findByText('This invite is for another email address')).toBeInTheDocument();
    expect(screen.getByText(/It was sent to/)).toHaveTextContent("It was sent to sam.new@acme.test, but you're signed in as sam@personal.test");
    expect(screen.getByRole('button', { name: 'Sign in with another account' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept invite' })).not.toBeInTheDocument();
  });

  it('already a member: says so and opens the organization', async () => {
    const db = dbAs('usr_priya');
    window.sessionStorage.setItem(INVITE_TOKEN_KEY, invite(db, 'priya.raman@acme.test'));
    const { user, router } = await renderRoute('/invite', { db });
    expect(await screen.findByText("You're already a member of Acme Corp.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open Acme Corp' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });

  it('an invalid, used or expired link', async () => {
    window.sessionStorage.setItem(INVITE_TOKEN_KEY, 'seed-expired-invite-token-0002');
    await renderRoute('/invite', { db: dbAs('usr_priya') });
    expect(await screen.findByRole('heading', { name: 'This invite is no longer valid' })).toBeInTheDocument();
  });

  it('no token at all', async () => {
    await renderRoute('/invite', { db: dbAs('usr_priya') });
    expect(await screen.findByRole('heading', { name: 'This invite link is incomplete' })).toBeInTheDocument();
  });
});

describe('organization switcher and no-organization state', () => {
  it('is hidden on a single-tenant (OSS) install: the instance name stays', async () => {
    await renderRoute('/servers', { db: dbAs('usr_maya') });
    await screen.findByRole('navigation', { name: 'Main navigation' });
    expect(screen.queryByRole('button', { name: /^Organization:/ })).not.toBeInTheDocument();
  });

  it('multi-tenant: lists the organizations and switching pins the new one to the tab', async () => {
    const db = dbAs('usr_maya', 'multi');
    const { user, router } = await renderRoute('/tasks', { db });
    await user.click(await screen.findByRole('button', { name: 'Organization: Acme Corp' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((i) => i.textContent)).toEqual([expect.stringContaining('Acme Corp'), expect.stringContaining('Bluefin Labs')]);
    await user.click(screen.getByRole('menuitem', { name: /Bluefin Labs/ }));
    expect(await screen.findByRole('button', { name: 'Organization: Bluefin Labs' })).toBeInTheDocument();
    expect(getTenantSlug()).toBe('bluefin');
    expect(router.state.location.pathname).toBe('/');
    expect(db.tenancy.activeTenantId).toBe('ten_bluefin');
    // a viewer in Bluefin: the read-only pill follows the role in the active organization
    expect(await screen.findByText('Viewer · read-only')).toBeInTheDocument();
  });

  it('a user without a membership sees one empty state instead of broken pages', async () => {
    await renderRoute('/servers', { me: meFixture('viewer', { noTenant: true }) });
    expect(await screen.findByText('You are not a member of any organization')).toBeInTheDocument();
    expect(screen.getByText(/not a member of any organization on this server/)).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
  });
});
