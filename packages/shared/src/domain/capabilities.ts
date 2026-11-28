import * as z from 'zod';
import type { Role } from './roles.js';

/** Console capabilities (frontend §4, backend §14.1). Server-side checks are authoritative. */
export const Capability = z.enum([
  'servers:read',
  'servers:write',
  'tools:read',
  'overlays:write',
  'environments:read',
  'environments:write',
  'writes:enable',
  'tasks:read',
  'inbox:read',
  'inbox:triage',
  'evals:read',
  'evals:run',
  'audit:read',
  'keys:read',
  'keys:manage',
  'settings:read',
  'settings:write',
  // members and billing (multi-tenancy spec §2.2)
  'members:read',
  'members:invite',
  'members:manage',
  'billing:read',
  'billing:manage',
  'tenant:delete',
]);
export type Capability = z.infer<typeof Capability>;

/** Endpoint access: a capability, `public` (no session) or `user` (any signed-in user). */
export type Access = Capability | 'public' | 'user';

/** Capabilities beyond the gateway itself: members, billing and the tenant's lifecycle. */
const ORG: readonly Capability[] = ['members:read', 'members:invite', 'members:manage', 'billing:read', 'billing:manage', 'tenant:delete'];
const GATEWAY = Capability.options.filter((c) => !ORG.includes(c));

/**
 * Spec §2.2: viewer = the gateway `:read` set + `members:read`; admin = every gateway capability +
 * `members:read`, `members:invite`, `billing:read`; owner = admin + `members:manage`,
 * `billing:manage`, `tenant:delete`.
 */
const VIEWER: readonly Capability[] = [...GATEWAY.filter((c) => c.endsWith(':read')), 'members:read'];
const ADMIN: readonly Capability[] = [...GATEWAY, 'members:read', 'members:invite', 'billing:read'];
const OWNER: readonly Capability[] = [...ADMIN, 'members:manage', 'billing:manage', 'tenant:delete'];

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = { owner: OWNER, admin: ADMIN, viewer: VIEWER };

export function capabilitiesFor(role: Role): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasCapability(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}
