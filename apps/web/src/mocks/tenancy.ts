/**
 * Mock tenancy (multi-tenancy spec §2): organizations, users, memberships, invites and the mock
 * "session" (who is signed in). Plain data so it can be persisted.
 *
 * In the browser mock bundle (`VITE_ENABLE_MSW`) the state is saved to `localStorage`
 * (`neurouter-mock-tenancy`), so an invite created in one page load can be opened in the next
 * one, and sign-out / sign-in survive reloads, like a cookie. Mock-only identity switch: the
 * console-link sign-in accepts `as:<email>` as its token and signs in as that email (a new user
 * with no organization when the email is unknown). `localStorage['neurouter-mock-preset'] =
 * 'multi'` seeds a multi-tenant deployment (Maya also belongs to a second organization).
 */
import { TENANT_HEADER, capabilitiesFor, type InviteRole, type InviteRow, type MemberRoleSource, type MemberRow, type Role, type TenantSummary, type UserStatus } from '@neurouter/shared';
import { DAY, HOUR, INSTANCE, PEOPLE, iso } from './demo-data';

export interface MockTenant {
  id: string;
  slug: string;
  name: string;
  kind: 'personal' | 'org';
  status: 'active' | 'suspended' | 'pending_deletion' | 'deleted';
}
export interface MockUser {
  id: string;
  email: string;
  name: string;
  lastLoginAt: string | null;
}
export interface MockMembership {
  tenantId: string;
  userId: string;
  role: Role;
  roleSource: MemberRoleSource;
  status: UserStatus;
  createdAt: string;
}
export interface MockInvite {
  id: string;
  tenantId: string;
  email: string;
  role: InviteRole;
  token: string;
  invitedBy: { id: string; email: string } | null;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  revokedAt: string | null;
}
export interface TenancyState {
  /** `tenancy.multi` on `/api/me` (a cloud deployment). */
  multi: boolean;
  /** The signed-in user (null: signed out, every non-public endpoint answers 401). */
  sessionUserId: string | null;
  /** `web_sessions.active_tenant_id`: the fallback when a request carries no tenant header. */
  activeTenantId: string | null;
  tenants: MockTenant[];
  users: MockUser[];
  memberships: MockMembership[];
  invites: MockInvite[];
  seq: number;
}

export const MOCK_TENANCY_STORAGE_KEY = 'neurouter-mock-tenancy';
export const MOCK_PRESET_STORAGE_KEY = 'neurouter-mock-preset';
export type TenancyPreset = 'single' | 'multi';

export const ACME_TENANT: MockTenant = { id: 'ten_acme', slug: 'acme', name: INSTANCE.name, kind: 'org', status: 'active' };
export const BLUEFIN_TENANT: MockTenant = { id: 'ten_bluefin', slug: 'bluefin', name: 'Bluefin Labs', kind: 'org', status: 'active' };

const ago = (ms: number) => iso(Date.now() - ms);

export function createTenancy(preset: TenancyPreset = 'single'): TenancyState {
  const people = [
    { p: PEOPLE.maya, source: 'bootstrap' as const, login: 2 * HOUR, joined: 60 * DAY },
    { p: PEOPLE.jon, source: 'oidc' as const, login: 4 * HOUR, joined: 50 * DAY },
    { p: PEOPLE.priya, source: 'oidc' as const, login: 6 * HOUR, joined: 40 * DAY },
  ];
  const state: TenancyState = {
    multi: preset === 'multi',
    sessionUserId: PEOPLE.maya.id,
    activeTenantId: ACME_TENANT.id,
    tenants: [{ ...ACME_TENANT }],
    users: people.map(({ p, login }) => ({ id: p.id, email: p.email, name: p.name, lastLoginAt: ago(login) })),
    memberships: people.map(({ p, source, joined }) => ({ tenantId: ACME_TENANT.id, userId: p.id, role: p.role, roleSource: source, status: 'active', createdAt: ago(joined) })),
    invites: [
      { id: 'inv_seed_1', tenantId: ACME_TENANT.id, email: 'ana.silva@acme.test', role: 'viewer', token: 'seed-pending-invite-token-0001', invitedBy: { id: PEOPLE.maya.id, email: PEOPLE.maya.email }, createdAt: ago(DAY), expiresAt: ago(-6 * DAY), acceptedAt: null, revokedAt: null },
      { id: 'inv_seed_2', tenantId: ACME_TENANT.id, email: 'old.contractor@example.test', role: 'admin', token: 'seed-expired-invite-token-0002', invitedBy: { id: PEOPLE.jon.id, email: PEOPLE.jon.email }, createdAt: ago(12 * DAY), expiresAt: ago(5 * DAY), acceptedAt: null, revokedAt: null },
    ],
    seq: 0,
  };
  if (preset === 'multi') {
    state.tenants.push({ ...BLUEFIN_TENANT });
    state.memberships.push({ tenantId: BLUEFIN_TENANT.id, userId: PEOPLE.maya.id, role: 'viewer', roleSource: 'invite', status: 'active', createdAt: ago(10 * DAY) });
  }
  return state;
}

/* ------------------------------------------------------------------ persistence (browser mock bundle only) */

function storage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Loads the saved state, or a fresh one from the preset (`neurouter-mock-preset`). */
export function loadTenancy(): TenancyState {
  const s = storage();
  try {
    const raw = s?.getItem(MOCK_TENANCY_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as TenancyState;
  } catch {
    // corrupt or blocked: start over
  }
  return createTenancy(s?.getItem(MOCK_PRESET_STORAGE_KEY) === 'multi' ? 'multi' : 'single');
}

export function saveTenancy(state: TenancyState): void {
  try {
    storage()?.setItem(MOCK_TENANCY_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // ignore
  }
}

/* ------------------------------------------------------------------ queries */

export function summary(t: TenancyState, m: MockMembership): TenantSummary {
  const tenant = t.tenants.find((x) => x.id === m.tenantId)!;
  return { id: tenant.id, slug: tenant.slug, name: tenant.name, kind: tenant.kind, status: tenant.status, role: m.role };
}

export function sessionUser(t: TenancyState): MockUser | null {
  return t.users.find((u) => u.id === t.sessionUserId) ?? null;
}

export function activeMemberships(t: TenancyState, userId: string): MockMembership[] {
  return t.memberships.filter((m) => m.userId === userId && m.status === 'active');
}

/**
 * The request's organization (spec §3.3): the `X-Neurouter-Tenant` header when the user belongs
 * to it, else the session's active organization, else the user's first membership.
 */
export function resolveTenant(t: TenancyState, request: Request | null): { user: MockUser; membership: MockMembership | null } | null {
  const user = sessionUser(t);
  if (!user) return null;
  const mine = activeMemberships(t, user.id);
  const slug = request?.headers.get(TENANT_HEADER);
  const bySlug = slug ? mine.find((m) => t.tenants.find((x) => x.id === m.tenantId)?.slug === slug) : undefined;
  const membership = bySlug ?? mine.find((m) => m.tenantId === t.activeTenantId) ?? mine[0] ?? null;
  return { user, membership };
}

export function capabilitiesOf(m: MockMembership | null) {
  return m ? capabilitiesFor(m.role) : [];
}

export function memberRows(t: TenancyState, tenantId: string): MemberRow[] {
  return t.memberships
    .filter((m) => m.tenantId === tenantId)
    .map((m) => {
      const u = t.users.find((x) => x.id === m.userId)!;
      return { id: u.id, email: u.email, name: u.name, role: m.role, roleSource: m.roleSource, status: m.status, lastLoginAt: u.lastLoginAt, createdAt: m.createdAt };
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function inviteStatus(i: MockInvite, now = Date.now()): InviteRow['status'] {
  if (i.acceptedAt) return 'accepted';
  if (i.revokedAt) return 'revoked';
  if (Date.parse(i.expiresAt) <= now) return 'expired';
  return 'pending';
}

export function inviteRow(i: MockInvite): InviteRow {
  return { id: i.id, email: i.email, role: i.role, status: inviteStatus(i), invitedBy: i.invitedBy, createdAt: i.createdAt, expiresAt: i.expiresAt, acceptedAt: i.acceptedAt };
}

/** Would the tenant still have an active owner if `userId`'s membership became `next` (null: removed)? */
export function keepsAnOwner(t: TenancyState, tenantId: string, userId: string, next: Pick<MockMembership, 'role' | 'status'> | null): boolean {
  return t.memberships.some((m) => {
    if (m.tenantId !== tenantId) return false;
    const eff = m.userId === userId ? next : m;
    return !!eff && eff.role === 'owner' && eff.status === 'active';
  });
}

export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join(' ');
}
