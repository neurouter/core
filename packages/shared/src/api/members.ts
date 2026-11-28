import * as z from 'zod';
import { InviteRole, Role } from '../domain/roles.js';
import { UserStatus } from '../domain/enums.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Items, Page, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

/* ------------------------------------------------------------------ tenants (multi-tenancy spec §2, §3.3) */

/** Request header that picks the console tenant (per browser tab; spec §3.3). */
export const TENANT_HEADER = 'x-neurouter-tenant';
/** Deep-link query parameter that picks the console tenant (`?org=<slug>`; the SPA stores and strips it). */
export const TENANT_QUERY = 'org';

export const TenantKind = z.enum(['personal', 'org']);
export type TenantKind = z.infer<typeof TenantKind>;
export const TenantStatus = z.enum(['active', 'suspended', 'pending_deletion', 'deleted']);
export type TenantStatus = z.infer<typeof TenantStatus>;

/** A tenant ("organization") the signed-in user belongs to, with their role in it. */
export const TenantSummary = z.object({ id: Id, slug: z.string(), name: z.string(), kind: TenantKind, status: TenantStatus, role: Role });
export type TenantSummary = z.infer<typeof TenantSummary>;

/** Tenant slug rules (spec §2.3): 3–32 chars, `^[a-z][a-z0-9-]{1,30}[a-z0-9]$`, no `--`, not reserved. */
export const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}[a-z0-9]$/;
export const RESERVED_TENANT_SLUGS: readonly string[] = [
  'api', 'app', 'admin', 'auth', 'billing', 'cloud', 'console', 'default', 'docs', 'help', 'internal', 'login', 'logout', 'mcp', 'me', 'neurouter',
  'new', 'oauth', 'o', 'org', 'orgs', 'public', 'root', 'settings', 'signup', 'signin', 'static', 'status', 'support', 'system', 't', 'team', 'www',
  'well-known', 'metrics', 'healthz', 'readyz', 'invite',
];

/** Why a slug is not acceptable for a new tenant, or null when it is (uniqueness is checked by the server). */
export function tenantSlugIssue(slug: string): 'format' | 'double_dash' | 'reserved' | null {
  if (!TENANT_SLUG_RE.test(slug) || /^[0-9-]+$/.test(slug)) return 'format';
  if (slug.includes('--')) return 'double_dash';
  if (RESERVED_TENANT_SLUGS.includes(slug.toLowerCase())) return 'reserved';
  return null;
}

export const TenantSwitchBody = z.object({ slug: z.string().min(1).max(64) });
export type TenantSwitchBody = z.infer<typeof TenantSwitchBody>;
export const TenantSwitchResult = z.object({ tenant: TenantSummary });
export type TenantSwitchResult = z.infer<typeof TenantSwitchResult>;

export const tenantEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/tenants', kind: 'json', access: ['user'], tenant: false,
    summary: 'Organizations the signed-in user belongs to (with their role)', response: Items(TenantSummary),
  }),
  switch: endpoint({
    method: 'POST', path: '/api/tenants/switch', kind: 'json', access: ['user'], tenant: false,
    summary: 'Remember the active organization for this session (404 when not a member)', body: TenantSwitchBody, response: TenantSwitchResult,
  }),
} as const;

/* ------------------------------------------------------------------ members */

export const MemberRoleSource = z.enum(['local', 'oidc', 'bootstrap', 'invite']);
export type MemberRoleSource = z.infer<typeof MemberRoleSource>;

/** A member of the request's tenant (a user + their membership). */
export const MemberRow = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: Role,
  roleSource: MemberRoleSource,
  status: UserStatus,
  lastLoginAt: IsoDateTime.nullable(),
  /** When the user joined this organization. */
  createdAt: IsoDateTime,
});
export type MemberRow = z.infer<typeof MemberRow>;
export const MemberPatch = z.object({ role: Role.optional(), status: UserStatus.optional() });
export type MemberPatch = z.infer<typeof MemberPatch>;

export const InviteStatus = z.enum(['pending', 'accepted', 'revoked', 'expired']);
export type InviteStatus = z.infer<typeof InviteStatus>;

export const InviteRow = z.object({
  id: Id,
  email: z.string(),
  role: InviteRole,
  status: InviteStatus,
  invitedBy: z.object({ id: Id, email: z.string() }).nullable(),
  createdAt: IsoDateTime,
  expiresAt: IsoDateTime,
  acceptedAt: IsoDateTime.nullable(),
});
export type InviteRow = z.infer<typeof InviteRow>;

export const InviteCreate = z.object({ email: z.email().max(320), role: InviteRole });
export type InviteCreate = z.infer<typeof InviteCreate>;
/** The invite link carries the token in the fragment (`/invite#t=<token>`); it is shown once. */
export const InviteCreated = z.object({ invite: InviteRow, url: z.string() });
export type InviteCreated = z.infer<typeof InviteCreated>;

export const InviteTokenBody = z.object({ token: z.string().min(16).max(256) });
export type InviteTokenBody = z.infer<typeof InviteTokenBody>;
export const InvitePreview = z.object({
  tenant: z.object({ slug: z.string(), name: z.string() }),
  email: z.string(),
  role: InviteRole,
  expiresAt: IsoDateTime,
  /** The signed-in user has a verified email equal to the invite's (else accepting answers 403 `invite_email_mismatch`). */
  emailMatches: z.boolean(),
  /** The signed-in user already belongs to the organization. */
  alreadyMember: z.boolean(),
});
export type InvitePreview = z.infer<typeof InvitePreview>;
export const InviteAccepted = z.object({ tenant: TenantSummary });
export type InviteAccepted = z.infer<typeof InviteAccepted>;

/** Invite links are valid for 7 days and single use (spec §2.4). */
export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;

export const memberEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/members', kind: 'json', access: ['members:read'],
    summary: 'Members of the organization', query: CursorQuery.extend({ q: queryOptional(z.string().max(200)) }), response: Page(MemberRow),
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/members/:id', kind: 'json', access: ['members:manage'],
    summary: 'Change a member’s role or status (409 when it would leave no active owner)', params: IdParams, body: MemberPatch, response: MemberRow,
  }),
  remove: endpoint({
    method: 'DELETE', path: '/api/members/:id', kind: 'empty', access: ['members:manage'],
    summary: 'Remove a member from the organization (409 when it would leave no active owner)', params: IdParams,
  }),
  invites: endpoint({
    method: 'GET', path: '/api/members/invites', kind: 'json', access: ['members:invite'],
    summary: 'Invites of the organization (pending first)', response: Items(InviteRow),
  }),
  invite: endpoint({
    method: 'POST', path: '/api/members/invites', kind: 'json', status: 201, access: ['members:invite'],
    summary: 'Create an invite; the link is returned once (no email is sent)', body: InviteCreate, response: InviteCreated,
  }),
  revokeInvite: endpoint({
    method: 'DELETE', path: '/api/members/invites/:id', kind: 'empty', access: ['members:invite'],
    summary: 'Revoke a pending invite', params: IdParams,
  }),
} as const;

export const inviteEndpoints = {
  preview: endpoint({
    method: 'POST', path: '/api/invites/preview', kind: 'json', access: ['user'], tenant: false,
    summary: 'What an invite link grants (404 when invalid, used, revoked or expired)', body: InviteTokenBody, response: InvitePreview,
  }),
  accept: endpoint({
    method: 'POST', path: '/api/invites/accept', kind: 'json', access: ['user'], tenant: false,
    summary: 'Accept an invite (403 invite_email_mismatch unless a verified email matches)', body: InviteTokenBody, response: InviteAccepted,
  }),
} as const;
