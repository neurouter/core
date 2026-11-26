import * as z from 'zod';
import {
  AuditDecision, AuditStatus, CallMode, ConfirmKind, EnvironmentKind, PolicyStepName, PolicyStepResult, ScriptMode, ScriptStatus, TaskFraming, TaskOutcome, TaskStatus, Via,
} from '../domain/enums.js';
import { ClientInfo, CursorQuery, Id, IdParams, IsoDateTime, Page, PrincipalView, QueryBool, SlugRef, TimeRangeQuery, queryArray, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

/* ------------------------------------------------------------------ shared trace shapes (§12.2, §14.9) */

export const PolicyStep = z.object({ step: PolicyStepName, result: PolicyStepResult, detail: z.string().optional() });
export type PolicyStep = z.infer<typeof PolicyStep>;

export const PlannedChange = z.object({ tool: z.string(), method: z.string().nullable(), path: z.string().nullable(), arguments: z.record(z.string(), z.unknown()), wouldConfirm: z.boolean() });
export type PlannedChange = z.infer<typeof PlannedChange>;

export const TimelineKind = z.enum(['call', 'search', 'script', 'decision', 'unmet_need', 'issue', 'ops', 'task_begin', 'task_end', 'gap', 'tools_list']);
export type TimelineKind = z.infer<typeof TimelineKind>;

export interface TimelineItem {
  id: string;
  kind: TimelineKind;
  ts: string;
  durationMs?: number;
  tool?: string;
  decision?: AuditDecision;
  status?: AuditStatus | ScriptStatus;
  write?: boolean;
  dryRun?: boolean;
  via?: Via;
  summary: string;
  auditId?: string;
  scriptRunId?: string;
  errorId?: string;
  children?: TimelineItem[];
}
export const TimelineItem: z.ZodType<TimelineItem> = z.lazy(() =>
  z.object({
    id: z.string(),
    kind: TimelineKind,
    ts: IsoDateTime,
    durationMs: z.number().int().nonnegative().optional(),
    tool: z.string().optional(),
    decision: AuditDecision.optional(),
    status: z.union([AuditStatus, ScriptStatus]).optional(),
    write: z.boolean().optional(),
    dryRun: z.boolean().optional(),
    via: Via.optional(),
    summary: z.string(),
    auditId: z.string().optional(),
    scriptRunId: z.string().optional(),
    errorId: z.string().optional(),
    children: z.array(TimelineItem).optional(),
  }),
);

/* ------------------------------------------------------------------ tasks */

export const TaskOrigin = z.enum(['agent', 'eval']);
export type TaskOrigin = z.infer<typeof TaskOrigin>;

export const InferredLabel = z.object({ goal: z.string(), outcome: z.enum(['success', 'partial', 'failure', 'unknown']), confidence: z.number().min(0).max(1), model: z.string() });

export const TaskRow = z.object({
  id: Id,
  goal: z.string().nullable(),
  outcome: TaskOutcome.nullable(),
  framing: TaskFraming,
  inferredLabel: InferredLabel.nullable(),
  status: TaskStatus,
  /** `eval` when the task came from an eval run's key (frontend G9). */
  origin: TaskOrigin,
  server: SlugRef,
  environment: SlugRef.extend({ kind: EnvironmentKind }),
  principal: PrincipalView,
  client: ClientInfo,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  durationMs: z.number().int().nullable(),
  callCount: z.number().int(),
  errorCount: z.number().int(),
  writeCount: z.number().int(),
  blockedCount: z.number().int(),
  scriptCount: z.number().int(),
  decisionCount: z.number().int(),
  opsCount: z.number().int(),
});
export type TaskRow = z.infer<typeof TaskRow>;

export const TaskListQuery = CursorQuery.extend(TimeRangeQuery.shape).extend({
  serverId: queryOptional(Id),
  environmentId: queryOptional(Id),
  /** Outcomes; the pseudo value `inferred` filters by framing. */
  outcome: queryArray(z.union([TaskOutcome, z.literal('inferred')])),
  framing: queryArray(TaskFraming),
  status: queryOptional(TaskStatus),
  origin: queryOptional(TaskOrigin),
  /** API key id, user id or external subject. */
  principal: queryOptional(z.string().max(200)),
  client: queryOptional(z.string().max(200)),
  tool: queryOptional(z.string().max(64)),
  q: queryOptional(z.string().max(200)),
  hasErrors: queryOptional(QueryBool),
  hasWrites: queryOptional(QueryBool),
});
export type TaskListQuery = z.infer<typeof TaskListQuery>;

/** Inline need/issue rows on a task (full shapes live in the inbox area). */
export const TaskNeedRef = z.object({ id: Id, groupId: Id, intent: z.string(), createdAt: IsoDateTime });
export const TaskIssueRef = z.object({ id: Id, tool: z.string(), problem: z.string(), status: z.string(), createdAt: IsoDateTime });

export const TaskDetail = TaskRow.extend({
  notes: z.string().nullable(),
  traceId: z.string().nullable(),
  /** First 200 items (tasks.get); page the rest with tasks.events. Capped at 2000 overall. */
  timeline: z.array(TimelineItem),
  truncated: z.boolean(),
  unmetNeeds: z.array(TaskNeedRef),
  issues: z.array(TaskIssueRef),
  evalRunId: Id.nullable(),
});
export type TaskDetail = z.infer<typeof TaskDetail>;

/* ------------------------------------------------------------------ calls, scripts */

export const CallError = z.object({ code: z.string(), title: z.string(), explanation: z.string() });

export const CallDetail = z.object({
  auditId: Id,
  ts: IsoDateTime,
  tool: z.string(),
  toolId: Id.nullable(),
  via: Via,
  mode: CallMode,
  decision: AuditDecision,
  status: AuditStatus,
  write: z.boolean(),
  dryRun: z.boolean(),
  confirm: ConfirmKind,
  policyTrail: z.array(PolicyStep),
  /** Redacted arguments. */
  arguments: z.unknown(),
  /** Redacted, ≤ 8 KiB. */
  outputPreview: z.unknown().nullable(),
  outputSize: z.number().int().nullable(),
  outputHash: z.string().nullable(),
  /** Only when the setting `audit.storeOutputs` is on. */
  upstreamBodyPreview: z.unknown().nullable().optional(),
  latencyMs: z.number().int().nullable(),
  upstreamLatencyMs: z.number().int().nullable(),
  upstreamStatus: z.number().int().nullable(),
  errorId: z.string().nullable(),
  error: CallError.nullable(),
  traceId: z.string().nullable(),
  spanId: z.string().nullable(),
  taskId: Id.nullable(),
  scriptRunId: Id.nullable(),
  server: SlugRef.nullable(),
  environment: SlugRef.extend({ kind: EnvironmentKind }).nullable(),
  client: ClientInfo,
  principal: PrincipalView.nullable(),
});
export type CallDetail = z.infer<typeof CallDetail>;

export const ScriptError = z.object({ type: z.string(), message: z.string(), line: z.number().int().nullable().optional(), col: z.number().int().nullable().optional(), hint: z.string().nullable().optional(), traceback: z.string().optional() });
export const ScriptStats = z.object({ wallMs: z.number().int(), cpuMs: z.number().int().optional(), toolCalls: z.number().int(), blockedCalls: z.number().int(), peakMemoryBytes: z.number().int().optional(), suspensions: z.number().int() });
export const ScriptPhase = z.object({ name: z.enum(['validate', 'type_check', 'execute']), status: z.enum(['ok', 'failed', 'skipped']), durationMs: z.number().int().nullable() });

export const ScriptRunDetail = z.object({
  id: Id,
  taskId: Id.nullable(),
  server: SlugRef,
  environment: SlugRef.extend({ kind: EnvironmentKind }),
  mode: ScriptMode,
  status: ScriptStatus,
  code: z.string(),
  codeHash: z.string(),
  error: ScriptError.nullable(),
  resultPreview: z.unknown().nullable(),
  resultBytes: z.number().int().nullable(),
  resultHandle: z.string().nullable(),
  stdout: z.string().nullable(),
  plannedChanges: z.array(PlannedChange),
  stats: ScriptStats.nullable(),
  phases: z.array(ScriptPhase),
  calls: z.array(TimelineItem),
  auditId: Id.nullable(),
  traceId: z.string().nullable(),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable(),
  /** Runs with the same code hash (recipes). */
  recipeCount: z.number().int(),
});
export type ScriptRunDetail = z.infer<typeof ScriptRunDetail>;

export const taskEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/tasks', kind: 'json', access: ['tasks:read'],
    summary: 'Tasks (newest first; default last 24 h)', query: TaskListQuery, response: Page(TaskRow),
  }),
  get: endpoint({
    method: 'GET', path: '/api/tasks/:id', kind: 'json', access: ['tasks:read'],
    summary: 'Task with its timeline (script inner calls nested)', params: IdParams, response: TaskDetail,
  }),
  events: endpoint({
    method: 'GET', path: '/api/tasks/:id/events', kind: 'json', access: ['tasks:read'],
    summary: 'Task timeline, paged (ordered by ts)', params: IdParams, query: CursorQuery, response: Page(TimelineItem),
  }),
} as const;

export const callEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/calls/:auditId', kind: 'json', access: ['tasks:read'],
    summary: 'One tool call with its policy trail', params: z.object({ auditId: Id }), response: CallDetail,
  }),
} as const;

export const scriptEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/scripts/:id', kind: 'json', access: ['tasks:read'],
    summary: 'One run_script execution with phases, planned changes and inner calls', params: IdParams, response: ScriptRunDetail,
  }),
} as const;
