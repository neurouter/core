import type { Capability } from '@neurouter/shared';
import type { Me } from '@/contract';

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

/** True when the whole console is read-only for this user (Viewer role or the demo). */
export function isViewer(me: Me): boolean {
  return me.user.role === 'viewer' || me.instance.demoReadOnly;
}

/** Tooltip text for a disabled mutation control (frontend §9 "Read-only"). */
export function readOnlyReason(me: Me): string {
  if (me.instance.demoReadOnly) return 'Read-only demo';
  if (me.user.role === 'viewer') return 'Viewer role: ask an admin';
  return 'You do not have permission';
}

/** Same-origin relative path only (no protocol-relative `//host`, no backslashes). */
export function isSafeReturnTo(v: unknown): v is string {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\') && !/[\r\n]/.test(v);
}
