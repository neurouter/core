import * as z from 'zod';
import { BuildStatus, ServerKind, SpecFormat } from '../domain/enums.js';
import { Diagnostic, LintReport } from '../domain/tool-model.js';
import { CursorQuery, Id, IdParams, IsoDateTime, JobAccepted, Page, Ref, Slug } from './common.js';
import { endpoint } from './endpoint.js';
import { OverlayPatchOp } from '../overlay/schema.js';

/* ------------------------------------------------------------------ spec revisions (§14.5) */

export const SpecRevisionRow = z.object({
  id: Id,
  rev: z.number().int().min(1),
  format: SpecFormat,
  title: z.string(),
  apiVersion: z.string().nullable(),
  operationCount: z.number().int().nonnegative(),
  contentHash: z.string(),
  contentBytes: z.number().int().nonnegative(),
  sourceUrl: z.string().nullable(),
  createdAt: IsoDateTime,
  createdBy: Ref.nullable(),
});
export type SpecRevisionRow = z.infer<typeof SpecRevisionRow>;

/** A spec operation reference (`key` = overlay selector: `operationId:x`, `"GET /p"`, `graphql:Query.f`). */
export const OpRef = z.object({ key: z.string(), method: z.string().optional(), path: z.string().optional(), operationId: z.string().optional(), toolName: z.string().optional() });
export type OpRef = z.infer<typeof OpRef>;

export const SpecChangeSummary = z.object({
  added: z.array(OpRef),
  removed: z.array(OpRef),
  changed: z.array(z.object({ op: OpRef, fields: z.array(z.string()) })),
  orphanedOverlayKeys: z.array(z.string()),
});
export type SpecChangeSummary = z.infer<typeof SpecChangeSummary>;

export const SpecRevisionDetail = SpecRevisionRow.extend({ summary: SpecChangeSummary });
export type SpecRevisionDetail = z.infer<typeof SpecRevisionDetail>;

/** Spec source: a URL to fetch, or pasted / uploaded content (≤ 10 MiB). */
export const SpecSourceIn = z.union([
  z.object({ url: z.url({ protocol: /^https?$/ }) }),
  z.object({ content: z.string().min(1).max(10 * 1024 * 1024), filename: z.string().max(255).optional() }),
]);
export type SpecSourceIn = z.infer<typeof SpecSourceIn>;

export const SpecReimport = z.union([
  z.object({ previewId: Id }),
  /** Omitted `source` = refetch the stored URL. */
  z.object({ source: SpecSourceIn.optional() }),
]);
export type SpecReimport = z.infer<typeof SpecReimport>;

/* ------------------------------------------------------------------ builds */

export const DiagnosticsCount = z.object({ error: z.number().int(), warning: z.number().int(), info: z.number().int() });

export const BuildRow = z.object({
  id: Id,
  hash: z.string(),
  status: BuildStatus,
  specRev: z.number().int(),
  overlayRev: z.number().int().nullable(),
  compilerVersion: z.string(),
  toolCount: z.number().int(),
  visibleCount: z.number().int(),
  writeCount: z.number().int(),
  hiddenCount: z.number().int(),
  lintScore: z.number().int().min(0).max(100),
  diagnosticsCount: DiagnosticsCount,
  /** Slugs of the environments pinned to this build. */
  environments: z.array(z.string()),
  createdAt: IsoDateTime,
});
export type BuildRow = z.infer<typeof BuildRow>;

export const BuildDetail = BuildRow.extend({ diagnostics: z.array(Diagnostic), lint: LintReport, orphanedOverlayKeys: z.array(z.string()) });
export type BuildDetail = z.infer<typeof BuildDetail>;

export const PythonStubs = z.object({ namespaces: z.array(z.object({ name: z.string(), pyi: z.string() })) });
export type PythonStubs = z.infer<typeof PythonStubs>;

export const SpecReimportResult = z.object({ revision: SpecRevisionRow, build: BuildRow, summary: SpecChangeSummary, unchanged: z.boolean() });
export type SpecReimportResult = z.infer<typeof SpecReimportResult>;

/* ------------------------------------------------------------------ spec previews (§14.15) */

const IntrospectionHeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, 'invalid header name');

export const SpecPreviewSource = z.union([
  SpecSourceIn,
  z.object({
    graphqlEndpoint: z.url({ protocol: /^https?$/ }),
    /** One header whose value comes from a reference (`env:NAME`); kept with the server for re-imports. */
    headerRef: z.object({ name: IntrospectionHeaderName, secretRef: z.string() }).optional(),
    /** Headers sent with the introspection request only (e.g. Authorization); never stored. */
    headers: z.array(z.object({ name: IntrospectionHeaderName, value: z.string().max(8192) })).max(10).optional(),
  }),
]);
export type SpecPreviewSource = z.infer<typeof SpecPreviewSource>;

export const SpecPreviewCreate = z.object({
  source: SpecPreviewSource,
  /** Re-import: diff against the server's current build. */
  serverId: Id.optional(),
  format: z.enum(['openapi', 'graphql-sdl', 'graphql-introspection']).optional(),
  graphql: z.object({ endpointPath: z.string().optional(), selectionDepth: z.number().int().min(1).max(5).optional() }).optional(),
});
export type SpecPreviewCreate = z.infer<typeof SpecPreviewCreate>;

export const PreviewStageName = z.enum(['fetch', 'parse', 'validate', 'normalize', 'generate']);
export const PreviewStage = z.object({ name: PreviewStageName, status: z.enum(['pending', 'running', 'ok', 'failed', 'skipped']), durationMs: z.number().int().nullable() });
export type PreviewStage = z.infer<typeof PreviewStage>;

export const PreviewToolRow = z.object({
  name: z.string(),
  title: z.string(),
  method: z.string().nullable(),
  path: z.string().nullable(),
  /** GraphQL root field (`Query.repository`). */
  field: z.string().nullable(),
  write: z.boolean(),
  hidden: z.boolean(),
  descriptionQuality: z.enum(['none', 'short', 'ok']),
  /** Arg names the wizard suggests hiding. */
  suggestedHide: z.array(z.string()),
});
export type PreviewToolRow = z.infer<typeof PreviewToolRow>;

export const SpecPreview = z.object({
  id: Id,
  status: z.enum(['compiling', 'ready', 'failed']),
  stages: z.array(PreviewStage),
  kind: ServerKind.nullable(),
  format: SpecFormat.nullable(),
  title: z.string().nullable(),
  suggestedSlug: z.string().nullable(),
  /** Name and slug chosen in the wizard (`specs.draftUpdate`). */
  name: z.string().nullable(),
  slug: z.string().nullable(),
  operationCount: z.number().int(),
  counts: z.object({ tools: z.number().int(), writeTools: z.number().int(), hiddenByDefault: z.number().int() }),
  diagnostics: z.array(Diagnostic),
  tools: z.array(PreviewToolRow),
  lint: LintReport.nullable(),
  preliminaryScore: z.number().int().min(0).max(100).nullable(),
  overlayDraftYaml: z.string(),
  diff: SpecChangeSummary.nullable(),
  expiresAt: IsoDateTime,
});
export type SpecPreview = z.infer<typeof SpecPreview>;

export const SpecPreviewUpdate = z.object({
  name: z.string().min(1).max(100).optional(),
  slug: Slug.optional(),
  overlayOps: z.array(OverlayPatchOp).optional(),
  graphql: z.object({ selectionDepth: z.number().int().min(1).max(5) }).optional(),
});
export type SpecPreviewUpdate = z.infer<typeof SpecPreviewUpdate>;

const ServerIdParams = z.object({ id: Id });
const SpecDiffQuery = z.object({ against: Id });

export const specEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers/:id/specs', kind: 'json', access: ['servers:read'],
    summary: 'Spec revisions of a server (newest first)', params: ServerIdParams, query: CursorQuery, response: Page(SpecRevisionRow),
  }),
  reimport: endpoint({
    method: 'POST', path: '/api/servers/:id/specs', kind: 'json', status: 202, access: ['servers:write'],
    summary: 'Re-import the spec (job result: SpecReimportResult; 409 config_managed for file sources)', params: ServerIdParams, body: SpecReimport, response: JobAccepted,
  }),
  get: endpoint({
    method: 'GET', path: '/api/specs/:id', kind: 'json', access: ['servers:read'],
    summary: 'Spec revision with its change summary', params: IdParams, response: SpecRevisionDetail,
  }),
  download: endpoint({
    method: 'GET', path: '/api/specs/:id/content', kind: 'download', access: ['servers:read'],
    summary: 'Original spec bytes (original content type)', params: IdParams,
  }),
  diff: endpoint({
    method: 'GET', path: '/api/specs/:id/diff', kind: 'json', access: ['servers:read'],
    summary: 'Operation-level diff against another revision', params: IdParams, query: SpecDiffQuery, response: SpecChangeSummary,
  }),
  preview: endpoint({
    method: 'POST', path: '/api/spec-previews', kind: 'json', status: 202, access: ['servers:write'],
    summary: 'Compile a spec without creating a server (kept 24 h); job result: SpecPreview', body: SpecPreviewCreate, response: JobAccepted.extend({ previewId: Id }),
  }),
  draft: endpoint({
    method: 'GET', path: '/api/spec-previews/:id', kind: 'json', access: ['servers:write'],
    summary: 'A spec preview (404 when expired)', params: IdParams, response: SpecPreview,
  }),
  draftUpdate: endpoint({
    method: 'PATCH', path: '/api/spec-previews/:id', kind: 'json', access: ['servers:write'],
    summary: 'Rename, re-slug or re-apply overlay ops to a preview', params: IdParams, body: SpecPreviewUpdate, response: SpecPreview,
  }),
  cancelPreview: endpoint({
    method: 'DELETE', path: '/api/spec-previews/:id', kind: 'empty', access: ['servers:write'],
    summary: 'Discard a spec preview', params: IdParams,
  }),
} as const;

export const buildEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/servers/:id/builds', kind: 'json', access: ['servers:read'],
    summary: 'Builds of a server (newest first)', params: ServerIdParams, query: CursorQuery, response: Page(BuildRow),
  }),
  get: endpoint({
    method: 'GET', path: '/api/builds/:id', kind: 'json', access: ['servers:read'],
    summary: 'Build with diagnostics, lint report and orphaned overlay keys', params: IdParams, response: BuildDetail,
  }),
  stubs: endpoint({
    method: 'GET', path: '/api/builds/:id/stubs', kind: 'json', access: ['tools:read'],
    summary: 'Python stubs (.pyi per namespace)', params: IdParams, response: PythonStubs,
  }),
} as const;

