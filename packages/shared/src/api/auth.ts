import * as z from 'zod';
import { Capability } from '../domain/capabilities.js';
import { ConfigMode } from '../domain/enums.js';
import { Role } from '../domain/roles.js';
import { Id } from './common.js';
import { TenantSummary } from './members.js';
import { endpoint } from './endpoint.js';

/* ------------------------------------------------------------------ auth (§14.2) */

export const AuthConfig = z.object({
  oidc: z.object({ enabled: z.boolean(), displayName: z.string() }),
  /** One-time console sign-in links (`npx neurouter console-link`) are enabled. */
  localLink: z.boolean(),
  demoReadOnly: z.boolean(),
  orgName: z.string(),
  /** Deployment feature flags from server extensions (multi-tenancy spec §1.4, e.g. `{ tenancy: { multi: true } }`); `{}` in OSS. */
  features: z.record(z.string(), z.unknown()).optional(),
});
export type AuthConfig = z.infer<typeof AuthConfig>;

export const OidcStartQuery = z.object({ returnTo: z.string().max(2048).optional() });
export type OidcStartQuery = z.infer<typeof OidcStartQuery>;

/** Error codes the backend puts on `/auth/login?error=`. `session_expired` is set by the SPA itself. */
export const LoginErrorCode = z.enum(['access_denied', 'no_account', 'disabled', 'domain_not_allowed', 'idp_error', 'link_invalid', 'session_expired']);
export type LoginErrorCode = z.infer<typeof LoginErrorCode>;

/** The token from the `PUBLIC_URL/auth/link#t=<token>` fragment. */
export const LinkLoginBody = z.object({ token: z.string().min(16).max(256) });
export type LinkLoginBody = z.infer<typeof LinkLoginBody>;

export const LogoutResult = z.object({ endSessionUrl: z.string().nullable() });
export type LogoutResult = z.infer<typeof LogoutResult>;

/**
 * True when `returnTo` is a same-origin, path-only target (`/x`, not `//x`, `/\x`, `https://…`, `javascript:`).
 * Used by both the backend (callback redirect) and the SPA (login page). COPY Hub.
 */
export function isSafeReturnTo(value: string | null | undefined): value is string {
  if (!value || typeof value !== 'string' || value.length > 2048) return false;
  if (!value.startsWith('/')) return false;
  if (value.startsWith('//') || value.startsWith('/\\')) return false;
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return false;
  }
  if (value.includes('\\')) return false;
  return true;
}

/* ------------------------------------------------------------------ me */

export const Features = z.object({
  codeMode: z.boolean(),
  embeddings: z.enum(['ready', 'loading', 'disabled', 'error']),
  /** A model provider key (OpenAI, Anthropic or Gemini; env or stored) is configured. */
  evals: z.boolean(),
  oauthBroker: z.boolean(),
  externalAs: z.boolean(),
  events: z.boolean(),
  configMode: ConfigMode,
});
export type Features = z.infer<typeof Features>;

export const Badges = z.object({ inboxOpen: z.number().int().nonnegative(), evalsRunning: z.number().int().nonnegative() });
export type Badges = z.infer<typeof Badges>;

/** `role` is the user's role in the active organization (`viewer` with no capabilities when there is none). */
export const MeUser = z.object({ id: Id, email: z.string(), name: z.string(), role: Role, anonymous: z.boolean() });
export type MeUser = z.infer<typeof MeUser>;

export const Me = z.object({
  user: MeUser,
  /** The active organization of this request (multi-tenancy spec §3.3); null when the user has no membership. */
  tenant: TenantSummary.nullable(),
  /** Every organization the user belongs to (the switcher lists them when `tenancy.multi`). */
  tenants: z.array(TenantSummary),
  /** Several organizations on this deployment (cloud); false on a self-hosted install. */
  tenancy: z.object({ multi: z.boolean() }),
  capabilities: z.array(Capability),
  csrfToken: z.string(),
  features: Features,
  badges: Badges,
  instance: z.object({ name: z.string(), version: z.string(), demoReadOnly: z.boolean() }),
});
export type Me = z.infer<typeof Me>;

export const authEndpoints = {
  config: endpoint({
    method: 'GET', path: '/api/auth/config', kind: 'json', access: ['public'],
    summary: 'Login page configuration (OIDC, local link, demo mode)', response: AuthConfig,
  }),
  oidcStart: endpoint({
    method: 'GET', path: '/api/auth/oidc/start', kind: 'navigation', status: 302, access: ['public'],
    summary: 'Start OIDC sign-in (302 to the IdP; 404 when OIDC is off)', query: OidcStartQuery,
  }),
  oidcCallback: endpoint({
    method: 'GET', path: '/api/auth/oidc/callback', kind: 'navigation', status: 302, access: ['public'],
    summary: 'OIDC callback (302 to returnTo or /auth/login?error=)',
  }),
  link: endpoint({
    method: 'POST', path: '/api/auth/link', kind: 'json', access: ['public'],
    summary: 'Exchange a one-time local sign-in link token for a session (401 when expired or used)', body: LinkLoginBody, response: Me,
  }),
  logout: endpoint({
    method: 'POST', path: '/api/auth/logout', kind: 'json', access: ['user'], tenant: false,
    summary: 'Sign out of the current session', response: LogoutResult,
  }),
} as const;

export const meEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/me', kind: 'json', access: ['user'], tenant: false,
    summary: 'Current user, capabilities, CSRF token, features and badges (demo mode: anonymous viewer)', response: Me,
  }),
  badges: endpoint({
    method: 'GET', path: '/api/me/badges', kind: 'json', access: ['user'], tenant: false,
    summary: 'Sidebar badge counts', response: Badges,
  }),
} as const;
