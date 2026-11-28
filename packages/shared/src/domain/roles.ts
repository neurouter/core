import * as z from 'zod';

/**
 * Tenant roles (multi-tenancy spec §2.1): `owner` (everything + members + billing + tenant deletion;
 * at least one per tenant), `admin` (operates the gateway and invites members), `viewer` (read-only).
 * A role belongs to a membership `(tenant, user)`, not to the user.
 */
export const Role = z.enum(['owner', 'admin', 'viewer']);
export type Role = z.infer<typeof Role>;

/** Roles an invite can grant (owners are promoted by another owner, never invited). */
export const InviteRole = z.enum(['admin', 'viewer']);
export type InviteRole = z.infer<typeof InviteRole>;

/** Rank for "at least" comparisons (`roleAtLeast('admin', r)`). */
const RANK: Record<Role, number> = { viewer: 0, admin: 1, owner: 2 };
export function roleAtLeast(min: Role, role: Role | null | undefined): boolean {
  return role != null && RANK[role] >= RANK[min];
}
