import { auditEndpoints } from './audit.js';
import { authEndpoints, meEndpoints } from './auth.js';
import type { EndpointDef } from './endpoint.js';
import { environmentEndpoints, writeSwitchEndpoints } from './environments.js';
import { evalEndpoints, readinessEndpoints, suggestionEndpoints } from './evals.js';
import { inboxEndpoints } from './inbox.js';
import { keyEndpoints, oauthClientEndpoints, oauthGrantEndpoints } from './keys.js';
import { metricsEndpoints } from './metrics.js';
import { overlayEndpoints } from './overlays.js';
import { publicEndpoints } from './public.js';
import { opsToolEndpoints, serverEndpoints } from './servers.js';
import {
  configEndpoints, eventEndpoints, jobEndpoints, killSwitchEndpoints, modelProviderEndpoints, settingsEndpoints, systemEndpoints, telemetryEndpoints,
} from './settings.js';
import { inviteEndpoints, memberEndpoints, tenantEndpoints } from './members.js';
import { buildEndpoints, specEndpoints } from './specs.js';
import { callEndpoints, scriptEndpoints, taskEndpoints } from './tasks.js';
import { toolEndpoints } from './tools.js';

/**
 * The complete MVP REST contract (backend spec §14, incl. §14.15). Keys are `<area>.<name>` and are
 * the backend keys (A45); the console maps its own query names one-to-one (§23.1, `API_KEY_ALIASES`).
 * Server routes, the web client and MSW handlers are all built from this registry.
 */
export const api = {
  auth: authEndpoints,
  me: meEndpoints,
  metrics: metricsEndpoints,
  servers: serverEndpoints,
  opsTools: opsToolEndpoints,
  specs: specEndpoints,
  builds: buildEndpoints,
  tools: toolEndpoints,
  overlays: overlayEndpoints,
  environments: environmentEndpoints,
  writeSwitches: writeSwitchEndpoints,
  keys: keyEndpoints,
  oauthClients: oauthClientEndpoints,
  oauthGrants: oauthGrantEndpoints,
  tasks: taskEndpoints,
  calls: callEndpoints,
  scripts: scriptEndpoints,
  inbox: inboxEndpoints,
  evals: evalEndpoints,
  readiness: readinessEndpoints,
  suggestions: suggestionEndpoints,
  audit: auditEndpoints,
  settings: settingsEndpoints,
  modelProviders: modelProviderEndpoints,
  telemetry: telemetryEndpoints,
  killSwitches: killSwitchEndpoints,
  config: configEndpoints,
  system: systemEndpoints,
  tenants: tenantEndpoints,
  members: memberEndpoints,
  invites: inviteEndpoints,
  jobs: jobEndpoints,
  events: eventEndpoints,
  public: publicEndpoints,
} as const;

export type Api = typeof api;
export type ApiArea = keyof Api;
export type EndpointKey = { [A in ApiArea]: `${A}.${Extract<keyof Api[A], string>}` }[ApiArea];

export interface NamedEndpoint {
  /** `<area>.<name>`, e.g. `servers.get` */
  key: EndpointKey;
  def: EndpointDef;
}

/** Flat list of every endpoint, in registry order. */
export const ALL_ENDPOINTS: readonly NamedEndpoint[] = Object.entries(api).flatMap(([area, defs]) =>
  Object.entries(defs as Record<string, EndpointDef>).map(([name, def]) => ({ key: `${area}.${name}` as EndpointKey, def })),
);

export function endpointByKey(key: string): EndpointDef | undefined {
  const real = (API_KEY_ALIASES as Record<string, string>)[key] ?? key;
  return ALL_ENDPOINTS.find((e) => e.key === real)?.def;
}

/**
 * Names the specs use for the same endpoint (§14.15, §23.1). An alias is NOT a second route: the
 * server registers the target key once.
 */
export const API_KEY_ALIASES = {
  'tools.searchPreview': 'tools.search',
  'writeSwitches.set': 'environments.setToolWrite',
  'inbox.exportMarkdown': 'inbox.exportNeedMarkdown',
  'settings.modelProviders.list': 'modelProviders.list',
  'settings.modelProviders.create': 'modelProviders.create',
  'settings.modelProviders.update': 'modelProviders.update',
  'settings.modelProviders.delete': 'modelProviders.delete',
  'settings.modelProviders.test': 'modelProviders.test',
  // console users became the members of an organization (multi-tenancy spec §2.2)
  'users.list': 'members.list',
  'users.update': 'members.update',
} as const satisfies Record<string, EndpointKey>;

/**
 * Mutating endpoints an anonymous demo viewer may call (§23 demo allow-list; frontend
 * `DEMO_READ_ONLY_ALLOW`). Everything else that is not GET answers 403 `forbidden` +
 * `reason: demo_read_only` for anonymous sessions. Server-side restrictions still apply
 * (spec previews: pasted/uploaded content only, no URL fetches, 10/min per IP; environment
 * tests: mock environments only; telemetry test: no-op).
 */
export const DEMO_ANONYMOUS_ALLOW: readonly EndpointKey[] = [
  'auth.link',
  'auth.logout',
  'specs.preview',
  'specs.draftUpdate',
  'specs.cancelPreview',
  'overlays.preview',
  'overlays.validate',
  'environments.test',
  'environments.testDraft',
  'telemetry.test',
  'config.validate',
];

/** Path prefixes owned by the backend; they never fall back to the SPA. */
export const NON_SPA_PREFIXES = ['/api', '/mcp', '/oauth', '/.well-known', '/public', '/metrics', '/healthz', '/readyz'] as const;

export function isNonSpaPath(pathname: string): boolean {
  return NON_SPA_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`) || pathname.startsWith(`${p}?`));
}

/** Non-API backend paths (dev proxy and static fallback rules). */
export const BACKEND_PATHS = {
  mcp: '/mcp',
  /** `/mcp/{server}/{env}` */
  mcpEndpoint: '/mcp/:server/:env',
  prm: '/.well-known/oauth-protected-resource',
  /** `/.well-known/oauth-protected-resource/mcp/{server}/{env}` (RFC 9728) */
  prmMcp: '/.well-known/oauth-protected-resource/mcp/:server/:env',
  /** `/mcp/{tenant}/{server}/{env}`: registered only on a multi-tenant deployment (spec §3.2). */
  mcpTenantEndpoint: '/mcp/:tenant/:server/:env',
  prmMcpTenant: '/.well-known/oauth-protected-resource/mcp/:tenant/:server/:env',
  asMetadata: '/.well-known/oauth-authorization-server',
  oidcAlias: '/.well-known/openid-configuration',
  authorize: '/oauth/authorize',
  token: '/oauth/token',
  register: '/oauth/register',
  revoke: '/oauth/revoke',
  upstreamConnect: '/oauth/upstream/:environmentId/connect',
  upstreamCallback: '/oauth/upstream/callback',
  publicReport: '/public/servers/:slug/report',
  publicBadge: '/public/servers/:slug/badge.svg',
  healthz: '/healthz',
  readyz: '/readyz',
  metrics: '/metrics',
} as const;

/** SPA routes the backend redirects to. */
export const SPA_PATHS = {
  login: '/auth/login',
  loggedOut: '/auth/logged-out',
  /** Local sign-in link target: `PUBLIC_URL/auth/link#t=<token>`. */
  link: '/auth/link',
  consent: '/auth/consent',
  /** Invite link target: `PUBLIC_URL/invite#t=<token>` (spec §2.4). */
  invite: '/invite',
} as const;

/** `/mcp/{server}/{env}`, or `/mcp/{tenant}/{server}/{env}` when a tenant slug is given (multi-tenant deployments). */
export function mcpPath(server: string, env: string, tenant?: string | null): string {
  const t = tenant ? `${encodeURIComponent(tenant)}/` : '';
  return `/mcp/${t}${encodeURIComponent(server)}/${encodeURIComponent(env)}`;
}
