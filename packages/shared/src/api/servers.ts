import * as z from 'zod';
import { ContractVersion, DiscoveryMode, EnvironmentKind, ExposureMode, HealthStatus, ManagedBy, OutputSchemaMode, ServerKind, SpecFormat } from '../domain/enums.js';
import { OPS_TOOLS } from '../mcp/tool-names.js';
import { ConfigLocation, CursorQuery, Id, IdParams, IsoDateTime, Items, Page, Slug, queryArray, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';
import { EnvironmentCreate } from './environments.js';
import { OverlayRevisionRow } from './overlays.js';
import { ReadinessSummary } from './readiness.js';
import { BuildRow, SpecRevisionRow, SpecSourceIn } from './specs.js';

/* ------------------------------------------------------------------ servers (§14.4) */

/**
 * `contract`: agent contract served when the client does not ask for one (absent = 1, servers created
 * before contract 2; new servers get the deployment default). `outputSchema`: see `OutputSchemaMode`.
 */
export const ExposureConfig = z.object({ mode: ExposureMode, discovery: DiscoveryMode, pinned: z.array(z.string()), contract: ContractVersion.optional(), outputSchema: OutputSchemaMode.optional() });
export type ExposureConfig = z.infer<typeof ExposureConfig>;

/** Record of the 8 MVP ops tools → enabled. */
export const OpsToolTogglesSchema = z.object(Object.fromEntries(OPS_TOOLS.map((t) => [t, z.boolean()])) as Record<(typeof OPS_TOOLS)[number], z.ZodBoolean>);
/** zod schema for `OpsToolToggles` (the type lives in `mcp/tool-names`). */
export type OpsToolTogglesApi = z.infer<typeof OpsToolTogglesSchema>;

export const ServerStatusApi = z.enum(['active', 'disabled', 'removed_from_config']);

export const ServerEnvironmentSummary = z.object({ id: Id, slug: z.string(), kind: EnvironmentKind, writesEnabled: z.boolean(), isMock: z.boolean(), health: HealthStatus });
export type ServerEnvironmentSummary = z.infer<typeof ServerEnvironmentSummary>;

export const ServerRow = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  kind: ServerKind,
  specFormat: SpecFormat.nullable(),
  status: ServerStatusApi,
  managedBy: ManagedBy,
  toolCount: z.number().int(),
  visibleToolCount: z.number().int(),
  writeToolCount: z.number().int(),
  environments: z.array(ServerEnvironmentSummary),
  readiness: ReadinessSummary.nullable(),
  lastSpecAt: IsoDateTime.nullable(),
  updatedAt: IsoDateTime,
});
export type ServerRow = z.infer<typeof ServerRow>;

export const ServerDetail = ServerRow.extend({
  description: z.string(),
  exposure: ExposureConfig,
  opsTools: OpsToolTogglesSchema,
  publicReport: z.boolean(),
  /** Absolute URL of the public report when `publicReport` is on. */
  publicReportUrl: z.string().nullable(),
  specSource: z.object({ url: z.string().nullable(), path: z.string().nullable(), upload: z.boolean() }),
  currentSpec: SpecRevisionRow.nullable(),
  publishedOverlay: OverlayRevisionRow.nullable(),
  draft: z.object({ changeCount: z.number().int(), updatedAt: IsoDateTime }).nullable(),
  latestBuild: BuildRow.nullable(),
  config: ConfigLocation.nullable(),
  /** File-managed fields (409 config_managed on change). */
  fileManagedFields: z.array(z.string()),
});
export type ServerDetail = z.infer<typeof ServerDetail>;

export const ServerListQuery = CursorQuery.extend({
  q: queryOptional(z.string().max(200)),
  status: queryArray(ServerStatusApi),
  kind: queryOptional(ServerKind),
});
export type ServerListQuery = z.infer<typeof ServerListQuery>;

const GraphqlOptions = z.object({ endpointPath: z.string().startsWith('/').optional(), selectionDepth: z.number().int().min(1).max(5).optional() });

/** Create from a source (202 + fetch/compile job). */
export const ServerCreateFromSource = z.object({
  slug: Slug,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  source: SpecSourceIn,
  format: z.enum(['openapi', 'graphql-sdl', 'graphql-introspection']).optional(),
  graphql: GraphqlOptions.optional(),
  environments: z.array(EnvironmentCreate).max(10).optional(),
});
/** Create from a spec preview (201 ServerDetail; publishes the preview's overlay draft as v1). */
export const ServerCreateFromPreview = z.object({
  previewId: Id,
  slug: Slug,
  name: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  environments: z.array(EnvironmentCreate).max(10).optional(),
});
export const ServerCreate = z.union([ServerCreateFromPreview, ServerCreateFromSource]);
export type ServerCreate = z.infer<typeof ServerCreate>;

export const ServerCreateAccepted = z.object({ server: ServerDetail, jobId: Id });
export type ServerCreateAccepted = z.infer<typeof ServerCreateAccepted>;

/** `servers.create` answers 202 ServerCreateAccepted (source) or 201 ServerDetail (previewId). */
export const ServerCreateResult = z.union([ServerCreateAccepted, ServerDetail]);
export type ServerCreateResult = z.infer<typeof ServerCreateResult>;

export const ServerPatch = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  exposure: ExposureConfig.partial().optional(),
  opsTools: OpsToolTogglesSchema.partial().optional(),
  publicReport: z.boolean().optional(),
  status: z.enum(['active', 'disabled']).optional(),
});
export type ServerPatch = z.infer<typeof ServerPatch>;

export const ServerDeleteQuery = z.object({ confirm: z.string().min(1) });

export const ConnectClientId = z.enum(['claude-code', 'cursor', 'vscode', 'http']);
export const ConnectConfig = z.object({
  mcpUrl: z.string(),
  resourceMetadataUrl: z.string(),
  environment: z.object({ id: Id, slug: z.string(), kind: EnvironmentKind }),
  auth: z.object({ apiKey: z.boolean(), oauth: z.boolean(), externalAs: z.object({ issuer: z.string() }).nullable() }),
  /** Short "what agents see" summary (exposure, discovery, writes). */
  summary: z.object({ exposure: ExposureMode, discovery: DiscoveryMode, listedTools: z.number().int(), codeMode: z.boolean(), writesEnabled: z.boolean() }),
  clients: z.array(z.object({ id: ConnectClientId, name: z.string(), snippet: z.string(), codeModeOnlySnippet: z.string() })),
});
export type ConnectConfig = z.infer<typeof ConnectConfig>;
export const ConnectQuery = z.object({ environmentId: queryOptional(Id) });

export const serverEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers', kind: 'json', access: ['servers:read'],
    summary: 'Servers with environments and readiness', query: ServerListQuery, response: Page(ServerRow),
  }),
  create: endpoint({
    method: 'POST', path: '/api/servers', kind: 'json', status: 202, access: ['servers:write'],
    summary: 'Import a spec as a new server (202 + job; 201 ServerDetail when created from a preview). 409 slug; 422 spec_invalid; 502 spec_fetch_failed',
    body: ServerCreate, response: ServerCreateResult,
  }),
  get: endpoint({
    method: 'GET', path: '/api/servers/:id', kind: 'json', access: ['servers:read'],
    summary: 'Server detail', params: IdParams, response: ServerDetail,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/servers/:id', kind: 'json', access: ['servers:write'],
    summary: 'Update exposure, ops tools, public report, status (409 config_managed)', params: IdParams, body: ServerPatch, response: ServerDetail,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/servers/:id', kind: 'empty', access: ['servers:write'],
    summary: 'Delete a server (?confirm=<slug>; 409 config_managed; 422 confirm mismatch)', params: IdParams, query: ServerDeleteQuery,
  }),
  connect: endpoint({
    method: 'GET', path: '/api/servers/:id/connect', kind: 'json', access: ['keys:read'],
    summary: 'MCP URL, auth modes and client snippets for one environment', params: IdParams, query: ConnectQuery, response: ConnectConfig,
  }),
} as const;

/* ------------------------------------------------------------------ ops tools (§14.15) */

export const OpsToolRow = z.object({
  name: z.string(),
  pyName: z.string().nullable(),
  title: z.string(),
  description: z.string(),
  enabled: z.boolean(),
  /** `read_result` is always on and not toggleable. */
  toggleable: z.boolean(),
  visibility: z.enum(['pinned', 'search', 'hint']),
  calls7d: z.number().int(),
});
export type OpsToolRow = z.infer<typeof OpsToolRow>;

export const opsToolEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers/:id/ops-tools', kind: 'json', access: ['servers:read'],
    summary: 'Ops tools of a server with toggles and 7-day usage', params: IdParams, response: Items(OpsToolRow),
  }),
  set: endpoint({
    method: 'PUT', path: '/api/servers/:id/ops-tools', kind: 'json', access: ['servers:write'],
    summary: 'Toggle ops tools (409 config_managed)', params: IdParams, body: OpsToolTogglesSchema.partial(), response: Items(OpsToolRow),
  }),
} as const;

