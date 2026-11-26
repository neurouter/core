import * as z from 'zod';
import { ConfigMode, JobKind, JobStatus, KillSwitchKind, KillSwitchScope, Role, UserStatus } from '../domain/index.js';
import { CodeLimits } from '../config/limits.js';
import { EvalEffort } from '../config/neurouter-yaml.js';
import { Diagnostic } from '../domain/tool-model.js';
import { CursorQuery, Id, IdParams, IsoDateTime, Items, Page, Ref, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';

/* ------------------------------------------------------------------ settings (§14.13) */


export const DEFAULT_EVAL_MODEL = 'claude-sonnet-5-5';

export const ExecutorStatus = z.object({
  mode: z.enum(['embedded', 'remote', 'local', 'off']),
  ok: z.boolean(),
  montyVersion: z.string().nullable(),
  poolMax: z.number().int(),
  busy: z.number().int(),
  detail: z.string().nullable().optional(),
});
export type ExecutorStatus = z.infer<typeof ExecutorStatus>;

export const Settings = z.object({
  general: z.object({ orgName: z.string(), publicUrl: z.string(), retentionDays: z.number().int() }),
  models: z.object({
    anthropicKey: z.object({ configured: z.boolean(), source: z.enum(['env', 'stored']).nullable(), last4: z.string().nullable() }),
    evalModel: z.string(),
    judgeModel: z.string(),
    generatorModel: z.string(),
    effort: EvalEffort,
    fallbacks: z.enum(['default', 'off']),
    labelInferredTasks: z.boolean(),
  }),
  codeMode: z.object({ enabled: z.boolean(), executor: ExecutorStatus, defaults: CodeLimits }),
  retention: z.object({ auditDays: z.number().int(), taskDays: z.number().int() }),
  telemetry: z.object({ otelEnabled: z.boolean(), metricsEnabled: z.boolean(), otlpEndpoint: z.string().nullable() }),
  discovery: z.object({ nativeSearchClients: z.array(z.string()) }),
  audit: z.object({ storeOutputs: z.boolean() }),
  /** Dotted setting keys set by neurouter.yaml (read-only in the console; 409 config_managed). */
  fileManaged: z.array(z.string()),
});
export type Settings = z.infer<typeof Settings>;

/** Sectioned partial update; `models.anthropicKey` is write-only. */
export const SettingsPatch = z.object({
  general: z.object({ orgName: z.string().min(1).max(100), retentionDays: z.number().int().min(1).max(3650) }).partial().optional(),
  models: z
    .object({
      anthropicKey: z.union([z.object({ value: z.string().min(8).max(512) }), z.object({ clear: z.literal(true) })]),
      evalModel: z.string().min(1),
      judgeModel: z.string().min(1),
      generatorModel: z.string().min(1),
      effort: EvalEffort,
      fallbacks: z.enum(['default', 'off']),
      labelInferredTasks: z.boolean(),
    })
    .partial()
    .optional(),
  codeMode: z.object({ enabled: z.boolean(), defaults: CodeLimits.partial() }).partial().optional(),
  retention: z.object({ auditDays: z.number().int().min(1).max(3650), taskDays: z.number().int().min(1).max(3650) }).partial().optional(),
  discovery: z.object({ nativeSearchClients: z.array(z.string().max(200)).max(50) }).partial().optional(),
  audit: z.object({ storeOutputs: z.boolean() }).partial().optional(),
});
export type SettingsPatch = z.infer<typeof SettingsPatch>;

export const ModelTestResult = z.object({ ok: z.boolean(), model: z.string(), latencyMs: z.number().int().nullable(), error: z.string().optional() });
export type ModelTestResult = z.infer<typeof ModelTestResult>;

export const settingsEndpoints = {
  get: endpoint({
    method: 'GET', path: '/api/settings', kind: 'json', access: ['settings:read'],
    summary: 'Instance settings', response: Settings,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/settings', kind: 'json', access: ['settings:write'],
    summary: 'Update settings by section (409 config_managed for file-set fields)', body: SettingsPatch, response: Settings,
  }),
  testModel: endpoint({
    method: 'POST', path: '/api/settings/models/test', kind: 'json', access: ['settings:write'],
    summary: 'One tiny Messages call with the configured key (412 llm_key_missing)', response: ModelTestResult,
  }),
} as const;

/* ------------------------------------------------------------------ model providers (§14.15, A44) */

export const ModelProvider = z.object({
  id: Id,
  kind: z.literal('anthropic'),
  name: z.string(),
  /** `env` providers come from ANTHROPIC_API_KEY and cannot be deleted. */
  keySource: z.enum(['env', 'stored']),
  keyLast4: z.string().nullable(),
  defaultModel: z.string(),
  models: z.array(z.string()),
  isDefault: z.boolean(),
  lastTestAt: IsoDateTime.nullable(),
  lastTestOk: z.boolean().nullable(),
});
export type ModelProvider = z.infer<typeof ModelProvider>;

export const ModelProviderCreate = z.object({ kind: z.literal('anthropic'), name: z.string().min(1).max(100), apiKey: z.string().min(8).max(512), defaultModel: z.string().min(1).default(DEFAULT_EVAL_MODEL) });
export const ModelProviderPatch = z.object({ name: z.string().min(1).max(100).optional(), apiKey: z.string().min(8).max(512).optional(), defaultModel: z.string().min(1).optional() });

export const modelProviderEndpoints = {
  list: endpoint({
    method: 'GET', path: '/api/settings/model-providers', kind: 'json', access: ['settings:read'],
    summary: 'Model providers (MVP: one Anthropic provider)', response: Items(ModelProvider),
  }),
  create: endpoint({
    method: 'POST', path: '/api/settings/model-providers', kind: 'json', status: 201, access: ['settings:write'],
    summary: 'Add the Anthropic provider (409 when one exists)', body: ModelProviderCreate, response: ModelProvider,
  }),
  update: endpoint({
    method: 'PATCH', path: '/api/settings/model-providers/:id', kind: 'json', access: ['settings:write'],
    summary: 'Update a provider (key write-only)', params: IdParams, body: ModelProviderPatch, response: ModelProvider,
  }),
  delete: endpoint({
    method: 'DELETE', path: '/api/settings/model-providers/:id', kind: 'empty', access: ['settings:write'],
    summary: 'Delete a stored provider (env providers cannot be deleted)', params: IdParams,
  }),
  test: endpoint({
    method: 'POST', path: '/api/settings/model-providers/:id/test', kind: 'json', access: ['settings:write'],
    summary: 'Test a provider (= settings.testModel)', params: IdParams, response: ModelTestResult,
  }),
} as const;

export const TelemetryTestResult = z.object({ ok: z.boolean(), otlpEndpoint: z.string().nullable(), detail: z.string() });
export const telemetryEndpoints = {
  test: endpoint({
    method: 'POST', path: '/api/settings/telemetry/test', kind: 'json', access: ['settings:write'],
    summary: 'Emit one test span and log record (ok: false when the OTel SDK is disabled; demo: no-op)', response: TelemetryTestResult,
  }),
} as const;

/* ------------------------------------------------------------------ kill switches */

export const KillSwitchRow = z.object({
  scope: KillSwitchScope,
  /** id, or `server/env/tool` for tool scope; `*` for global. */
  target: z.string(),
  kind: KillSwitchKind,
  reason: z.string(),
  createdBy: Ref.nullable(),
  createdAt: IsoDateTime,
});
export type KillSwitchRow = z.infer<typeof KillSwitchRow>;

export const KillSwitchSet = z.object({ scope: KillSwitchScope, target: z.string().min(1).max(300), kind: KillSwitchKind, reason: z.string().min(1).max(500) });
export const KillSwitchClearQuery = z.object({ scope: KillSwitchScope, target: z.string().min(1), kind: KillSwitchKind });

export const killSwitchEndpoints = {
  list: endpoint({ method: 'GET', path: '/api/kill-switches', kind: 'json', access: ['settings:read'], summary: 'Active kill switches', response: Items(KillSwitchRow) }),
  set: endpoint({ method: 'PUT', path: '/api/kill-switches', kind: 'json', access: ['settings:write'], summary: 'Set a kill switch', body: KillSwitchSet, response: KillSwitchRow }),
  clear: endpoint({ method: 'DELETE', path: '/api/kill-switches', kind: 'empty', access: ['settings:write'], summary: 'Clear a kill switch', query: KillSwitchClearQuery }),
} as const;

/* ------------------------------------------------------------------ config (neurouter.yaml) */

export const ConfigStatus = z.object({
  mode: ConfigMode,
  path: z.string().nullable(),
  hash: z.string().nullable(),
  appliedAt: IsoDateTime.nullable(),
  status: z.enum(['ok', 'error', 'none']),
  diagnostics: z.array(Diagnostic),
  managed: z.object({ servers: z.number().int(), environments: z.number().int() }),
});
export type ConfigStatus = z.infer<typeof ConfigStatus>;

export const ConfigValidateBody = z.object({ yaml: z.string().max(4 * 1024 * 1024) });
export const ConfigValidateResult = z.object({ ok: z.boolean(), diagnostics: z.array(Diagnostic) });
export type ConfigValidateResult = z.infer<typeof ConfigValidateResult>;

export const configEndpoints = {
  status: endpoint({ method: 'GET', path: '/api/config', kind: 'json', access: ['settings:read'], summary: 'neurouter.yaml sync status', response: ConfigStatus }),
  reload: endpoint({ method: 'POST', path: '/api/config/reload', kind: 'json', access: ['settings:write'], summary: 'Re-read and reconcile neurouter.yaml (422 diagnostics)', response: ConfigStatus }),
  export: endpoint({ method: 'GET', path: '/api/config/export', kind: 'download', access: ['settings:read'], summary: 'Current state as neurouter.yaml (secret refs only)' }),
  validate: endpoint({ method: 'POST', path: '/api/config/validate', kind: 'json', access: ['settings:read'], summary: 'Validate a neurouter.yaml (no side effects)', body: ConfigValidateBody, response: ConfigValidateResult }),
} as const;

/* ------------------------------------------------------------------ system, users, jobs, events */

export const SystemInfo = z.object({
  version: z.string(),
  commit: z.string().nullable(),
  nodeVersion: z.string(),
  db: z.object({ dialect: z.enum(['sqlite', 'postgres']), version: z.string().nullable() }),
  executor: ExecutorStatus,
  embedder: z.object({ status: z.enum(['ready', 'loading', 'disabled', 'error']), model: z.string().nullable() }),
  coordination: z.enum(['memory', 'postgres']),
  instanceId: z.string(),
  publicUrl: z.string(),
  protocolVersions: z.array(z.string()),
});
export type SystemInfo = z.infer<typeof SystemInfo>;

export const UserRow = z.object({
  id: Id,
  email: z.string(),
  name: z.string(),
  role: Role,
  roleSource: z.enum(['local', 'oidc', 'bootstrap']),
  status: UserStatus,
  lastLoginAt: IsoDateTime.nullable(),
  createdAt: IsoDateTime,
});
export type UserRow = z.infer<typeof UserRow>;
export const UserPatch = z.object({ role: Role.optional(), status: UserStatus.optional() });

export const Job = z.object({
  id: Id,
  kind: JobKind,
  status: JobStatus,
  progress: z.number().min(0).max(1).nullable(),
  result: z.unknown().nullable(),
  error: z.string().nullable(),
  /** Problem-like error details (e.g. spec_fetch_failed with reason, spec_invalid with diagnostics). */
  problem: z.record(z.string(), z.unknown()).nullable().optional(),
  createdAt: IsoDateTime,
  finishedAt: IsoDateTime.nullable(),
});
export type Job = z.infer<typeof Job>;

/** SSE event names on `/api/events/stream` (§12.3). */
export const EventTopic = z.enum(['tasks', 'calls', 'evals', 'inbox']);
export const SseEvent = z.discriminatedUnion('event', [
  z.object({ event: z.literal('task.updated'), data: z.object({ taskId: Id }) }),
  z.object({ event: z.literal('call.recorded'), data: z.object({ auditId: Id, taskId: Id.nullable() }) }),
  z.object({ event: z.literal('eval.progress'), data: z.object({ runId: Id, done: z.number().int(), total: z.number().int(), status: z.string().optional() }) }),
  z.object({ event: z.literal('inbox.changed'), data: z.object({}) }),
]);
export type SseEvent = z.infer<typeof SseEvent>;

export const systemEndpoints = {
  info: endpoint({ method: 'GET', path: '/api/system/info', kind: 'json', access: ['settings:read'], summary: 'Version, DB, executor, embedder', response: SystemInfo }),
} as const;

export const userEndpoints = {
  list: endpoint({ method: 'GET', path: '/api/users', kind: 'json', access: ['settings:read'], summary: 'Console users', query: CursorQuery.extend({ q: queryOptional(z.string().max(200)) }), response: Page(UserRow) }),
  update: endpoint({ method: 'PATCH', path: '/api/users/:id', kind: 'json', access: ['settings:write'], summary: 'Change role or status (409 last admin)', params: IdParams, body: UserPatch, response: UserRow }),
} as const;

export const jobEndpoints = {
  get: endpoint({ method: 'GET', path: '/api/jobs/:id', kind: 'json', access: ['user'], summary: 'Async job status', params: IdParams, response: Job }),
} as const;

export const eventEndpoints = {
  stream: endpoint({
    method: 'GET', path: '/api/events/stream', kind: 'sse', access: ['tasks:read'],
    summary: 'Live updates (SSE): task.updated, call.recorded, eval.progress, inbox.changed', query: z.object({ topics: queryOptional(z.string().max(100)) }),
  }),
} as const;
