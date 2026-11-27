import * as z from 'zod';

/**
 * Domain enums shared by the server (DB CHECK constraints, services) and the console.
 * Each enum is a zod schema plus its inferred type (`X.options` is the value list).
 */

export const ServerKind = z.enum(['openapi', 'graphql']);
export type ServerKind = z.infer<typeof ServerKind>;

export const SpecFormat = z.enum(['openapi-3.0', 'openapi-3.1', 'graphql-sdl', 'graphql-introspection']);
export type SpecFormat = z.infer<typeof SpecFormat>;

/** User-facing spec format hint (`spec.format` in neurouter.yaml). */
export const SpecFormatHint = z.enum(['openapi', 'graphql-sdl', 'graphql-introspection']);
export type SpecFormatHint = z.infer<typeof SpecFormatHint>;

export const ResourceStatus = z.enum(['active', 'disabled', 'removed_from_config']);
export type ResourceStatus = z.infer<typeof ResourceStatus>;

export const ManagedBy = z.enum(['file', 'console']);
export type ManagedBy = z.infer<typeof ManagedBy>;

export const ConfigMode = z.enum(['file', 'hybrid', 'console']);
export type ConfigMode = z.infer<typeof ConfigMode>;

export const EnvironmentKind = z.enum(['dev', 'qa', 'prod']);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;

export const ExposureMode = z.enum(['auto', 'tools', 'code', 'both']);
export type ExposureMode = z.infer<typeof ExposureMode>;

export const DiscoveryMode = z.enum(['auto', 'full', 'search']);
export type DiscoveryMode = z.infer<typeof DiscoveryMode>;
/**
 * Agent contract version (contract-v2 §1): 1 = the 0.2.x response shapes, 2 = one envelope
 * `{ok,data,page,truncated,error,state}` for every tool result. Negotiated per session; this is the default.
 */
export const ContractVersion = z.union([z.literal(1), z.literal(2)]);
export type ContractVersion = z.infer<typeof ContractVersion>;
/** Contract versions this release can serve, highest first. */
export const CONTRACT_VERSIONS: readonly ContractVersion[] = [2, 1];
/**
 * `outputSchema` in tools/list (contract-v2 §2.5, D3): `envelope` = the shared envelope schema with an open
 * `data` (default), `none`, or `typed` (the shaped upstream schema as `data`, validated before sending).
 * Contract 1 lists per-tool schemas only for `typed`.
 */
export const OutputSchemaMode = z.enum(['envelope', 'none', 'typed']);
export type OutputSchemaMode = z.infer<typeof OutputSchemaMode>;

/**
 * Write confirmation (backend §9.7), for any environment kind (`none` is invalid on prod):
 * - `elicit` (prod default): the user approves each write in the client (MCP elicitation). A client
 *   that cannot ask gets the planned change back, not executed (scripts: their dry-run plan), so the
 *   user can review it and run it from an elicitation-capable client.
 * - `deny_without_elicitation`: same prompt, but a client that cannot ask is refused outright with
 *   no planned-change details.
 * No mode lets the agent confirm its own writes.
 */
export const ConfirmMode = z.enum(['none', 'elicit', 'deny_without_elicitation']);
export type ConfirmMode = z.infer<typeof ConfirmMode>;

export const UpstreamAuthType = z.enum(['none', 'bearer', 'header', 'query', 'basic', 'oauth_passthrough', 'oauth_client_credentials']);
export type UpstreamAuthType = z.infer<typeof UpstreamAuthType>;

export const ToolKind = z.enum(['http', 'graphql', 'composite']);
export type ToolKind = z.infer<typeof ToolKind>;

export const BuildStatus = z.enum(['ok', 'error']);
export type BuildStatus = z.infer<typeof BuildStatus>;

export const OverlaySource = z.enum(['console', 'file', 'suggestion', 'revert']);
export type OverlaySource = z.infer<typeof OverlaySource>;

export const DiagnosticSeverity = z.enum(['error', 'warning', 'info']);
export type DiagnosticSeverity = z.infer<typeof DiagnosticSeverity>;

export const HealthStatus = z.enum(['up', 'down', 'unknown']);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const CredentialState = z.enum(['ok', 'missing', 'not_required']);
export type CredentialState = z.infer<typeof CredentialState>;

/** API key / OAuth scopes (internal names). OAuth: mcp:tools→tools:read, mcp:write→tools:write, mcp:code→code:run. */
export const Scope = z.enum(['tools:read', 'tools:write', 'code:run']);
export type Scope = z.infer<typeof Scope>;
export const OAuthScope = z.enum(['mcp:tools', 'mcp:write', 'mcp:code']);
export type OAuthScope = z.infer<typeof OAuthScope>;
export const OAUTH_SCOPE_MAP: Record<OAuthScope, Scope> = { 'mcp:tools': 'tools:read', 'mcp:write': 'tools:write', 'mcp:code': 'code:run' };

export const ApiKeyPurpose = z.enum(['user', 'eval']);
export type ApiKeyPurpose = z.infer<typeof ApiKeyPurpose>;
export const ApiKeyStatus = z.enum(['active', 'revoked', 'expired']);
export type ApiKeyStatus = z.infer<typeof ApiKeyStatus>;

export const PrincipalType = z.enum(['user', 'api_key', 'external']);
export type PrincipalType = z.infer<typeof PrincipalType>;

export const UserStatus = z.enum(['active', 'disabled']);
export type UserStatus = z.infer<typeof UserStatus>;
export const RoleSource = z.enum(['local', 'oidc', 'bootstrap']);
export type RoleSource = z.infer<typeof RoleSource>;

/* ------------------------------------------------------------------ audit */

export const AuditKind = z.enum(['tools_list', 'tool_search', 'tool_call', 'script_run', 'ops_call', 'admin_action', 'auth_event', 'config_apply', 'eval_run']);
export type AuditKind = z.infer<typeof AuditKind>;

export const AuditDecision = z.enum([
  'allowed',
  'dry_run',
  'confirmed',
  'denied_acl',
  'denied_policy',
  'denied_rate_limit',
  'denied_read_only',
  'denied_disabled',
  'denied_confirmation',
]);
export type AuditDecision = z.infer<typeof AuditDecision>;

export const AuditStatus = z.enum(['ok', 'tool_error', 'upstream_error', 'timeout', 'invalid_args', 'blocked', 'cancelled', 'script_error', 'limit_exceeded']);
export type AuditStatus = z.infer<typeof AuditStatus>;

export function isBlockedDecision(d: AuditDecision): boolean {
  return d.startsWith('denied_');
}

export const Via = z.enum(['direct', 'call_tool', 'script', 'console', 'eval']);
export type Via = z.infer<typeof Via>;

export const CallMode = z.enum(['tool', 'code']);
export type CallMode = z.infer<typeof CallMode>;

export const ConfirmKind = z.enum(['none', 'elicited', 'agent_token']);
export type ConfirmKind = z.infer<typeof ConfirmKind>;

export const PolicyStepName = z.enum(['resolve', 'kill_switch', 'acl', 'read_only', 'arguments', 'policy', 'rate_limit', 'dry_run', 'confirm', 'routing', 'upstream', 'response', 'audit']);
export type PolicyStepName = z.infer<typeof PolicyStepName>;
export const PolicyStepResult = z.enum(['pass', 'fail', 'skip']);
export type PolicyStepResult = z.infer<typeof PolicyStepResult>;

/* ------------------------------------------------------------------ tasks, scripts, ops */

export const TaskOutcome = z.enum(['success', 'partial', 'failure', 'abandoned', 'unknown']);
export type TaskOutcome = z.infer<typeof TaskOutcome>;
export const TaskFraming = z.enum(['explicit', 'inferred', 'script']);
export type TaskFraming = z.infer<typeof TaskFraming>;
export const TaskStatus = z.enum(['open', 'closed']);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const ScriptMode = z.enum(['dry_run', 'execute']);
export type ScriptMode = z.infer<typeof ScriptMode>;
export const ScriptStatus = z.enum([
  'running',
  'ok',
  'script_error',
  'syntax_error',
  'type_error',
  'rejected',
  'limit_exceeded',
  'crashed',
  'cancelled',
  'confirm_declined',
  'executor_unavailable',
]);
export type ScriptStatus = z.infer<typeof ScriptStatus>;

export const NeedGroupStatus = z.enum(['open', 'planned', 'done', 'dismissed']);
export type NeedGroupStatus = z.infer<typeof NeedGroupStatus>;
export const IssueStatus = z.enum(['open', 'acknowledged', 'fixed', 'dismissed']);
export type IssueStatus = z.infer<typeof IssueStatus>;

export const ExampleKind = z.enum(['call', 'script']);
export type ExampleKind = z.infer<typeof ExampleKind>;
export const ExampleSource = z.enum(['overlay', 'spec', 'eval', 'traffic']);
export type ExampleSource = z.infer<typeof ExampleSource>;

export const KillSwitchScope = z.enum(['global', 'server', 'environment', 'tool']);
export type KillSwitchScope = z.infer<typeof KillSwitchScope>;
export const KillSwitchKind = z.enum(['all', 'writes', 'code_mode']);
export type KillSwitchKind = z.infer<typeof KillSwitchKind>;

/* ------------------------------------------------------------------ evals */

export const EvalCategory = z.enum(['single', 'multi', 'ambiguous', 'impossible']);
export type EvalCategory = z.infer<typeof EvalCategory>;
export const EvalSuiteStatus = z.enum(['draft', 'frozen']);
export type EvalSuiteStatus = z.infer<typeof EvalSuiteStatus>;
export const EvalRunStatus = z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled']);
export type EvalRunStatus = z.infer<typeof EvalRunStatus>;
export const EvalTrigger = z.enum(['console', 'cli', 'ci', 'suggestion_verify']);
export type EvalTrigger = z.infer<typeof EvalTrigger>;
export const EvalConfidence = z.enum(['measured', 'preliminary', 'degraded']);
export type EvalConfidence = z.infer<typeof EvalConfidence>;
export const FailureCause = z.enum(['wrong_tool', 'bad_arguments', 'missing_capability', 'gave_up', 'wrong_answer', 'hallucinated', 'policy_blocked', 'no_framing', 'over_budget', 'error', 'provider_refusal']);
export type FailureCause = z.infer<typeof FailureCause>;
export const SuggestionKind = z.enum(['rename', 'describe', 'example', 'hide', 'response_shape', 'composite']);
export type SuggestionKind = z.infer<typeof SuggestionKind>;
export const SuggestionStatus = z.enum(['proposed', 'verifying', 'verified', 'applied', 'dismissed']);
export type SuggestionStatus = z.infer<typeof SuggestionStatus>;
export const ReadinessBand = z.enum(['not_ready', 'needs_work', 'ready', 'excellent']);
export type ReadinessBand = z.infer<typeof ReadinessBand>;
export const ReadinessComponentKey = z.enum(['success', 'efficiency', 'impossible', 'framing', 'quality', 'stability', 'correctness']);
export type ReadinessComponentKey = z.infer<typeof ReadinessComponentKey>;

/** Score bands (A-BANDS): 0–49 not_ready, 50–74 needs_work, 75–89 ready, 90–100 excellent. */
export function readinessBand(score: number): ReadinessBand {
  if (score >= 90) return 'excellent';
  if (score >= 75) return 'ready';
  if (score >= 50) return 'needs_work';
  return 'not_ready';
}

/* ------------------------------------------------------------------ jobs */

export const JobKind = z.enum(['server_import', 'spec_reimport', 'spec_preview', 'audit_verify', 'key_rotation', 'reindex', 'eval_generate', 'eval_run', 'eval_suggest', 'eval_verify']);
export type JobKind = z.infer<typeof JobKind>;
export const JobStatus = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatus>;

export const RedactionRuleType = z.enum(['key', 'regex']);
export type RedactionRuleType = z.infer<typeof RedactionRuleType>;
