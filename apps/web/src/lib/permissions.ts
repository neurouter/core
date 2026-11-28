import type { Capability, Role } from '@neurouter/shared';
import type { Me } from '@/contract';

/** Display names of the organization roles (multi-tenancy spec §2.1). */
export const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', admin: 'Admin', viewer: 'Viewer' };

/** UI permission check (hide/disable only; the API authorizes). */
export function can(me: Pick<Me, 'capabilities'>, cap: Capability): boolean {
  return me.capabilities.includes(cap);
}

export function canAny(me: Pick<Me, 'capabilities'>, caps: readonly Capability[]): boolean {
  return caps.some((c) => can(me, c));
}

/** The user can read `read` but not write `write` (Viewer, or the anonymous demo viewer). */
export function isReadOnly(me: Pick<Me, 'capabilities'>, read: Capability, write: Capability): boolean {
  return can(me, read) && !can(me, write);
}

/**
 * True when the whole console is read-only for this user: the demo, or a role in the active
 * organization that can read but not change servers (Viewer). Capability-based, so it follows
 * whatever the server grants per role.
 */
export function isViewer(me: Me): boolean {
  return me.instance.demoReadOnly || (can(me, 'servers:read') && !can(me, 'servers:write'));
}

/** Tooltip text for a disabled mutation control (frontend §9 "Read-only"). */
export function readOnlyReason(me: Me): string {
  if (me.instance.demoReadOnly) return 'Read-only demo';
  if (me.tenant === null) return 'You are not a member of this organization';
  if (me.user.role === 'viewer') return 'Viewer role: ask an admin';
  if (me.user.role === 'admin') return 'Only owners can do this';
  return 'You do not have permission';
}

/** Same-origin relative path only (no protocol-relative `//host`, no backslashes). */
export function isSafeReturnTo(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && !/[\r\n]/.test(v);
}
