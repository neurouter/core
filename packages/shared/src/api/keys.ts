import * as z from 'zod';
import { ApiKeyStatus, EnvironmentKind, Scope } from '../domain/enums.js';
import { RateLimit } from '../config/limits.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Items, Page, Ref, SlugRef, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';
import { ConnectConfig } from './servers.js';

/* ------------------------------------------------------------------ API keys (§14.8) */

export const ApiKeyRow = z.object({
  id: Id,
  name: z.string(),
  /** `nrk_live_<keyId>` (masked in demo mode). */
  displayPrefix: z.string(),
  server: SlugRef,
  environment: SlugRef.extend({ kind: EnvironmentKind }),
  scopes: z.array(Scope),
  profile: z.string().nullable(),
  rateLimit: RateLimit.nullable(),
  owner: Ref,
  expiresAt: IsoDateTime.nullable(),
  revokedAt: IsoDateTime.nullable(),
  lastUsedAt: IsoDateTime.nullable(),
  status: ApiKeyStatus,
  createdAt: IsoDateTime,
});
export type ApiKeyRow = z.infer<typeof ApiKeyRow>;

export const ApiKeyListQuery = CursorQuery.extend({ serverId: queryOptional(Id), environmentId: queryOptional(Id), status: queryOptional(ApiKeyStatus) });
export type ApiKeyListQuery = z.infer<typeof ApiKeyListQuery>;

export const ApiKeyCreate = z.object({
  name: z.string().min(1).max(100),
  serverId: Id,
  environmentId: Id,
  scopes: z.array(Scope).min(1).default(['tools:read']),
  profile: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(),
  /** null = never expires; default 90 days. */
  expiresInDays: z.number().int().min(1).max(3650).nullable().optional(),
  rateLimit: RateLimit.optional(),
});
export type ApiKeyCreate = z.infer<typeof ApiKeyCreate>;

export const ApiKeyCreated = z.object({
  key: ApiKeyRow,
  /** The full secret `nrk_live_…`, shown once. */
  token: z.string(),
  connect: ConnectConfig,
  /** e.g. `tools:write` on an environment whose writes are off. */
  warnings: z.array(z.string()),
});
export type ApiKeyCreated = z.infer<typeof ApiKeyCreated>;

export const ApiKeyPatch = z.object({ name: z.string().min(1).max(100).optional() });

export const keyEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/keys', kind: 'json', access: ['keys:read'],
    summary: 'API keys (eval keys hidden)', query: ApiKeyListQuery, response: Page(ApiKeyRow),
  }),
  create: endpoint({
    method: 'POST', path: '/api/keys', kind: 'json', status: 201, access: ['keys:manage'],
    summary: 'Create a key bound to one server + environment (secret shown once)', body: ApiKeyCreate, response: ApiKeyCreated,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/keys/:id', kind: 'json', access: ['keys:manage'],
    summary: 'Rename a key', params: IdParams, body: ApiKeyPatch, response: ApiKeyRow,
  }),
  revoke: endpoint({
    method: 'POST', path: '/api/keys/:id/revoke', kind: 'json', access: ['keys:manage'],
    summary: 'Revoke a key', params: IdParams, response: ApiKeyRow,
  }),
} as const;

/* ------------------------------------------------------------------ OAuth clients and grants */

export const OAuthClientRow = z.object({
  id: Id,
  clientId: z.string(),
  name: z.string(),
  clientUri: z.string().nullable(),
  logoUri: z.string().nullable(),
  registrationType: z.enum(['cimd', 'dcr', 'preregistered']),
  redirectUris: z.array(z.string()),
  status: z.enum(['active', 'blocked']),
  /** Environments with active tokens for this client. */
  environments: z.array(SlugRef.extend({ serverSlug: z.string(), kind: EnvironmentKind, activeTokens: z.number().int() })),
  lastUsedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type OAuthClientRow = z.infer<typeof OAuthClientRow>;

export const OAuthGrantRow = z.object({
  id: Id,
  user: Ref.extend({ email: z.string() }),
  client: Ref,
  environment: SlugRef.extend({ serverSlug: z.string(), kind: EnvironmentKind }),
  scopes: z.array(z.string()),
  lastUsedAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type OAuthGrantRow = z.infer<typeof OAuthGrantRow>;

export const oauthClientEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/oauth/clients', kind: 'json', access: ['keys:read'],
    summary: 'OAuth clients (DCR, CIMD, pre-registered)', query: CursorQuery, response: Page(OAuthClientRow),
  }),
  block: endpoint({
    method: 'POST', path: '/api/oauth/clients/:id/block', kind: 'json', access: ['keys:manage'],
    summary: 'Block a client (revokes its tokens)', params: IdParams, response: OAuthClientRow,
  }),
  unblock: endpoint({
    method: 'POST', path: '/api/oauth/clients/:id/unblock', kind: 'json', access: ['keys:manage'],
    summary: 'Unblock a client', params: IdParams, response: OAuthClientRow,
  }),
} as const;

export const oauthGrantEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/oauth/grants', kind: 'json', access: ['keys:read'],
    summary: 'User consents per client and environment', query: z.object({ environmentId: queryOptional(Id) }), response: Items(OAuthGrantRow),
  }),
  revoke: endpoint({
    method: 'DELETE', path: '/api/oauth/grants/:id', kind: 'empty', access: ['keys:manage'],
    summary: 'Revoke a grant and its tokens', params: IdParams,
  }),
} as const;
