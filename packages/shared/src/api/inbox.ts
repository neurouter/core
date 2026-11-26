import * as z from 'zod';
import { EnvironmentKind, IssueStatus, NeedGroupStatus } from '../domain/enums.js';
import { ClientInfo, CursorQuery, Id, IdParams, IsoDateTime, Page, PrincipalView, SlugRef, queryArray, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';
import { CallDetail, TaskRow } from './tasks.js';

/* ------------------------------------------------------------------ ops inbox (§14.10) */

export const InboxSummary = z.object({
  needs: z.object({ open: z.number().int(), new7d: z.number().int() }),
  issues: z.object({ open: z.number().int(), new7d: z.number().int() }),
});
export type InboxSummary = z.infer<typeof InboxSummary>;

export const NeedGroupRow = z.object({
  id: Id,
  label: z.string(),
  server: SlugRef,
  count: z.number().int(),
  distinctPrincipals: z.number().int(),
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  status: NeedGroupStatus,
  note: z.string().nullable(),
  sampleIntents: z.array(z.string()).max(3),
});
export type NeedGroupRow = z.infer<typeof NeedGroupRow>;

export const NeedRow = z.object({
  id: Id,
  groupId: Id,
  intent: z.string(),
  attempted: z.array(z.string()),
  taskId: Id.nullable(),
  environment: SlugRef.extend({ kind: EnvironmentKind }),
  principal: PrincipalView.nullable(),
  client: ClientInfo,
  createdAt: IsoDateTime,
});
export type NeedRow = z.infer<typeof NeedRow>;

export const NeedGroupDetail = NeedGroupRow.extend({
  reports: Page(NeedRow),
  attemptedTools: z.array(z.object({ tool: z.string(), count: z.number().int() })),
  /** Reports per day over the last 30 days (sparkline, frontend G3). */
  daily: z.array(z.object({ day: z.string(), count: z.number().int() })),
});
export type NeedGroupDetail = z.infer<typeof NeedGroupDetail>;

export const NeedGroupListQuery = CursorQuery.extend({
  serverId: queryOptional(Id),
  status: queryArray(NeedGroupStatus),
  q: queryOptional(z.string().max(200)),
  sort: queryOptional(z.enum(['count', 'recent'])),
});
export type NeedGroupListQuery = z.infer<typeof NeedGroupListQuery>;

export const NeedGroupTriage = z.object({ status: NeedGroupStatus.optional(), note: z.string().max(2000).nullable().optional() });
export const NeedGroupMerge = z.object({ intoGroupId: Id });

export const IssueRow = z.object({
  id: Id,
  tool: z.string(),
  problem: z.string(),
  server: SlugRef,
  environment: SlugRef.extend({ kind: EnvironmentKind }),
  taskId: Id.nullable(),
  status: IssueStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  hasFailingCall: z.boolean(),
});
export type IssueRow = z.infer<typeof IssueRow>;

export const IssueDetail = IssueRow.extend({ evidence: z.unknown().nullable(), note: z.string().nullable(), errorId: z.string().nullable(), failingCall: CallDetail.nullable(), task: TaskRow.nullable() });
export type IssueDetail = z.infer<typeof IssueDetail>;

export const IssueListQuery = CursorQuery.extend({ serverId: queryOptional(Id), status: queryArray(IssueStatus), tool: queryOptional(z.string().max(64)), q: queryOptional(z.string().max(200)) });
export type IssueListQuery = z.infer<typeof IssueListQuery>;

export const IssueTriage = z.object({ status: IssueStatus.optional(), note: z.string().max(2000).nullable().optional() });

export const InboxItem = z.object({ kind: z.enum(['need', 'issue']), id: Id, title: z.string(), status: z.string(), createdAt: IsoDateTime, groupId: Id.optional() });
export type InboxItem = z.infer<typeof InboxItem>;

export const MarkdownExport = z.object({ markdown: z.string() });

export const inboxEndpoints = {
  summary: endpoint({
    method: 'GET', path: '/api/inbox/summary', kind: 'json', access: ['inbox:read'],
    summary: 'Open and new needs and issues', query: z.object({ serverId: queryOptional(Id) }), response: InboxSummary,
  }),
  list: endpoint({
    method: 'GET', path: '/api/inbox', kind: 'json', access: ['inbox:read'],
    summary: 'Needs and issues for one tool (tool detail page)', query: CursorQuery.extend({ serverId: queryOptional(Id), toolName: queryOptional(z.string().max(64)) }), response: Page(InboxItem),
  }),
  needGroups: endpoint({
    method: 'GET', path: '/api/inbox/needs', kind: 'json', access: ['inbox:read'],
    summary: 'Unmet-need groups', query: NeedGroupListQuery, response: Page(NeedGroupRow),
  }),
  needGroup: endpoint({
    method: 'GET', path: '/api/inbox/needs/:groupId', kind: 'json', access: ['inbox:read'],
    summary: 'Need group with its reports (paged by cursor)', params: z.object({ groupId: Id }), query: CursorQuery, response: NeedGroupDetail,
  }),
  triageNeedGroup: endpoint({
    method: 'PATCH', path: '/api/inbox/needs/:groupId', kind: 'json', access: ['inbox:triage'],
    summary: 'Set status / note of a need group', params: z.object({ groupId: Id }), body: NeedGroupTriage, response: NeedGroupRow,
  }),
  mergeNeedGroups: endpoint({
    method: 'POST', path: '/api/inbox/needs/:groupId/merge', kind: 'json', access: ['inbox:triage'],
    summary: 'Merge a group into another (returns the target group)', params: z.object({ groupId: Id }), body: NeedGroupMerge, response: NeedGroupRow,
  }),
  splitNeed: endpoint({
    method: 'POST', path: '/api/inbox/needs/reports/:reportId/split', kind: 'json', access: ['inbox:triage'],
    summary: 'Move one report into a new group', params: z.object({ reportId: Id }), response: NeedGroupRow,
  }),
  issues: endpoint({
    method: 'GET', path: '/api/inbox/issues', kind: 'json', access: ['inbox:read'],
    summary: 'Issues reported by agents', query: IssueListQuery, response: Page(IssueRow),
  }),
  issue: endpoint({
    method: 'GET', path: '/api/inbox/issues/:id', kind: 'json', access: ['inbox:read'],
    summary: 'Issue with the failing call and its task', params: IdParams, response: IssueDetail,
  }),
  triageIssue: endpoint({
    method: 'PATCH', path: '/api/inbox/issues/:id', kind: 'json', access: ['inbox:triage'],
    summary: 'Set status / note of an issue', params: IdParams, body: IssueTriage, response: IssueRow,
  }),
  exportNeedMarkdown: endpoint({
    method: 'GET', path: '/api/inbox/needs/:groupId/markdown', kind: 'json', access: ['inbox:read'],
    summary: 'A need group as Markdown (CopyAsMarkdown)', params: z.object({ groupId: Id }), response: MarkdownExport,
  }),
  exportIssueMarkdown: endpoint({
    method: 'GET', path: '/api/inbox/issues/:id/markdown', kind: 'json', access: ['inbox:read'],
    summary: 'An issue as Markdown (CopyAsMarkdown)', params: IdParams, response: MarkdownExport,
  }),
} as const;
