import * as z from 'zod';
import { OverlaySource } from '../domain/enums.js';
import { Diagnostic } from '../domain/tool-model.js';
import { OverlayChange, OverlayPatchOp } from '../overlay/schema.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Page, Ref, TokenEstimate } from './common.js';
import { endpoint } from './endpoint.js';
import { BuildRow } from './specs.js';

/* ------------------------------------------------------------------ overlays (§14.6) */

export const OverlayRevisionRow = z.object({
  id: Id,
  rev: z.number().int().min(1),
  hash: z.string(),
  message: z.string(),
  source: OverlaySource,
  basedOnRev: z.number().int().nullable(),
  createdBy: Ref.nullable(),
  createdAt: IsoDateTime,
  /** Number of tools whose agent-visible definition this revision changed. */
  toolChanges: z.number().int().nonnegative(),
});
export type OverlayRevisionRow = z.infer<typeof OverlayRevisionRow>;

export const OverlayRevisionDetail = OverlayRevisionRow.extend({ yaml: z.string() });
export type OverlayRevisionDetail = z.infer<typeof OverlayRevisionDetail>;

export const OverlayValidation = z.object({ ok: z.boolean(), diagnostics: z.array(Diagnostic) });
export type OverlayValidation = z.infer<typeof OverlayValidation>;

export const OverlayPreviewCounts = z.object({ toolCount: z.number().int(), visibleCount: z.number().int(), lintScore: z.number().int().min(0).max(100) });
export type OverlayPreviewCounts = z.infer<typeof OverlayPreviewCounts>;

/** The server's overlay draft. Empty draft = the published YAML (`changeCount: 0`). `etag` is also the `ETag` header. */
export const OverlayDraft = z.object({
  yaml: z.string(),
  basedOnRev: z.number().int().nullable(),
  changeCount: z.number().int().nonnegative(),
  changes: z.array(OverlayChange),
  etag: z.string(),
  validation: OverlayValidation,
  preview: OverlayPreviewCounts,
  /** True when the overlay is file-managed (publish disabled; download and commit instead). */
  fileManaged: z.boolean(),
  updatedAt: IsoDateTime.nullable(),
  updatedBy: Ref.nullable(),
});
export type OverlayDraft = z.infer<typeof OverlayDraft>;

/** Structured ops (comment-preserving AST edits) or a full YAML replacement. Requires `If-Match: <etag>`. */
export const OverlayDraftPatch = z.union([z.object({ ops: z.array(OverlayPatchOp).min(1).max(200) }), z.object({ yaml: z.string().max(2 * 1024 * 1024) })]);
export type OverlayDraftPatch = z.infer<typeof OverlayDraftPatch>;

export const OverlayPublish = z.object({
  message: z.string().min(1).max(500),
  /** Environment ids to pin the new build to; default: the server's dev/qa environments (prod never by default). */
  pinTo: z.array(Id).optional(),
});
export type OverlayPublish = z.infer<typeof OverlayPublish>;

export const OverlayPublishResult = z.object({ revision: OverlayRevisionRow, build: BuildRow, pinnedEnvironments: z.array(z.object({ id: Id, slug: z.string() })) });
export type OverlayPublishResult = z.infer<typeof OverlayPublishResult>;

export const OverlayRevert = z.object({ toRev: z.number().int().min(1), message: z.string().min(1).max(500).optional() });
export type OverlayRevert = z.infer<typeof OverlayRevert>;

/** `rev` number or `draft`. */
export const OverlayRevRef = z.union([z.literal('draft'), z.coerce.number().int().min(0)]);
export const OverlayDiffQuery = z.object({ from: OverlayRevRef, to: OverlayRevRef });
export type OverlayDiffQuery = z.infer<typeof OverlayDiffQuery>;

export const OverlayDiff = z.object({ fromYaml: z.string(), toYaml: z.string(), toolChanges: z.array(z.object({ toolName: z.string(), fields: z.array(z.string()) })) });
export type OverlayDiff = z.infer<typeof OverlayDiff>;

export const OverlayDownloadQuery = z.object({ rev: z.coerce.number().int().min(1).optional() });

export const OverlayValidateBody = z.object({ serverId: Id, yaml: z.string().max(2 * 1024 * 1024) });
export const OverlayValidateResult = OverlayValidation.extend({ preview: OverlayPreviewCounts.nullable() });
export type OverlayValidateResult = z.infer<typeof OverlayValidateResult>;

/** What the agent sees for one tool: the exact `tools/list` entry and the Python stub. */
export const AgentView = z.object({ mcp: z.record(z.string(), z.unknown()), python: z.string() });
export type AgentView = z.infer<typeof AgentView>;

export const OverlayToolPreviewBody = z.object({ toolName: z.string().min(1), ops: z.array(OverlayPatchOp).max(50).optional() });
export type OverlayToolPreviewBody = z.infer<typeof OverlayToolPreviewBody>;

/** Effective definition with draft (+ ops) applied, a shaped sample and token estimates (A43: bytes / 4). */
export const OverlayToolPreview = z.object({
  agentView: AgentView,
  sample: z.object({ before: z.unknown(), after: z.unknown(), source: z.enum(['mock', 'example']) }),
  tokens: z.object({ definition: TokenEstimate, sampleBefore: TokenEstimate, sampleAfter: TokenEstimate, estimated: z.literal(true) }),
  diagnostics: z.array(Diagnostic),
});
export type OverlayToolPreview = z.infer<typeof OverlayToolPreview>;

const ServerIdParams = z.object({ id: Id });

export const overlayEndpoints = {
  getDraft: endpoint({
    method: 'GET', path: '/api/servers/:id/overlay/draft', kind: 'json', access: ['tools:read'],
    summary: 'Overlay draft (ETag header = etag)', params: ServerIdParams, response: OverlayDraft,
  }),
  updateDraft: endpoint({
    method: 'PATCH', path: '/api/servers/:id/overlay/draft', kind: 'json', access: ['overlays:write'],
    summary: 'Apply patch ops or replace the draft YAML (If-Match required; 409 draft_conflict; 422 overlay_invalid)', params: ServerIdParams, body: OverlayDraftPatch, response: OverlayDraft,
  }),
  discardDraft: endpoint({
    method: 'DELETE', path: '/api/servers/:id/overlay/draft', kind: 'empty', access: ['overlays:write'],
    summary: 'Discard the draft', params: ServerIdParams,
  }),
  publish: endpoint({
    method: 'POST', path: '/api/servers/:id/overlay/publish', kind: 'json', access: ['overlays:write'],
    summary: 'Publish the draft as a new overlay revision and build (If-Match required; 409 draft_conflict / config_managed; 422 build_failed)', params: ServerIdParams, body: OverlayPublish, response: OverlayPublishResult,
  }),
  versions: endpoint({
    method: 'GET', path: '/api/servers/:id/overlay/versions', kind: 'json', access: ['tools:read'],
    summary: 'Published overlay revisions (newest first)', params: ServerIdParams, query: CursorQuery, response: Page(OverlayRevisionRow),
  }),
  getVersion: endpoint({
    method: 'GET', path: '/api/overlays/:id', kind: 'json', access: ['tools:read'],
    summary: 'One overlay revision with its YAML', params: IdParams, response: OverlayRevisionDetail,
  }),
  diff: endpoint({
    method: 'GET', path: '/api/servers/:id/overlay/diff', kind: 'json', access: ['tools:read'],
    summary: 'YAML and per-tool diff between two revisions or the draft', params: ServerIdParams, query: OverlayDiffQuery, response: OverlayDiff,
  }),
  revert: endpoint({
    method: 'POST', path: '/api/servers/:id/overlay/revert', kind: 'json', access: ['overlays:write'],
    summary: 'Publish an older revision as a new revision (source: revert)', params: ServerIdParams, body: OverlayRevert, response: OverlayPublishResult,
  }),
  download: endpoint({
    method: 'GET', path: '/api/servers/:id/overlay/download', kind: 'download', access: ['tools:read'],
    summary: 'Download overlay.yaml (text/yaml; latest revision unless ?rev=)', params: ServerIdParams, query: OverlayDownloadQuery,
  }),
  validate: endpoint({
    method: 'POST', path: '/api/overlays/validate', kind: 'json', access: ['tools:read'],
    summary: 'Validate overlay YAML against a server (no side effects)', body: OverlayValidateBody, response: OverlayValidateResult,
  }),
  preview: endpoint({
    method: 'POST', path: '/api/servers/:id/overlay/preview', kind: 'json', access: ['tools:read'],
    summary: 'Preview one tool with the draft (+ ops) applied: agent view, shaped sample, token estimates (allowed in demo)', params: ServerIdParams, body: OverlayToolPreviewBody, response: OverlayToolPreview,
  }),
} as const;
