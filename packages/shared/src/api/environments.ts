import * as z from 'zod';
import { CredentialState, EnvironmentKind, HealthStatus, ConfirmMode, ManagedBy, ResourceStatus, DiscoveryMode } from '../domain/enums.js';
import { Limits, LimitsInput } from '../config/limits.js';
import { Policy } from '../config/policy.js';
import { SecretName, SecretRefString } from '../config/secret-ref.js';
import { ConfigLocation, EnvSlug, Id, IdParams, IsoDateTime, Items } from './common.js';
import { endpoint } from './endpoint.js';
import { BuildRow } from './specs.js';

/* ------------------------------------------------------------------ upstream auth (§13.5, §14.7) */

const HttpUrl = z.url({ protocol: /^https?$/ });
const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, 'invalid header name');

/** Upstream credential descriptor as sent by the console: secret **references** only, never values. */
export const UpstreamAuthIn = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({ type: z.literal('bearer'), secretRef: SecretRefString }),
  z.object({ type: z.literal('header'), headerName: HeaderName, secretRef: SecretRefString }),
  z.object({ type: z.literal('query'), paramName: z.string().min(1).max(128), secretRef: SecretRefString }),
  z.object({ type: z.literal('basic'), username: z.string().min(1).max(256), secretRef: SecretRefString }),
  z.object({ type: z.literal('oauth_client_credentials'), tokenUrl: HttpUrl, clientId: z.string().min(1), clientSecretRef: SecretRefString, scopes: z.array(z.string()).default([]), audience: z.string().optional() }),
  z.object({
    type: z.literal('oauth_passthrough'),
    /** broker: users connect once via the API's AS; forward_inbound: forward the external-AS JWT (§13.4). */
    mode: z.enum(['broker', 'forward_inbound']).default('broker'),
    authorizationUrl: HttpUrl.optional(),
    tokenUrl: HttpUrl.optional(),
    clientId: z.string().optional(),
    clientSecretRef: SecretRefString.optional(),
    scopes: z.array(z.string()).default([]),
    upstreamAudience: z.string().optional(),
  }),
]);
export type UpstreamAuthIn = z.infer<typeof UpstreamAuthIn>;

const SecretState = z.object({ hasSecret: z.boolean(), secretUpdatedAt: IsoDateTime.nullable() });

/** Same as `UpstreamAuthIn` plus secret presence (values never leave the server; refs masked in demo mode). */
export const UpstreamAuthOut = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).extend(SecretState.shape),
  z.object({ type: z.literal('bearer'), secretRef: z.string() }).extend(SecretState.shape),
  z.object({ type: z.literal('header'), headerName: z.string(), secretRef: z.string() }).extend(SecretState.shape),
  z.object({ type: z.literal('query'), paramName: z.string(), secretRef: z.string() }).extend(SecretState.shape),
  z.object({ type: z.literal('basic'), username: z.string(), secretRef: z.string() }).extend(SecretState.shape),
  z.object({ type: z.literal('oauth_client_credentials'), tokenUrl: z.string(), clientId: z.string(), clientSecretRef: z.string(), scopes: z.array(z.string()), audience: z.string().optional() }).extend(SecretState.shape),
  z
    .object({
      type: z.literal('oauth_passthrough'),
      mode: z.enum(['broker', 'forward_inbound']),
      authorizationUrl: z.string().optional(),
      tokenUrl: z.string().optional(),
      clientId: z.string().optional(),
      clientSecretRef: z.string().optional(),
      scopes: z.array(z.string()),
      upstreamAudience: z.string().optional(),
      /** Broker: the current user's own upstream connection. */
      connected: z.boolean(),
      connectUrl: z.string().nullable(),
    })
    .extend(SecretState.shape),
]);
export type UpstreamAuthOut = z.infer<typeof UpstreamAuthOut>;

/* ------------------------------------------------------------------ writes */

export const WritesConfig = z.object({
  enabled: z.boolean(),
  /** Write allow-list; null = all write tools. */
  tools: z.array(z.string()).nullable().optional(),
  confirm: ConfirmMode,
  /** Typed confirmation: must equal the environment slug when kind=prod and enabled. */
  confirmEnvironmentSlug: z.string().optional(),
});
export type WritesConfig = z.infer<typeof WritesConfig>;

export const WritesView = z.object({
  enabled: z.boolean(),
  tools: z.array(z.string()).nullable(),
  confirm: ConfirmMode,
  writeToolCount: z.number().int(),
  enabledToolNames: z.array(z.string()),
});
export type WritesView = z.infer<typeof WritesView>;

/* ------------------------------------------------------------------ environments */

export const EnvironmentHealth = z.object({ status: HealthStatus, checkedAt: IsoDateTime.nullable(), latencyMs: z.number().int().nullable(), error: z.string().nullable() });
export type EnvironmentHealth = z.infer<typeof EnvironmentHealth>;

export const EnvironmentDetail = z.object({
  id: Id,
  serverId: Id,
  slug: z.string(),
  name: z.string(),
  kind: EnvironmentKind,
  /** `mock:` for the in-process mock. */
  baseUrl: z.string(),
  isMock: z.boolean(),
  /** The built-in `mock` environment (cannot be deleted). */
  builtin: z.boolean(),
  status: ResourceStatus,
  buildId: Id.nullable(),
  build: BuildRow.nullable(),
  auth: UpstreamAuthOut,
  headers: z.record(z.string(), z.string()),
  writes: WritesView,
  codeMode: z.boolean(),
  limits: Limits,
  policies: z.array(Policy),
  discovery: DiscoveryMode.nullable(),
  allowedHosts: z.array(z.string()),
  allowHttp: z.boolean(),
  autoPromote: z.boolean(),
  health: EnvironmentHealth,
  credential: CredentialState,
  mcpUrl: z.string(),
  managedBy: ManagedBy,
  config: ConfigLocation.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type EnvironmentDetail = z.infer<typeof EnvironmentDetail>;

export const EnvironmentCreate = z.object({
  slug: EnvSlug,
  name: z.string().min(1).max(100).optional(),
  kind: EnvironmentKind,
  baseUrl: z.union([z.literal('mock:'), HttpUrl]),
  auth: UpstreamAuthIn.default({ type: 'none' }),
  headers: z.record(HeaderName, z.string().max(4096)).optional(),
  codeMode: z.boolean().optional(),
  limits: LimitsInput.optional(),
  allowedHosts: z.array(z.string().min(1).max(253)).optional(),
  allowHttp: z.boolean().optional(),
  autoPromote: z.boolean().optional(),
});
export type EnvironmentCreate = z.infer<typeof EnvironmentCreate>;

export const EnvironmentPatch = EnvironmentCreate.omit({ slug: true })
  .partial()
  .extend({ policies: z.array(Policy).optional(), status: z.enum(['active', 'disabled']).optional(), discovery: DiscoveryMode.nullable().optional() });
export type EnvironmentPatch = z.infer<typeof EnvironmentPatch>;

export const SetToolWriteBody = z.object({
  enabled: z.boolean(),
  /** Optional: also sets the environment confirm mode (prod enable: elicit|deny_without_elicitation). */
  confirm: z.enum(['elicit', 'deny_without_elicitation']).optional(),
  /** Required to turn on a write on a prod environment whose writes are off (typed confirm, frontend G4). */
  confirmEnvironmentSlug: z.string().optional(),
});
export type SetToolWriteBody = z.infer<typeof SetToolWriteBody>;

export const PinBuildBody = z.object({ buildId: Id });
export const SetSecretBody = z.object({ value: z.string().min(1).max(8192) });
export type SetSecretBody = z.infer<typeof SetSecretBody>;

export const SecretRef = z.object({ name: z.string(), ref: z.string(), updatedAt: IsoDateTime });
export type SecretRef = z.infer<typeof SecretRef>;

export const EnvTestBody = z.object({ toolName: z.string().min(1).optional(), arguments: z.record(z.string(), z.unknown()).optional() });
export type EnvTestBody = z.infer<typeof EnvTestBody>;

export const EnvTestResult = z.object({
  ok: z.boolean(),
  latencyMs: z.number().int().nullable(),
  status: z.number().int().optional(),
  credential: z.enum(['ok', 'missing', 'rejected', 'not_required']),
  detail: z.string().optional(),
  /** Shaped result of the test call (read tools only). */
  result: z.unknown().optional(),
});
export type EnvTestResult = z.infer<typeof EnvTestResult>;

export const TestDraftBody = z.object({ baseUrl: z.union([z.literal('mock:'), HttpUrl]), auth: UpstreamAuthIn });
export type TestDraftBody = z.infer<typeof TestDraftBody>;

export const ResetMockBody = z.object({ seed: z.number().int().optional() });

export const DeleteConfirmQuery = z.object({ confirm: z.string().min(1) });

const ServerIdParams = z.object({ id: Id });
const SecretParams = z.object({ id: Id, name: SecretName });
const ToolWriteParams = z.object({ id: Id, toolName: z.string().min(1).max(64) });

export const environmentEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers/:id/environments', kind: 'json', access: ['environments:read'],
    summary: 'Environments of a server (incl. the built-in mock)', params: ServerIdParams, response: Items(EnvironmentDetail),
  }),
  create: endpoint({
    method: 'POST', path: '/api/servers/:id/environments', kind: 'json', status: 201, access: ['environments:write'],
    summary: 'Create an environment (read-only by default; 409 slug taken)', params: ServerIdParams, body: EnvironmentCreate, response: EnvironmentDetail,
  }),
  get: endpoint({
    method: 'GET', path: '/api/environments/:id', kind: 'json', access: ['environments:read'],
    summary: 'One environment', params: IdParams, response: EnvironmentDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/environments/:id', kind: 'json', access: ['environments:write'],
    summary: 'Update an environment (409 config_managed)', params: IdParams, body: EnvironmentPatch, response: EnvironmentDetail,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/environments/:id', kind: 'empty', access: ['environments:write'],
    summary: 'Delete an environment (?confirm=<slug>; 409 config_managed or builtin)', params: IdParams, query: DeleteConfirmQuery,
  }),
  setWrites: endpoint({
    method: 'PUT', path: '/api/environments/:id/writes', kind: 'json', access: ['writes:enable'],
    summary: 'Environment-wide write switch (422 prod confirm=none / slug mismatch; 409 config_managed)', params: IdParams, body: WritesConfig, response: EnvironmentDetail,
  }),
  setToolWrite: endpoint({
    method: 'PUT', path: '/api/environments/:id/writes/tools/:toolName', kind: 'json', access: ['writes:enable'],
    summary: 'One cell of the write-switch matrix (= writeSwitches.set)', params: ToolWriteParams, body: SetToolWriteBody, response: EnvironmentDetail,
  }),
  pinBuild: endpoint({
    method: 'PUT', path: '/api/environments/:id/build', kind: 'json', access: ['environments:write'],
    summary: 'Pin a build (422 build of another server or failed build)', params: IdParams, body: PinBuildBody, response: EnvironmentDetail,
  }),
  setSecret: endpoint({
    method: 'PUT', path: '/api/environments/:id/secrets/:name', kind: 'json', access: ['environments:write'],
    summary: 'Store an encrypted secret (write-only); reference it as secret:<name>', params: SecretParams, body: SetSecretBody, response: SecretRef,
  }),
  deleteSecret: endpoint({
    method: 'DELETE', path: '/api/environments/:id/secrets/:name', kind: 'empty', access: ['environments:write'],
    summary: 'Delete a stored secret', params: SecretParams,
  }),
  test: endpoint({
    method: 'POST', path: '/api/environments/:id/test', kind: 'json', access: ['environments:read'],
    summary: 'Health probe or a test call of a read tool (writes refused)', params: IdParams, body: EnvTestBody, response: EnvTestResult,
  }),
  resetMock: endpoint({
    method: 'POST', path: '/api/environments/:id/mock/reset', kind: 'empty', access: ['environments:write'],
    summary: 'Reseed the mock state (422 not a mock environment)', params: IdParams, body: ResetMockBody,
  }),
  testDraft: endpoint({
    method: 'POST', path: '/api/spec-previews/:id/test-connection', kind: 'json', access: ['servers:write'],
    summary: 'Test a base URL + credential for a spec preview (wizard)', params: IdParams, body: TestDraftBody, response: EnvTestResult,
  }),
  connectUpstream: endpoint({
    method: 'GET', path: '/oauth/upstream/:environmentId/connect', kind: 'navigation', status: 302, access: ['user'],
    summary: "Connect the user's own account at the API's authorization server (oauth_passthrough broker)", params: z.object({ environmentId: Id }),
  }),
} as const;

/* ------------------------------------------------------------------ write-switch matrix (§14.15) */

export const WriteSwitchMatrix = z.object({
  environments: z.array(z.object({ id: Id, slug: z.string(), kind: EnvironmentKind, writesEnabled: z.boolean(), confirm: ConfirmMode, managedBy: ManagedBy })),
  tools: z.array(z.object({ name: z.string(), title: z.string(), destructive: z.boolean(), cells: z.record(z.string(), z.boolean()) })),
});
export type WriteSwitchMatrix = z.infer<typeof WriteSwitchMatrix>;

export const writeSwitchEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/servers/:id/write-switches', kind: 'json', access: ['environments:read'],
    summary: 'Write tools × environments matrix (cells keyed by environment slug)', params: ServerIdParams, response: WriteSwitchMatrix,
  }),
} as const;
