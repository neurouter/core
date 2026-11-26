// Kysely table types (backend spec §7). GENERATED from the migrations by apps/server/src/scripts/gen-schema.ts;
// `schema.test.ts` applies all migrations to SQLite and PGlite and fails on drift.
import type { ColumnType, Generated } from 'kysely';

/** 0/1 integers on both dialects. */
export type BoolColumn = 0 | 1;
export type { ColumnType, Generated };

export interface TenantsTable {
  id: string;
  slug: string;
  name: string;
  created_at: number;
}

export interface UsersTable {
  id: string;
  tenant_id: string;
  email: string;
  name: Generated<string>;
  oidc_issuer: string | null;
  oidc_subject: string | null;
  role: Generated<'admin' | 'viewer'>;
  role_source: Generated<'local' | 'oidc' | 'bootstrap'>;
  status: Generated<'active' | 'disabled'>;
  last_login_at: number | null;
  preferences: Generated<string>;
  created_at: number;
  updated_at: number;
}

export interface WebSessionsTable {
  id_hash: Buffer;
  tenant_id: Generated<string>;
  user_id: string;
  csrf_token: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
  id_token_hint: string | null;
  anonymous: Generated<BoolColumn>;
}

export interface OidcLoginStatesTable {
  state_hash: Buffer;
  tenant_id: Generated<string>;
  code_verifier_enc: Buffer;
  nonce: string;
  return_to: string;
  expires_at: number;
}

export interface LocalLinksTable {
  token_hash: Buffer;
  tenant_id: Generated<string>;
  user_id: string;
  expires_at: number;
  used_at: number | null;
  created_at: number;
}

export interface SettingsTable {
  tenant_id: string;
  key: string;
  value: string;
  updated_by: string | null;
  updated_at: number;
}

export interface EncryptionKeysTable {
  id: string;
  tenant_id: Generated<string>;
  kek_id: string;
  wrapped_key: Buffer;
  status: 'active' | 'retired';
  created_at: number;
}

export interface SecretsTable {
  id: string;
  tenant_id: string;
  purpose: string;
  owner_type: 'environment' | 'settings' | 'oauth_client' | null;
  owner_id: string | null;
  name: string | null;
  provider: Generated<'builtin'>;
  external_ref: string | null;
  dek_id: string | null;
  nonce: Buffer | null;
  ciphertext: Buffer | null;
  version: Generated<number>;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface RedactionRulesTable {
  id: string;
  tenant_id: Generated<string>;
  name: string;
  type: 'key' | 'regex';
  pattern: string;
  replacement: string;
  enabled: Generated<BoolColumn>;
  order: number;
  builtin: Generated<BoolColumn>;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface LeasesTable {
  name: string;
  holder: string;
  expires_at: number;
}

export interface CoordSignalsTable {
  channel: string;
  payload: string;
  created_at: number;
}

export interface JobsTable {
  id: string;
  tenant_id: string;
  kind: string;
  status: 'queued' | 'running' | 'ok' | 'error';
  params: string | null;
  progress: number | null;
  result: string | null;
  error: string | null;
  created_by: string | null;
  created_at: number;
  finished_at: number | null;
}

export interface RateLimitBucketsTable {
  key: string;
  tokens: number;
  capacity: number;
  refill_per_ms: number;
  updated_at: number;
}

export interface ServersTable {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: Generated<string>;
  kind: 'openapi' | 'graphql';
  spec_source: Generated<string>;
  exposure: Generated<string>;
  ops_tools: Generated<string>;
  public_report: Generated<BoolColumn>;
  overlay_path: string | null;
  current_spec_revision_id: string | null;
  published_overlay_revision_id: string | null;
  latest_build_id: string | null;
  status: Generated<'active' | 'disabled' | 'removed_from_config'>;
  managed_by: Generated<'file' | 'console'>;
  config_path: string | null;
  config_line: number | null;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}

export interface SpecRevisionsTable {
  id: string;
  tenant_id: string;
  server_id: string;
  rev: number;
  format: 'openapi-3.0' | 'openapi-3.1' | 'graphql-sdl' | 'graphql-introspection';
  source_url: string | null;
  content_type: string | null;
  content_hash: string;
  content: Buffer;
  content_bytes: number;
  title: Generated<string>;
  api_version: string | null;
  operation_count: Generated<number>;
  summary: Generated<string>;
  created_by: string | null;
  created_at: number;
}

export interface OverlayRevisionsTable {
  id: string;
  tenant_id: string;
  server_id: string;
  rev: number;
  yaml: string;
  hash: string;
  message: Generated<string>;
  source: 'console' | 'file' | 'suggestion' | 'revert';
  based_on_rev: number | null;
  created_by: string | null;
  created_at: number;
}

export interface OverlayDraftsTable {
  server_id: string;
  tenant_id: string;
  yaml: string;
  based_on_rev: number | null;
  change_count: Generated<number>;
  changes: Generated<string>;
  updated_by: string | null;
  updated_at: number;
}

export interface BuildsTable {
  id: string;
  tenant_id: string;
  server_id: string;
  spec_revision_id: string;
  overlay_revision_id: string | null;
  temporary: Generated<BoolColumn>;
  compiler_version: string;
  hash: string;
  status: 'ok' | 'error';
  diagnostics: Generated<string>;
  tool_count: Generated<number>;
  visible_count: Generated<number>;
  write_tool_count: Generated<number>;
  hidden_count: Generated<number>;
  lint: Generated<string>;
  lint_score: Generated<number>;
  orphaned_overlay_keys: Generated<string>;
  profiles: Generated<string>;
  python_stubs: Buffer | null;
  mock_model: Buffer | null;
  created_at: number;
}

export interface ToolsTable {
  seq: Generated<number>;
  id: string;
  tenant_id: string;
  build_id: string;
  server_id: string;
  key: string;
  name: string;
  py_name: string;
  title: Generated<string>;
  description: Generated<string>;
  kind: 'http' | 'graphql' | 'composite';
  write: Generated<BoolColumn>;
  hidden: Generated<BoolColumn>;
  pinned: Generated<BoolColumn>;
  deprecated: Generated<BoolColumn>;
  tags: Generated<string>;
  def: string;
  def_hash: string;
  search_text: Generated<string>;
}

export interface ToolEmbeddingsTable {
  tool_id: string;
  tenant_id: string;
  tool_seq: number;
  model_id: string;
  dims: number;
  text_hash: string;
  embedding: Buffer | string;
  updated_at: number;
}

export interface EnvironmentsTable {
  id: string;
  tenant_id: string;
  server_id: string;
  slug: string;
  name: string;
  kind: 'dev' | 'qa' | 'prod';
  base_url: string;
  build_id: string | null;
  auto_promote: Generated<BoolColumn>;
  auth: Generated<string>;
  headers: Generated<string>;
  writes: Generated<string>;
  code_mode: Generated<BoolColumn>;
  limits: Generated<string>;
  policies: Generated<string>;
  discovery_override: string | null;
  allowed_hosts: Generated<string>;
  allow_http: Generated<BoolColumn>;
  builtin: Generated<BoolColumn>;
  status: Generated<'active' | 'disabled' | 'removed_from_config'>;
  health: Generated<string>;
  managed_by: Generated<'file' | 'console'>;
  config_path: string | null;
  config_line: number | null;
  created_at: number;
  updated_at: number;
}

export interface UpstreamTokensTable {
  id: string;
  tenant_id: string;
  environment_id: string;
  user_id: string;
  dek_id: string;
  access_nonce: Buffer;
  access_ciphertext: Buffer;
  refresh_nonce: Buffer | null;
  refresh_ciphertext: Buffer | null;
  scopes: Generated<string>;
  expires_at: number | null;
  status: Generated<'active' | 'refresh_failed' | 'revoked'>;
  created_at: number;
  updated_at: number;
}

export interface UpstreamOauthStatesTable {
  state_hash: Buffer;
  tenant_id: string;
  user_id: string;
  environment_id: string;
  code_verifier_enc: Buffer;
  redirect_after: string;
  expires_at: number;
}

export interface SpecPreviewsTable {
  id: string;
  tenant_id: string;
  server_id: string | null;
  status: 'compiling' | 'ready' | 'failed';
  content: Buffer | null;
  source_url: string | null;
  state: Generated<string>;
  created_by: string | null;
  created_at: number;
  expires_at: number;
}

export interface ApiKeysTable {
  id: string;
  tenant_id: string;
  key_id: string;
  secret_hash: Buffer;
  display_prefix: string;
  name: string;
  purpose: Generated<'user' | 'eval'>;
  owner_user_id: string;
  server_id: string;
  environment_id: string;
  scopes: Generated<string>;
  profile: string | null;
  rate_limit: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  last_used_at: number | null;
  last_used_ip: string | null;
  created_at: number;
}

export interface OauthClientsTable {
  id: string;
  tenant_id: Generated<string>;
  client_id: string;
  registration_type: 'cimd' | 'dcr' | 'preregistered';
  client_name: string;
  client_uri: string | null;
  logo_uri: string | null;
  redirect_uris: Generated<string>;
  grant_types: Generated<string>;
  response_types: Generated<string>;
  token_endpoint_auth_method: 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';
  client_secret_hash: Buffer | null;
  application_type: string | null;
  metadata: Generated<string>;
  metadata_fetched_at: number | null;
  metadata_expires_at: number | null;
  status: Generated<'active' | 'blocked'>;
  created_at: number;
  updated_at: number;
}

export interface OauthAuthzRequestsTable {
  id: string;
  tenant_id: string;
  client_id: string;
  params: string;
  user_id: string | null;
  csrf_token: string;
  expires_at: number;
}

export interface OauthConsentsTable {
  id: string;
  tenant_id: string;
  user_id: string;
  client_id: string;
  environment_id: string;
  scopes: string;
  redirect_uri: string;
  created_at: number;
  revoked_at: number | null;
}

export interface OauthCodesTable {
  code_hash: Buffer;
  tenant_id: string;
  client_id: string;
  user_id: string;
  server_id: string;
  environment_id: string;
  redirect_uri: string;
  code_challenge: string;
  scopes: string;
  resource: string;
  expires_at: number;
  consumed_at: number | null;
}

export interface OauthTokensTable {
  id: string;
  tenant_id: string;
  token_hash: Buffer;
  kind: 'access' | 'refresh';
  client_id: string;
  user_id: string;
  server_id: string;
  environment_id: string;
  scopes: string;
  resource: string;
  family_id: string;
  parent_id: string | null;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
  created_at: number;
}

export interface TasksTable {
  tenant_id: string;
  id: string;
  server_id: string;
  environment_id: string;
  user_id: string | null;
  api_key_id: string | null;
  oauth_client_id: string | null;
  principal_type: string;
  credential_key: string;
  client_name: string | null;
  client_version: string | null;
  goal: string | null;
  outcome: 'success' | 'partial' | 'failure' | 'abandoned' | 'unknown' | null;
  notes: string | null;
  framing: 'explicit' | 'inferred' | 'script';
  inferred_label: string | null;
  status: 'open' | 'closed';
  started_at: number;
  last_activity_at: number;
  ended_at: number | null;
  call_count: Generated<number>;
  error_count: Generated<number>;
  write_count: Generated<number>;
  blocked_count: Generated<number>;
  script_count: Generated<number>;
  decision_count: Generated<number>;
  ops_count: Generated<number>;
  hinted: Generated<number>;
  trace_id: string | null;
  origin: Generated<'live' | 'eval'>;
}

export interface ScriptRunsTable {
  tenant_id: string;
  id: string;
  task_id: string | null;
  server_id: string;
  environment_id: string;
  user_id: string | null;
  credential_key: string;
  code: string;
  code_hash: string;
  mode: 'dry_run' | 'execute';
  status: string;
  error: string | null;
  result_preview: string | null;
  result_bytes: number | null;
  result_handle: string | null;
  planned_changes: Generated<string>;
  stats: Generated<string>;
  phases: Generated<string>;
  stdout: string | null;
  audit_id: string | null;
  trace_id: string | null;
  started_at: number;
  ended_at: number | null;
}

export interface DecisionsTable {
  tenant_id: string;
  id: string;
  task_id: string | null;
  ts: number;
  choice: string;
  reason: string;
  alternatives: Generated<string>;
  audit_id: string | null;
}

export interface NeedGroupsTable {
  tenant_id: string;
  id: string;
  server_id: string;
  label: string;
  intent_norm_hash: string;
  count: Generated<number>;
  distinct_principals: Generated<number>;
  first_seen_at: number;
  last_seen_at: number;
  status: Generated<'open' | 'planned' | 'done' | 'dismissed'>;
  note: string | null;
  centroid: Buffer | null;
}

export interface UnmetNeedsTable {
  tenant_id: string;
  id: string;
  group_id: string;
  server_id: string;
  environment_id: string;
  task_id: string | null;
  user_id: string | null;
  credential_key: string;
  client_name: string | null;
  intent: string;
  attempted: Generated<string>;
  created_at: number;
  audit_id: string | null;
}

export interface IssuesTable {
  tenant_id: string;
  id: string;
  server_id: string;
  environment_id: string;
  task_id: string | null;
  tool_name: string;
  problem: string;
  evidence: string | null;
  related_audit_id: string | null;
  status: Generated<'open' | 'acknowledged' | 'fixed' | 'dismissed'>;
  note: string | null;
  created_at: number;
  updated_at: number;
}

export interface ErrorEventsTable {
  tenant_id: string;
  error_id: string;
  task_id: string | null;
  audit_id: string | null;
  tool_name: string | null;
  code: string;
  detail: Generated<string>;
  created_at: number;
  expires_at: number;
}

export interface ExamplesTable {
  tenant_id: string;
  id: string;
  server_id: string;
  tool_name: string;
  kind: 'call' | 'script';
  arguments: string | null;
  code: string | null;
  args_hash: string;
  source: 'overlay' | 'spec' | 'eval' | 'traffic';
  success_count: Generated<number>;
  last_success_at: number | null;
  build_hash: string | null;
}

export interface ResultPagesTable {
  tenant_id: string;
  handle: string;
  credential_key: string;
  content: Buffer;
  bytes: number;
  created_at: number;
  expires_at: number;
}

export interface UsageDailyTable {
  tenant_id: string;
  server_id: string;
  environment_id: string;
  tool_name: string;
  day: string;
  calls: Generated<number>;
  errors: Generated<number>;
  script_calls: Generated<number>;
}

export interface KillSwitchesTable {
  tenant_id: string;
  scope: 'global' | 'server' | 'environment' | 'tool';
  target: string;
  kind: 'all' | 'writes' | 'code_mode';
  reason: Generated<string>;
  created_by: string | null;
  created_at: number;
}

export interface ConfigStateTable {
  tenant_id: string;
  path: string | null;
  hash: string | null;
  applied_at: number | null;
  status: 'ok' | 'error';
  diagnostics: Generated<string>;
}

export interface EvalSuitesTable {
  tenant_id: string;
  id: string;
  server_id: string;
  version: number;
  status: 'draft' | 'frozen';
  generated_from_build_id: string | null;
  generator: Generated<string>;
  task_count: Generated<number>;
  created_by: string | null;
  created_at: number;
  frozen_at: number | null;
}

export interface EvalTasksTable {
  tenant_id: string;
  id: string;
  suite_id: string;
  key: string;
  category: 'single' | 'multi' | 'ambiguous' | 'impossible';
  prompt: string;
  rubric: Generated<string>;
  assertions: Generated<string>;
  reference_calls: Generated<string>;
  seed_state: string | null;
  tags: Generated<string>;
  enabled: Generated<BoolColumn>;
  source: Generated<'generated' | 'manual'>;
}

export interface EvalRunsTable {
  tenant_id: string;
  id: string;
  server_id: string;
  suite_id: string;
  environment_id: string;
  build_id: string;
  overlay_revision_id: string | null;
  models: Generated<string>;
  modes: Generated<string>;
  repeats: Generated<number>;
  task_keys: string | null;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  progress: Generated<string>;
  score: string | null;
  headline: number | null;
  recommended_mode: string | null;
  confidence: string | null;
  usage: Generated<string>;
  error: string | null;
  trigger: 'console' | 'cli' | 'ci' | 'suggestion_verify';
  base_run_id: string | null;
  job_id: string | null;
  created_by: string | null;
  created_at: number;
  started_at: number | null;
  ended_at: number | null;
}

export interface EvalTaskRunsTable {
  tenant_id: string;
  id: string;
  run_id: string;
  task_id: string;
  model: string;
  mode: 'tool' | 'code';
  attempt: number;
  passed: BoolColumn;
  assertion_results: Generated<string>;
  judge: string | null;
  failure_cause: string | null;
  framing_ok: Generated<BoolColumn>;
  tool_calls: Generated<number>;
  scripts: Generated<number>;
  input_tokens: Generated<number>;
  output_tokens: Generated<number>;
  latency_ms: Generated<number>;
  served_by_model: string | null;
  fallback_used: Generated<BoolColumn>;
  task_id_neurouter: string | null;
  transcript: Buffer | null;
  created_at: number;
}

export interface SuggestionsTable {
  tenant_id: string;
  id: string;
  run_id: string;
  server_id: string;
  cause: string;
  kind: 'rename' | 'describe' | 'example' | 'hide' | 'response_shape' | 'composite';
  tools: Generated<string>;
  affected_task_ids: Generated<string>;
  overlay_patch: string;
  spec_patch: string | null;
  rationale: Generated<string>;
  predicted_delta: Generated<number>;
  status: Generated<'proposed' | 'verifying' | 'verified' | 'applied' | 'dismissed'>;
  verify_run_id: string | null;
  verified_delta: number | null;
  created_at: number;
  updated_at: number;
}

export interface OauthClientBlocksTable {
  tenant_id: string;
  client_id: string;
  created_by: string | null;
  created_at: number;
}

export interface MockNamespacesTable {
  tenant_id: string;
  environment_id: string;
  namespace: string;
  seed: number;
  kind: 'env' | 'eval' | 'gen';
  created_at: number;
  last_used_at: number;
  expires_at: number | null;
}

export interface MockCollectionsTable {
  tenant_id: string;
  environment_id: string;
  namespace: string;
  collection_key: string;
  seed: number;
  next_id: number;
  item_count: number;
  bytes: number;
  created_at: number;
  last_used_at: number;
}

export interface MockItemsTable {
  tenant_id: string;
  environment_id: string;
  namespace: string;
  collection_key: string;
  item_id: string;
  ord: number;
  body: string;
  bytes: number;
  updated_at: number;
}

export interface AuditLogTable {
  seq: number;
  id: string;
  tenant_id: string;
  ts: number;
  kind: 'tools_list' | 'tool_search' | 'tool_call' | 'script_run' | 'ops_call' | 'admin_action' | 'auth_event' | 'config_apply' | 'eval_run';
  request_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  oauth_client_id: string | null;
  principal_type: string | null;
  external_subject: string | null;
  credential_key: string | null;
  client_name: string | null;
  client_version: string | null;
  protocol_version: string | null;
  client_era: string | null;
  server_id: string | null;
  environment_id: string | null;
  environment_kind: string | null;
  task_id: string | null;
  script_run_id: string | null;
  via: string | null;
  mode: string | null;
  write: BoolColumn;
  dry_run: BoolColumn;
  confirm: string | null;
  tool_id: string | null;
  tool_name: string | null;
  action: string | null;
  target_type: string | null;
  target_id: string | null;
  decision: 'allowed' | 'dry_run' | 'confirmed' | 'denied_acl' | 'denied_policy' | 'denied_rate_limit' | 'denied_read_only' | 'denied_disabled' | 'denied_confirmation';
  decision_reason: string | null;
  status: 'ok' | 'tool_error' | 'upstream_error' | 'timeout' | 'invalid_args' | 'blocked' | 'cancelled' | 'script_error' | 'limit_exceeded';
  policy_trail: string | null;
  error_id: string | null;
  upstream_status: number | null;
  params_redacted: string | null;
  params_text: string | null;
  changes: string | null;
  output_size: number | null;
  output_hash: string | null;
  output_full: string | null;
  output_preview: string | null;
  latency_ms: number | null;
  upstream_latency_ms: number | null;
  error_code: string | null;
  error_message: string | null;
  trace_id: string | null;
  span_id: string | null;
  ip: string | null;
  user_agent: string | null;
  prev_hash: string;
  hash: string;
}

export interface AuditCheckpointsTable {
  id: string;
  seq: number;
  hash: string;
  kind: 'periodic' | 'retention_cut' | 'key_rotation';
  mac: string;
  key_id: string;
  created_at: number;
}

export interface AuditSinkCursorsTable {
  sink: string;
  last_seq: number;
  updated_at: number;
  last_error: string | null;
}

export interface RollupMinuteTable {
  tenant_id: string;
  bucket: number;
  server_id: Generated<string>;
  environment_id: Generated<string>;
  tool_name: Generated<string>;
  mode: Generated<string>;
  status_class: Generated<string>;
  calls: Generated<number>;
  errors: Generated<number>;
  blocked: Generated<number>;
  latency_sum_ms: Generated<number>;
  upstream_latency_sum: Generated<number>;
  h00: Generated<number>;
  h01: Generated<number>;
  h02: Generated<number>;
  h03: Generated<number>;
  h04: Generated<number>;
  h05: Generated<number>;
  h06: Generated<number>;
  h07: Generated<number>;
  h08: Generated<number>;
  h09: Generated<number>;
  h10: Generated<number>;
  h11: Generated<number>;
  h12: Generated<number>;
  h13: Generated<number>;
  h14: Generated<number>;
  h15: Generated<number>;
  h16: Generated<number>;
  h17: Generated<number>;
  h18: Generated<number>;
  h19: Generated<number>;
}

export interface RollupHourTable {
  tenant_id: string;
  bucket: number;
  server_id: Generated<string>;
  environment_id: Generated<string>;
  tool_name: Generated<string>;
  mode: Generated<string>;
  status_class: Generated<string>;
  calls: Generated<number>;
  errors: Generated<number>;
  blocked: Generated<number>;
  latency_sum_ms: Generated<number>;
  upstream_latency_sum: Generated<number>;
  h00: Generated<number>;
  h01: Generated<number>;
  h02: Generated<number>;
  h03: Generated<number>;
  h04: Generated<number>;
  h05: Generated<number>;
  h06: Generated<number>;
  h07: Generated<number>;
  h08: Generated<number>;
  h09: Generated<number>;
  h10: Generated<number>;
  h11: Generated<number>;
  h12: Generated<number>;
  h13: Generated<number>;
  h14: Generated<number>;
  h15: Generated<number>;
  h16: Generated<number>;
  h17: Generated<number>;
  h18: Generated<number>;
  h19: Generated<number>;
}

export interface MainDB {
  tenants: TenantsTable;
  users: UsersTable;
  web_sessions: WebSessionsTable;
  oidc_login_states: OidcLoginStatesTable;
  local_links: LocalLinksTable;
  settings: SettingsTable;
  encryption_keys: EncryptionKeysTable;
  secrets: SecretsTable;
  redaction_rules: RedactionRulesTable;
  leases: LeasesTable;
  coord_signals: CoordSignalsTable;
  jobs: JobsTable;
  rate_limit_buckets: RateLimitBucketsTable;
  servers: ServersTable;
  spec_revisions: SpecRevisionsTable;
  overlay_revisions: OverlayRevisionsTable;
  overlay_drafts: OverlayDraftsTable;
  builds: BuildsTable;
  tools: ToolsTable;
  tool_embeddings: ToolEmbeddingsTable;
  environments: EnvironmentsTable;
  upstream_tokens: UpstreamTokensTable;
  upstream_oauth_states: UpstreamOauthStatesTable;
  spec_previews: SpecPreviewsTable;
  api_keys: ApiKeysTable;
  oauth_clients: OauthClientsTable;
  oauth_authz_requests: OauthAuthzRequestsTable;
  oauth_consents: OauthConsentsTable;
  oauth_codes: OauthCodesTable;
  oauth_tokens: OauthTokensTable;
  tasks: TasksTable;
  script_runs: ScriptRunsTable;
  decisions: DecisionsTable;
  need_groups: NeedGroupsTable;
  unmet_needs: UnmetNeedsTable;
  issues: IssuesTable;
  error_events: ErrorEventsTable;
  examples: ExamplesTable;
  result_pages: ResultPagesTable;
  usage_daily: UsageDailyTable;
  kill_switches: KillSwitchesTable;
  config_state: ConfigStateTable;
  eval_suites: EvalSuitesTable;
  eval_tasks: EvalTasksTable;
  eval_runs: EvalRunsTable;
  eval_task_runs: EvalTaskRunsTable;
  suggestions: SuggestionsTable;
  oauth_client_blocks: OauthClientBlocksTable;
  mock_namespaces: MockNamespacesTable;
  mock_collections: MockCollectionsTable;
  mock_items: MockItemsTable;
}

export interface AuditDB {
  audit_log: AuditLogTable;
  audit_checkpoints: AuditCheckpointsTable;
  audit_sink_cursors: AuditSinkCursorsTable;
  rollup_minute: RollupMinuteTable;
  rollup_hour: RollupHourTable;
}

export type DB = MainDB & AuditDB;

/** Runtime column inventory (the drift test compares it to the migrated schema). */
export const MAIN_TABLE_COLUMNS = {
  tenants: ['id', 'slug', 'name', 'created_at'],
  users: ['id', 'tenant_id', 'email', 'name', 'oidc_issuer', 'oidc_subject', 'role', 'role_source', 'status', 'last_login_at', 'preferences', 'created_at', 'updated_at'],
  web_sessions: ['id_hash', 'tenant_id', 'user_id', 'csrf_token', 'created_at', 'expires_at', 'last_seen_at', 'ip', 'user_agent', 'id_token_hint', 'anonymous'],
  oidc_login_states: ['state_hash', 'tenant_id', 'code_verifier_enc', 'nonce', 'return_to', 'expires_at'],
  local_links: ['token_hash', 'tenant_id', 'user_id', 'expires_at', 'used_at', 'created_at'],
  settings: ['tenant_id', 'key', 'value', 'updated_by', 'updated_at'],
  encryption_keys: ['id', 'tenant_id', 'kek_id', 'wrapped_key', 'status', 'created_at'],
  secrets: ['id', 'tenant_id', 'purpose', 'owner_type', 'owner_id', 'name', 'provider', 'external_ref', 'dek_id', 'nonce', 'ciphertext', 'version', 'updated_by', 'created_at', 'updated_at'],
  redaction_rules: ['id', 'tenant_id', 'name', 'type', 'pattern', 'replacement', 'enabled', 'order', 'builtin', 'created_by', 'created_at', 'updated_at'],
  leases: ['name', 'holder', 'expires_at'],
  coord_signals: ['channel', 'payload', 'created_at'],
  jobs: ['id', 'tenant_id', 'kind', 'status', 'params', 'progress', 'result', 'error', 'created_by', 'created_at', 'finished_at'],
  rate_limit_buckets: ['key', 'tokens', 'capacity', 'refill_per_ms', 'updated_at'],
  servers: ['id', 'tenant_id', 'slug', 'name', 'description', 'kind', 'spec_source', 'exposure', 'ops_tools', 'public_report', 'overlay_path', 'current_spec_revision_id', 'published_overlay_revision_id', 'latest_build_id', 'status', 'managed_by', 'config_path', 'config_line', 'created_by', 'created_at', 'updated_at'],
  spec_revisions: ['id', 'tenant_id', 'server_id', 'rev', 'format', 'source_url', 'content_type', 'content_hash', 'content', 'content_bytes', 'title', 'api_version', 'operation_count', 'summary', 'created_by', 'created_at'],
  overlay_revisions: ['id', 'tenant_id', 'server_id', 'rev', 'yaml', 'hash', 'message', 'source', 'based_on_rev', 'created_by', 'created_at'],
  overlay_drafts: ['server_id', 'tenant_id', 'yaml', 'based_on_rev', 'change_count', 'changes', 'updated_by', 'updated_at'],
  builds: ['id', 'tenant_id', 'server_id', 'spec_revision_id', 'overlay_revision_id', 'temporary', 'compiler_version', 'hash', 'status', 'diagnostics', 'tool_count', 'visible_count', 'write_tool_count', 'hidden_count', 'lint', 'lint_score', 'orphaned_overlay_keys', 'profiles', 'python_stubs', 'mock_model', 'created_at'],
  tools: ['seq', 'id', 'tenant_id', 'build_id', 'server_id', 'key', 'name', 'py_name', 'title', 'description', 'kind', 'write', 'hidden', 'pinned', 'deprecated', 'tags', 'def', 'def_hash', 'search_text'],
  tool_embeddings: ['tool_id', 'tenant_id', 'tool_seq', 'model_id', 'dims', 'text_hash', 'embedding', 'updated_at'],
  environments: ['id', 'tenant_id', 'server_id', 'slug', 'name', 'kind', 'base_url', 'build_id', 'auto_promote', 'auth', 'headers', 'writes', 'code_mode', 'limits', 'policies', 'discovery_override', 'allowed_hosts', 'allow_http', 'builtin', 'status', 'health', 'managed_by', 'config_path', 'config_line', 'created_at', 'updated_at'],
  upstream_tokens: ['id', 'tenant_id', 'environment_id', 'user_id', 'dek_id', 'access_nonce', 'access_ciphertext', 'refresh_nonce', 'refresh_ciphertext', 'scopes', 'expires_at', 'status', 'created_at', 'updated_at'],
  upstream_oauth_states: ['state_hash', 'tenant_id', 'user_id', 'environment_id', 'code_verifier_enc', 'redirect_after', 'expires_at'],
  spec_previews: ['id', 'tenant_id', 'server_id', 'status', 'content', 'source_url', 'state', 'created_by', 'created_at', 'expires_at'],
  api_keys: ['id', 'tenant_id', 'key_id', 'secret_hash', 'display_prefix', 'name', 'purpose', 'owner_user_id', 'server_id', 'environment_id', 'scopes', 'profile', 'rate_limit', 'expires_at', 'revoked_at', 'last_used_at', 'last_used_ip', 'created_at'],
  oauth_clients: ['id', 'tenant_id', 'client_id', 'registration_type', 'client_name', 'client_uri', 'logo_uri', 'redirect_uris', 'grant_types', 'response_types', 'token_endpoint_auth_method', 'client_secret_hash', 'application_type', 'metadata', 'metadata_fetched_at', 'metadata_expires_at', 'status', 'created_at', 'updated_at'],
  oauth_authz_requests: ['id', 'tenant_id', 'client_id', 'params', 'user_id', 'csrf_token', 'expires_at'],
  oauth_consents: ['id', 'tenant_id', 'user_id', 'client_id', 'environment_id', 'scopes', 'redirect_uri', 'created_at', 'revoked_at'],
  oauth_codes: ['code_hash', 'tenant_id', 'client_id', 'user_id', 'server_id', 'environment_id', 'redirect_uri', 'code_challenge', 'scopes', 'resource', 'expires_at', 'consumed_at'],
  oauth_tokens: ['id', 'tenant_id', 'token_hash', 'kind', 'client_id', 'user_id', 'server_id', 'environment_id', 'scopes', 'resource', 'family_id', 'parent_id', 'expires_at', 'revoked_at', 'last_used_at', 'created_at'],
  tasks: ['tenant_id', 'id', 'server_id', 'environment_id', 'user_id', 'api_key_id', 'oauth_client_id', 'principal_type', 'credential_key', 'client_name', 'client_version', 'goal', 'outcome', 'notes', 'framing', 'inferred_label', 'status', 'started_at', 'last_activity_at', 'ended_at', 'call_count', 'error_count', 'write_count', 'blocked_count', 'script_count', 'decision_count', 'ops_count', 'hinted', 'trace_id', 'origin'],
  script_runs: ['tenant_id', 'id', 'task_id', 'server_id', 'environment_id', 'user_id', 'credential_key', 'code', 'code_hash', 'mode', 'status', 'error', 'result_preview', 'result_bytes', 'result_handle', 'planned_changes', 'stats', 'phases', 'stdout', 'audit_id', 'trace_id', 'started_at', 'ended_at'],
  decisions: ['tenant_id', 'id', 'task_id', 'ts', 'choice', 'reason', 'alternatives', 'audit_id'],
  need_groups: ['tenant_id', 'id', 'server_id', 'label', 'intent_norm_hash', 'count', 'distinct_principals', 'first_seen_at', 'last_seen_at', 'status', 'note', 'centroid'],
  unmet_needs: ['tenant_id', 'id', 'group_id', 'server_id', 'environment_id', 'task_id', 'user_id', 'credential_key', 'client_name', 'intent', 'attempted', 'created_at', 'audit_id'],
  issues: ['tenant_id', 'id', 'server_id', 'environment_id', 'task_id', 'tool_name', 'problem', 'evidence', 'related_audit_id', 'status', 'note', 'created_at', 'updated_at'],
  error_events: ['tenant_id', 'error_id', 'task_id', 'audit_id', 'tool_name', 'code', 'detail', 'created_at', 'expires_at'],
  examples: ['tenant_id', 'id', 'server_id', 'tool_name', 'kind', 'arguments', 'code', 'args_hash', 'source', 'success_count', 'last_success_at', 'build_hash'],
  result_pages: ['tenant_id', 'handle', 'credential_key', 'content', 'bytes', 'created_at', 'expires_at'],
  usage_daily: ['tenant_id', 'server_id', 'environment_id', 'tool_name', 'day', 'calls', 'errors', 'script_calls'],
  kill_switches: ['tenant_id', 'scope', 'target', 'kind', 'reason', 'created_by', 'created_at'],
  config_state: ['tenant_id', 'path', 'hash', 'applied_at', 'status', 'diagnostics'],
  eval_suites: ['tenant_id', 'id', 'server_id', 'version', 'status', 'generated_from_build_id', 'generator', 'task_count', 'created_by', 'created_at', 'frozen_at'],
  eval_tasks: ['tenant_id', 'id', 'suite_id', 'key', 'category', 'prompt', 'rubric', 'assertions', 'reference_calls', 'seed_state', 'tags', 'enabled', 'source'],
  eval_runs: ['tenant_id', 'id', 'server_id', 'suite_id', 'environment_id', 'build_id', 'overlay_revision_id', 'models', 'modes', 'repeats', 'task_keys', 'status', 'progress', 'score', 'headline', 'recommended_mode', 'confidence', 'usage', 'error', 'trigger', 'base_run_id', 'job_id', 'created_by', 'created_at', 'started_at', 'ended_at'],
  eval_task_runs: ['tenant_id', 'id', 'run_id', 'task_id', 'model', 'mode', 'attempt', 'passed', 'assertion_results', 'judge', 'failure_cause', 'framing_ok', 'tool_calls', 'scripts', 'input_tokens', 'output_tokens', 'latency_ms', 'served_by_model', 'fallback_used', 'task_id_neurouter', 'transcript', 'created_at'],
  suggestions: ['tenant_id', 'id', 'run_id', 'server_id', 'cause', 'kind', 'tools', 'affected_task_ids', 'overlay_patch', 'spec_patch', 'rationale', 'predicted_delta', 'status', 'verify_run_id', 'verified_delta', 'created_at', 'updated_at'],
  oauth_client_blocks: ['tenant_id', 'client_id', 'created_by', 'created_at'],
  mock_namespaces: ['tenant_id', 'environment_id', 'namespace', 'seed', 'kind', 'created_at', 'last_used_at', 'expires_at'],
  mock_collections: ['tenant_id', 'environment_id', 'namespace', 'collection_key', 'seed', 'next_id', 'item_count', 'bytes', 'created_at', 'last_used_at'],
  mock_items: ['tenant_id', 'environment_id', 'namespace', 'collection_key', 'item_id', 'ord', 'body', 'bytes', 'updated_at'],
} as const satisfies { [T in keyof MainDB]: readonly (keyof MainDB[T])[] };

export const AUDIT_TABLE_COLUMNS = {
  audit_log: ['seq', 'id', 'tenant_id', 'ts', 'kind', 'request_id', 'user_id', 'api_key_id', 'oauth_client_id', 'principal_type', 'external_subject', 'credential_key', 'client_name', 'client_version', 'protocol_version', 'client_era', 'server_id', 'environment_id', 'environment_kind', 'task_id', 'script_run_id', 'via', 'mode', 'write', 'dry_run', 'confirm', 'tool_id', 'tool_name', 'action', 'target_type', 'target_id', 'decision', 'decision_reason', 'status', 'policy_trail', 'error_id', 'upstream_status', 'params_redacted', 'params_text', 'changes', 'output_size', 'output_hash', 'output_full', 'output_preview', 'latency_ms', 'upstream_latency_ms', 'error_code', 'error_message', 'trace_id', 'span_id', 'ip', 'user_agent', 'prev_hash', 'hash'],
  audit_checkpoints: ['id', 'seq', 'hash', 'kind', 'mac', 'key_id', 'created_at'],
  audit_sink_cursors: ['sink', 'last_seq', 'updated_at', 'last_error'],
  rollup_minute: ['tenant_id', 'bucket', 'server_id', 'environment_id', 'tool_name', 'mode', 'status_class', 'calls', 'errors', 'blocked', 'latency_sum_ms', 'upstream_latency_sum', 'h00', 'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19'],
  rollup_hour: ['tenant_id', 'bucket', 'server_id', 'environment_id', 'tool_name', 'mode', 'status_class', 'calls', 'errors', 'blocked', 'latency_sum_ms', 'upstream_latency_sum', 'h00', 'h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08', 'h09', 'h10', 'h11', 'h12', 'h13', 'h14', 'h15', 'h16', 'h17', 'h18', 'h19'],
} as const satisfies { [T in keyof AuditDB]: readonly (keyof AuditDB[T])[] };

/** Dialect-specific extras that exist only in one engine (not in the shared inventory). */
export const SQLITE_ONLY_TABLES = ['tools_fts', 'audit_fts'] as const;
export const POSTGRES_ONLY_COLUMNS = { tools: ['search_tsv'], audit_log: ['params_tsv'] } as const;
