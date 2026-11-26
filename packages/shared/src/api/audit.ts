import * as z from 'zod';
import { AuditDecision, AuditKind, AuditStatus, CallMode, ConfirmKind, EnvironmentKind, Via } from '../domain/enums.js';
import { ClientInfo, CursorQuery, Id, IdParams, IsoDateTime, IsoDateTimeInput, JobAccepted, JsonObject, Page, PrincipalView, SlugRef, SortOrder, queryArray, queryOptional, timeRangeIssue } from './common.js';
import { endpoint } from './endpoint.js';
import { PolicyStep } from './tasks.js';

/* ------------------------------------------------------------------ audit (§14.12, ADAPT Hub) */

export const AuditRow = z.object({
  id: Id,
  seq: z.number().int().nonnegative(),
  ts: IsoDateTime,
  kind: AuditKind,
  principal: PrincipalView.nullable(),
  client: ClientInfo.nullable(),
  server: SlugRef.nullable(),
  environment: SlugRef.extend({ kind: EnvironmentKind }).nullable(),
  tool: z.string().nullable(),
  via: Via.nullable(),
  mode: CallMode.nullable(),
  decision: AuditDecision,
  decisionReason: z.string().nullable(),
  status: AuditStatus,
  write: z.boolean(),
  dryRun: z.boolean(),
  confirm: ConfirmKind,
  latencyMs: z.number().int().nullable(),
  errorId: z.string().nullable(),
  errorMessage: z.string().nullable(),
  taskId: Id.nullable(),
  scriptRunId: Id.nullable(),
  traceId: z.string().nullable(),
  /** `admin_action` rows: e.g. `servers.update`. */
  action: z.string().nullable(),
});
export type AuditRow = z.infer<typeof AuditRow>;

export const AuditDetail = AuditRow.extend({
  params: z.unknown().nullable(),
  outputPreview: z.unknown().nullable(),
  outputSize: z.number().int().nullable(),
  outputHash: z.string().nullable(),
  upstreamStatus: z.number().int().nullable(),
  upstreamLatencyMs: z.number().int().nullable(),
  policyTrail: z.array(PolicyStep),
  changes: z.object({ before: JsonObject.nullable(), after: JsonObject.nullable() }).nullable(),
  target: z.object({ type: z.string(), id: z.string() }).nullable(),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  spanId: z.string().nullable(),
  protocolVersion: z.string().nullable(),
  chain: z.object({ seq: z.number().int(), prevHash: z.string(), hash: z.string() }),
});
export type AuditDetail = z.infer<typeof AuditDetail>;

const AuditFilterFields = z.object({
  from: queryOptional(IsoDateTimeInput),
  to: queryOptional(IsoDateTimeInput),
  serverId: queryOptional(Id),
  environmentId: queryOptional(Id),
  kind: queryArray(AuditKind),
  decision: queryArray(AuditDecision),
  status: queryArray(AuditStatus),
  tool: queryOptional(z.string().max(64)),
  /** API key id, user id or external subject. */
  principal: queryOptional(z.string().max(200)),
  taskId: queryOptional(Id),
  scriptRunId: queryOptional(Id),
  via: queryOptional(Via),
  q: queryOptional(z.string().max(200)),
  order: queryOptional(SortOrder),
});

/** Time range defaults to the last 24 h; at most 90 days. */
const checkRange = (q: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) => {
  if (q.from && q.to) {
    const issue = timeRangeIssue(q.from, q.to);
    if (issue) ctx.addIssue({ code: 'custom', path: ['to'], message: issue });
  }
};

export const AuditQuery = CursorQuery.extend(AuditFilterFields.shape).superRefine(checkRange);
export type AuditQuery = z.infer<typeof AuditQuery>;

export const AuditExportQuery = AuditFilterFields.extend({ format: z.enum(['ndjson', 'csv']).default('ndjson') }).superRefine(checkRange);
export type AuditExportQuery = z.infer<typeof AuditExportQuery>;

export const AuditVerifyBody = z.object({ from: IsoDateTimeInput.optional(), to: IsoDateTimeInput.optional() });

/** COPY Hub shape. */
export const AuditVerifyResult = z.object({
  ok: z.boolean(),
  checked: z.number().int(),
  fromSeq: z.number().int().nullable(),
  toSeq: z.number().int().nullable(),
  checkpointsVerified: z.number().int(),
  firstBrokenSeq: z.number().int().nullable(),
  reason: z.string().nullable(),
});
export type AuditVerifyResult = z.infer<typeof AuditVerifyResult>;

export const auditEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/audit', kind: 'json', access: ['audit:read'],
    summary: 'Audit log (default last 24 h, max 90 days)', query: AuditQuery, response: Page(AuditRow),
  }),
  export: endpoint({
    method: 'GET', path: '/api/audit/export', kind: 'download', access: ['audit:read'],
    summary: 'Export as NDJSON or CSV (≤ 100k rows; X-Truncated header)', query: AuditExportQuery,
  }),
  verify: endpoint({
    method: 'POST', path: '/api/audit/verify', kind: 'json', status: 202, access: ['audit:read'],
    summary: 'Verify the hash chain and checkpoints (job result: AuditVerifyResult)', body: AuditVerifyBody, response: JobAccepted,
  }),
  get: endpoint({
    method: 'GET', path: '/api/audit/:id', kind: 'json', access: ['audit:read'],
    summary: 'One audit event with its policy trail and chain hashes', params: IdParams, response: AuditDetail,
  }),
} as const;
