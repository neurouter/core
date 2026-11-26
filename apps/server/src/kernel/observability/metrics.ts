import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
import { LATENCY_BUCKETS_MS } from '../lib/histogram.js';
import type { AuditLogTable } from '../db/schema.js';

/** Same bounds as the rollup histogram, in seconds, without +Inf (prom-client adds it). */
export const DURATION_BUCKETS_S = LATENCY_BUCKETS_MS.filter((b) => Number.isFinite(b)).map((b) => b / 1000);

/** Label names that must never appear on /metrics (Hub FORBIDDEN_LABELS + Neurouter ids). */
export const FORBIDDEN_LABELS = ['user', 'user_id', 'agent', 'agent_id', 'session', 'session_id', 'key', 'api_key_id', 'task', 'task_id'];

export type AuthFailureMethod = 'api_key' | 'oauth' | 'external' | 'web';

/**
 * prom-client registry + facade (§17.3, ADAPT Hub). Prefix `neurouter_`; low-cardinality labels
 * only; the `tool` label can be dropped for very large toolsets (`metricsToolLabel`).
 */
export class Metrics {
  readonly registry = new Registry();
  readonly mcpRequests: Counter<'method' | 'era' | 'outcome'>;
  readonly toolCalls: Counter<'server' | 'environment' | 'tool' | 'via' | 'decision' | 'status'>;
  readonly toolCallDuration: Histogram<'server' | 'environment' | 'status'>;
  readonly upstreamDuration: Histogram<'server' | 'environment' | 'method' | 'status_class'>;
  readonly circuitOpen: Gauge<'server' | 'environment'>;
  readonly rateLimitedTotal: Counter<'scope'>;
  readonly scriptRuns: Counter<'server' | 'environment' | 'mode' | 'status'>;
  readonly scriptDuration: Histogram<'status'>;
  readonly scriptToolCalls: Histogram;
  readonly executorUp: Gauge;
  readonly executorBusy: Gauge;
  readonly executorCrashes: Counter;
  readonly tasksTotal: Counter<'server' | 'framing' | 'outcome'>;
  readonly opsCalls: Counter<'tool'>;
  readonly unmetNeeds: Counter<'server'>;
  readonly issues: Counter<'server'>;
  readonly evalTaskRuns: Counter<'model' | 'mode' | 'passed'>;
  readonly llmTokens: Counter<'model' | 'kind'>;
  readonly auditQueueDepth: Gauge;
  readonly auditDropped: Counter;
  readonly auditFlush: Histogram;
  readonly authFailures: Counter<'method' | 'reason'>;
  readonly embeddingStatus: Gauge<'status'>;
  /** Drop the `tool` label (setting `metricsToolLabel`). */
  toolLabel = true;
  beforeRender: (() => Promise<void>) | null = null;

  constructor(opts: { defaultMetrics?: boolean } = {}) {
    const registers = [this.registry];
    if (opts.defaultMetrics ?? true) collectDefaultMetrics({ register: this.registry, prefix: 'neurouter_' });
    this.mcpRequests = new Counter({ name: 'neurouter_mcp_requests_total', help: 'MCP requests by method, protocol era and outcome', labelNames: ['method', 'era', 'outcome'], registers });
    this.toolCalls = new Counter({ name: 'neurouter_tool_calls_total', help: 'Tool calls', labelNames: ['server', 'environment', 'tool', 'via', 'decision', 'status'], registers });
    this.toolCallDuration = new Histogram({ name: 'neurouter_tool_call_duration_seconds', help: 'End-to-end tool call latency', labelNames: ['server', 'environment', 'status'], buckets: DURATION_BUCKETS_S, registers });
    this.upstreamDuration = new Histogram({ name: 'neurouter_upstream_request_duration_seconds', help: 'Upstream API latency', labelNames: ['server', 'environment', 'method', 'status_class'], buckets: DURATION_BUCKETS_S, registers });
    this.circuitOpen = new Gauge({ name: 'neurouter_upstream_circuit_open', help: '1 when the upstream circuit is open', labelNames: ['server', 'environment'], registers });
    this.rateLimitedTotal = new Counter({ name: 'neurouter_rate_limited_total', help: 'Rate-limited calls by limit scope', labelNames: ['scope'], registers });
    this.scriptRuns = new Counter({ name: 'neurouter_script_runs_total', help: 'run_script executions', labelNames: ['server', 'environment', 'mode', 'status'], registers });
    this.scriptDuration = new Histogram({ name: 'neurouter_script_duration_seconds', help: 'run_script wall time', labelNames: ['status'], buckets: DURATION_BUCKETS_S, registers });
    this.scriptToolCalls = new Histogram({ name: 'neurouter_script_tool_calls', help: 'Tool calls per script', buckets: [1, 2, 5, 10, 20, 50, 100, 200], registers });
    this.executorUp = new Gauge({ name: 'neurouter_executor_up', help: '1 when the code-mode executor is healthy', registers });
    this.executorBusy = new Gauge({ name: 'neurouter_executor_busy', help: 'Busy executor workers', registers });
    this.executorCrashes = new Counter({ name: 'neurouter_executor_crashes_total', help: 'Executor worker crashes', registers });
    this.tasksTotal = new Counter({ name: 'neurouter_tasks_total', help: 'Closed tasks', labelNames: ['server', 'framing', 'outcome'], registers });
    this.opsCalls = new Counter({ name: 'neurouter_ops_calls_total', help: 'Ops tool calls', labelNames: ['tool'], registers });
    this.unmetNeeds = new Counter({ name: 'neurouter_unmet_needs_total', help: 'Unmet-need reports', labelNames: ['server'], registers });
    this.issues = new Counter({ name: 'neurouter_issues_total', help: 'Issue reports', labelNames: ['server'], registers });
    this.evalTaskRuns = new Counter({ name: 'neurouter_eval_task_runs_total', help: 'Eval task attempts', labelNames: ['model', 'mode', 'passed'], registers });
    this.llmTokens = new Counter({ name: 'neurouter_llm_tokens_total', help: 'LLM tokens used by evals', labelNames: ['model', 'kind'], registers });
    this.auditQueueDepth = new Gauge({ name: 'neurouter_audit_queue_depth', help: 'Audit events waiting to be written', registers });
    this.auditDropped = new Counter({ name: 'neurouter_audit_dropped_total', help: 'Audit events dropped (queue full)', registers });
    this.auditFlush = new Histogram({ name: 'neurouter_audit_flush_seconds', help: 'Audit batch flush time', buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5], registers });
    this.authFailures = new Counter({ name: 'neurouter_auth_failures_total', help: 'Authentication failures', labelNames: ['method', 'reason'], registers });
    this.embeddingStatus = new Gauge({ name: 'neurouter_embedding_model_ready', help: '1 when the embedding model is ready', labelNames: ['status'], registers });
  }

  toolCall(server: string, environment: string, tool: string, via: string, decision: string, status: string, seconds: number): void {
    this.toolCalls.inc({ server, environment, tool: this.toolLabel ? tool : '', via, decision, status });
    if (!decision.startsWith('denied_')) this.toolCallDuration.observe({ server, environment, status }, seconds);
  }

  rateLimited(scope: string): void {
    this.rateLimitedTotal.inc({ scope });
  }

  /** Counts committed audit rows (called by the audit writer after each flush). */
  observeAudit(rows: readonly Pick<AuditLogTable, 'kind' | 'status' | 'client_era'>[]): void {
    for (const r of rows) {
      const era = r.client_era === 'modern' || r.client_era === 'legacy' ? r.client_era : 'unknown';
      const outcome = r.status === 'blocked' ? 'denied' : r.status === 'ok' ? 'ok' : 'error';
      if (r.kind === 'tools_list') this.mcpRequests.inc({ method: 'tools/list', era, outcome });
      else if (r.kind === 'tool_call' || r.kind === 'tool_search' || r.kind === 'script_run' || r.kind === 'ops_call') this.mcpRequests.inc({ method: 'tools/call', era, outcome });
    }
  }

  authFailure(method: AuthFailureMethod, reason: string): void {
    this.authFailures.inc({ method, reason: reason.slice(0, 40) });
  }

  async render(): Promise<{ contentType: string; body: string }> {
    if (this.beforeRender) await this.beforeRender().catch(() => {});
    return { contentType: this.registry.contentType, body: await this.registry.metrics() };
  }
}
