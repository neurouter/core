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
]);
export type Capability = z.infer<typeof Capability>;

/** Endpoint access: a capability, `public` (no session) or `user` (any signed-in user). */
export type Access = Capability | 'public' | 'user';

const ALL = Capability.options;
const VIEWER = ALL.filter((c) => c.endsWith(':read'));

export const ROLE_CAPABILITIES: Record<Role, readonly Capability[]> = { admin: ALL, viewer: VIEWER };

export function capabilitiesFor(role: Role): Capability[] {
  return [...ROLE_CAPABILITIES[role]];
}

export function hasCapability(role: Role, cap: Capability): boolean {
  return ROLE_CAPABILITIES[role].includes(cap);
}
