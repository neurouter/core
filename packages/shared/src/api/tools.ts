import * as z from 'zod';
import { ToolKind } from '../domain/enums.js';
import { OverlayToolEntry } from '../overlay/schema.js';
import { CursorQuery, Id, IdParams, Items, Page, QueryBool, ServerRef, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';
import { AgentView } from './overlays.js';

/* ------------------------------------------------------------------ tools (§14.6) */

export const ToolRiskView = z.object({ readOnly: z.boolean(), destructive: z.boolean(), idempotent: z.boolean(), openWorld: z.boolean(), write: z.boolean() });

export const ToolRow = z.object({
  id: Id,
  buildId: Id,
  name: z.string(),
  pyName: z.string(),
  title: z.string(),
  /** First sentence of the description. */
  summary: z.string(),
  kind: ToolKind,
  method: z.string().nullable(),
  path: z.string().nullable(),
  /** Overlay selector key of the source operation. */
  key: z.string(),
  write: z.boolean(),
  destructive: z.boolean(),
  hidden: z.boolean(),
  pinned: z.boolean(),
  deprecated: z.boolean(),
  overlayModified: z.boolean(),
  tags: z.array(z.string()),
  /** Env slugs where this write tool is enabled (read tools: all). */
  writeEnabledIn: z.array(z.string()),
  calls7d: z.number().int(),
  errorRate7d: z.number().min(0).max(1),
});
export type ToolRow = z.infer<typeof ToolRow>;

export const BindingView = z.discriminatedUnion('type', [
  z.object({ type: z.literal('http'), method: z.string(), pathTemplate: z.string(), params: z.array(z.object({ arg: z.string(), in: z.string(), name: z.string(), required: z.boolean() })), bodyContentType: z.string().nullable(), successStatuses: z.array(z.number().int()) }),
  z.object({ type: z.literal('graphql'), operationType: z.enum(['query', 'mutation']), document: z.string() }),
  z.object({ type: z.literal('composite'), script: z.string() }),
]);
export type BindingView = z.infer<typeof BindingView>;

export const ToolAnnotations = z.object({ title: z.string().optional(), readOnlyHint: z.boolean(), destructiveHint: z.boolean(), idempotentHint: z.boolean(), openWorldHint: z.boolean() });

export const ToolDetail = ToolRow.extend({
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).nullable(),
  annotations: ToolAnnotations,
  risk: ToolRiskView,
  binding: BindingView,
  examples: z.array(z.object({ title: z.string().optional(), arguments: z.record(z.string(), z.unknown()) })),
  pySignature: z.string(),
  sourceRef: z.record(z.string(), z.unknown()),
  overlayApplied: z.array(z.string()),
  /** The overlay draft entry that targets this tool (by its stable key), or null. */
  overlayEntry: OverlayToolEntry.nullable(),
  agentView: AgentView,
  defHash: z.string(),
});
export type ToolDetail = z.infer<typeof ToolDetail>;

export const ToolListQuery = CursorQuery.extend({
  buildId: queryOptional(Id),
  environmentId: queryOptional(Id),
  q: queryOptional(z.string().max(200)),
  visibility: queryOptional(z.enum(['visible', 'hidden', 'all'])),
  kind: queryOptional(z.enum(['read', 'write'])),
  pinned: queryOptional(QueryBool),
  modified: queryOptional(QueryBool),
  tag: queryOptional(z.string().max(64)),
});
export type ToolListQuery = z.infer<typeof ToolListQuery>;

/** Same as MCP `search_tools` structuredContent (§9.4). */
export const ToolSearchHit = z.object({
  name: z.string(),
  title: z.string(),
  description: z.string(),
  readOnly: z.boolean(),
  write: z.boolean(),
  inputSchema: z.record(z.string(), z.unknown()).optional(),
  pySignature: z.string().optional(),
  score: z.number(),
});
export const ToolSearchResult = z.object({ tools: z.array(ToolSearchHit), totalVisible: z.number().int(), hint: z.string().optional(), mode: z.enum(['hybrid', 'keyword']).optional() });
export type ToolSearchResult = z.infer<typeof ToolSearchResult>;

export const ToolSearchQuery = z.object({
  q: z.string().min(1).max(500),
  environmentId: queryOptional(Id),
  format: queryOptional(z.enum(['json', 'python'])),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(25).optional()),
});
export type ToolSearchQuery = z.infer<typeof ToolSearchQuery>;

export const ToolSearchAllQuery = z.object({ q: z.string().min(1).max(200), limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(50).optional()) });
export const ToolSearchAllHit = z.object({ id: Id, name: z.string(), title: z.string(), server: ServerRef });

export const ToolDefinitionDiff = z.object({ before: AgentView.nullable(), after: AgentView.nullable(), changedFields: z.array(z.string()) });
export type ToolDefinitionDiff = z.infer<typeof ToolDefinitionDiff>;

export const toolEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers/:id/tools', kind: 'json', access: ['tools:read'],
    summary: 'Tools of a build (default: latest)', params: IdParams, query: ToolListQuery, response: Page(ToolRow),
  }),
  get: endpoint({
    method: 'GET', path: '/api/tools/:id', kind: 'json', access: ['tools:read'],
    summary: 'Tool detail incl. "as the agent sees it"', params: IdParams, response: ToolDetail,
  }),
  search: endpoint({
    method: 'GET', path: '/api/servers/:id/tools/search', kind: 'json', access: ['tools:read'],
    summary: 'Run search_tools as an admin principal (= tools.searchPreview; allowed in demo)', params: IdParams, query: ToolSearchQuery, response: ToolSearchResult,
  }),
  diff: endpoint({
    method: 'GET', path: '/api/tools/:id/diff', kind: 'json', access: ['tools:read'],
    summary: 'Agent-visible definition diff against another build', params: IdParams, query: z.object({ against: Id }), response: ToolDefinitionDiff,
  }),
  searchAll: endpoint({
    method: 'GET', path: '/api/tools/search', kind: 'json', access: ['tools:read'],
    summary: 'Keyword search across the latest builds of all servers (command palette)', query: ToolSearchAllQuery, response: Items(ToolSearchAllHit),
  }),
} as const;
