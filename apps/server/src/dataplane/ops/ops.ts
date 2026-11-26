import type { Kysely } from 'kysely';
import { META_CALL_ID, META_TASK_ID, OPS_TOOLS, opsMcpName, READ_RESULT, type ErrorCode, type OpsTool } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { Redactor } from '../../kernel/audit/redact.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { sha256Hex } from '../../kernel/lib/crypto.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import type { Metrics } from '../../kernel/observability/metrics.js';
import type { RateLimiter } from '../rate-limit/limiter.js';
import type { ResultPages } from '../shaping/result-pages.js';
import type { TaskTracker } from '../tasks/tracker.js';
import { principalId, principalUserId, type RunContext } from '../pipeline/context.js';
import { explain, type ErrorEvents } from '../pipeline/errors.js';
import type { McpToolResult, Pipeline } from '../pipeline/pipeline.js';
import { writeEnabled } from '../pipeline/pipeline.js';

const TEXT_CAP = 500;

type Schema = Record<string, unknown>;

export interface OpsToolDefinition {
  name: string;
  pyName: string | null;
  title: string;
  description: string;
  inputSchema: Schema;
  annotations: Record<string, unknown>;
  op: OpsTool | typeof READ_RESULT;
}

const obj = (properties: Record<string, unknown>, required: string[] = []): Schema => ({ type: 'object', properties, required, additionalProperties: false });
const str = (min: number, max: number, description: string): Schema => ({ type: 'string', minLength: min, maxLength: max, description });

/** Ops tool definitions (§11.1). Free text is capped at 500 chars (truncated, not rejected), so maxLength is not enforced here. */
export const OPS_DEFINITIONS: Record<OpsTool | typeof READ_RESULT, Omit<OpsToolDefinition, 'name' | 'pyName' | 'op'>> = {
  begin_task: {
    title: 'Begin a task',
    description: "Start tracking one user request as a task. Call this first with the user's goal in one sentence; every following call attaches to the task until neurouter_end_task.",
    inputSchema: obj({ goal: str(1, 2000, 'What the user wants done, in one sentence') }, ['goal']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  end_task: {
    title: 'End the task',
    description: 'Finish the current task with its outcome. Call this when you have answered the user or given up.',
    inputSchema: obj({ outcome: { type: 'string', enum: ['success', 'partial', 'failure'] }, notes: { type: 'string', description: 'Optional short notes' }, task_id: { type: 'string' } }, ['outcome']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  report_unmet_need: {
    title: 'Report an unmet need',
    description: "Tell the API's operators that the user needs something no available tool can do. Use this instead of guessing or improvising.",
    inputSchema: obj({ intent: str(1, 2000, 'What the user wanted to do'), attempted: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Tool names you tried' } }, ['intent']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  log_decision: {
    title: 'Log a decision',
    description: 'Record a non-obvious choice you made (what and why), so humans can review the reasoning later.',
    inputSchema: obj({ choice: str(1, 2000, 'What you chose'), reason: str(1, 2000, 'Why'), alternatives: { type: 'array', items: { type: 'string' }, maxItems: 5 } }, ['choice', 'reason']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  report_issue: {
    title: 'Report a tool issue',
    description: 'Report that a tool behaved wrongly or its documentation is misleading (wrong results, confusing errors).',
    inputSchema: obj({ tool: { type: 'string' }, problem: str(1, 2000, 'What went wrong'), evidence: { type: 'object', description: 'Small JSON evidence (≤ 4 KiB)' }, error_id: { type: 'string' } }, ['tool', 'problem']),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  explain_error: {
    title: 'Explain an error',
    description: 'Explain an error_id returned by a failed call and how to fix the call.',
    inputSchema: obj({ error_id: { type: 'string' } }, ['error_id']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  get_examples: {
    title: 'Get examples',
    description: 'Get known-good example arguments (or scripts) for a tool.',
    inputSchema: obj({ tool: { type: 'string' }, kind: { type: 'string', enum: ['call', 'script'] } }, ['tool']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  whoami: {
    title: 'Who am I',
    description: 'Show the environment, your identity, scopes, whether writes and code mode are enabled, and your limits.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  read_result: {
    title: 'Read more of a truncated result',
    description: 'Page through a large result that was truncated. Pass the result handle from the earlier call.',
    inputSchema: obj({ handle: { type: 'string' }, offset: { type: 'integer', minimum: 0, default: 0 }, limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 } }, ['handle']),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
};

export function opsDefinition(op: OpsTool | typeof READ_RESULT): OpsToolDefinition {
  return { ...OPS_DEFINITIONS[op], name: opsMcpName(op), pyName: op === READ_RESULT ? null : `ops.${op}`, op };
}

export function enabledOps(ctx: RunContext): OpsTool[] {
  return OPS_TOOLS.filter((t) => ctx.bundle.server.opsTools[t]);
}

/** MCP name (`neurouter_x`) or Python name (`ops.x` / `x`) → op, when enabled. read_result is always on. */
export function opFor(ctx: RunContext, name: string): OpsTool | typeof READ_RESULT | null {
  const raw = name.startsWith('neurouter_') ? name.slice('neurouter_'.length) : name.startsWith('ops.') ? name.slice(4) : null;
  if (!raw) return null;
  if (raw === READ_RESULT) return name.startsWith('ops.') ? null : READ_RESULT;
  return (OPS_TOOLS as readonly string[]).includes(raw) && ctx.bundle.server.opsTools[raw as OpsTool] ? (raw as OpsTool) : null;
}

/** intent_norm (§11.5): lower-case, punctuation stripped, stop words removed, tokens sorted. */
const STOP = new Set('a an the to of for and or in on at by with from is are be was were it this that i me my we our you your please can could would should want need like some any all'.split(' '));
export function normalizeIntent(s: string): string {
  return [...new Set((s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => !STOP.has(w)))].sort().join(' ');
}

export interface OpsDeps {
  db: Kysely<MainDB>;
  audit: AuditRecorder;
  tracker: TaskTracker;
  limiter: RateLimiter;
  pages: ResultPages;
  errors: ErrorEvents;
  pipeline: Pipeline;
  redactor: () => Promise<Redactor>;
  metrics?: Metrics;
  now: () => number;
  log: { warn: (o: object, m: string) => void };
  /** Optional embedding similarity for need grouping (≥ 0.88 cosine to a group centroid). */
  embed?: (text: string) => Promise<Float32Array | null>;
  onInboxChanged?: (tenantId: string) => void;
}

const cap = (s: unknown, n = TEXT_CAP): string => (typeof s === 'string' ? s : s === undefined || s === null ? '' : JSON.stringify(s)).slice(0, n);

/**
 * `neurouter_*` ops tools (§11): toggled per server, audited as `ops_call`, rate-limited 60/min per
 * credential, and never fail the agent's task — on internal error they answer `{ recorded: false }`.
 */
export class OpsTools {
  constructor(private readonly d: OpsDeps) {}

  private async redactText(s: string): Promise<string> {
    const r = (await this.d.redactor()).redact(s).value;
    return typeof r === 'string' ? r : JSON.stringify(r);
  }

  async call(ctx: RunContext, op: OpsTool | typeof READ_RESULT, args: Record<string, unknown>): Promise<{ result: McpToolResult; value: unknown }> {
    const start = this.d.now();
    const auditId = newId();
    this.d.metrics?.opsCalls.inc({ tool: op });
    const rl = await this.d.limiter.take([this.d.limiter.opsCheck(ctx.credentialKey)]);
    let value: Record<string, unknown>;
    let status: 'ok' | 'blocked' = 'ok';
    if (!rl.allowed) {
      value = { recorded: false, reason: 'rate_limited', retry_after_ms: rl.retryAfterMs };
      status = 'blocked';
    } else {
      try {
        value = await this.dispatch(ctx, op, args, auditId);
      } catch (err) {
        this.d.log.warn({ err, op }, 'ops tool failed; returning recorded:false');
        value = { recorded: false };
      }
    }
    if (op !== 'begin_task' && op !== 'end_task') this.d.tracker.bump(ctx.taskId, { ops_count: 1, ...(op === 'log_decision' && value.recorded !== false ? { decision_count: 1 } : {}) });
    const taskId = typeof value.task_id === 'string' ? value.task_id : ctx.taskId;
    this.d.audit.record({
      ...this.d.pipeline.auditBase({ ...ctx, taskId }),
      id: auditId,
      kind: 'ops_call',
      toolName: opsMcpName(op),
      decision: status === 'blocked' ? 'denied_rate_limit' : 'allowed',
      status,
      params: args,
      output: value,
      latencyMs: this.d.now() - start,
    });
    const meta: Record<string, unknown> = { [META_CALL_ID]: auditId, ...(taskId ? { [META_TASK_ID]: taskId } : {}) };
    return { value, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, _meta: meta } };
  }

  private owner(ctx: RunContext) {
    const p = ctx.principal;
    return {
      tenantId: ctx.tenantId,
      serverId: ctx.server.id,
      environmentId: ctx.environment.id,
      credentialKey: ctx.credentialKey,
      clientName: ctx.client.name,
      clientVersion: ctx.client.version,
      principalType: p.type,
      userId: principalUserId(p),
      apiKeyId: p.type === 'api_key' ? p.apiKeyId : null,
      oauthClientId: p.type === 'user' ? p.oauthClientId : null,
      traceId: null,
    };
  }

  private async dispatch(ctx: RunContext, op: OpsTool | typeof READ_RESULT, a: Record<string, unknown>, auditId: string): Promise<Record<string, unknown>> {
    const db = this.d.db;
    const now = this.d.now();
    switch (op) {
      case 'begin_task': {
        const goal = await this.redactText(cap(a.goal));
        if (!goal) return { recorded: false, reason: 'goal is required' };
        const r = await this.d.tracker.begin(this.owner(ctx), goal, ctx.taskId);
        ctx.taskId = r.taskId;
        return { task_id: r.taskId, attached_calls: r.attachedCalls };
      }
      case 'end_task': {
        const outcome = a.outcome === 'success' || a.outcome === 'partial' || a.outcome === 'failure' ? a.outcome : 'success';
        let taskId = typeof a.task_id === 'string' ? a.task_id : ctx.taskId;
        if (taskId) {
          const own = await db.selectFrom('tasks').select(['credential_key']).where('id', '=', taskId).executeTakeFirst();
          if (!own || own.credential_key !== ctx.credentialKey) taskId = ctx.taskId;
        }
        if (!taskId) return { recorded: false, reason: 'no open task' };
        await this.d.tracker.bumpNow(taskId, { ops_count: 1 });
        const notes = a.notes === undefined ? null : await this.redactText(cap(a.notes));
        await this.d.tracker.close(taskId, outcome, notes);
        const t = await db.selectFrom('tasks').select(['call_count', 'error_count', 'started_at', 'ended_at', 'framing', 'server_id']).where('id', '=', taskId).executeTakeFirst();
        this.d.metrics?.tasksTotal.inc({ server: ctx.server.slug, framing: t?.framing ?? 'explicit', outcome });
        return { task_id: taskId, calls: t?.call_count ?? 0, errors: t?.error_count ?? 0, duration_ms: t ? Number(t.ended_at ?? now) - Number(t.started_at) : 0 };
      }
      case 'log_decision': {
        const alternatives = Array.isArray(a.alternatives) ? await Promise.all(a.alternatives.slice(0, 5).map((x) => this.redactText(cap(x, 200)))) : [];
        await db.insertInto('decisions').values({ id: newId(), tenant_id: ctx.tenantId, task_id: ctx.taskId, ts: now, choice: await this.redactText(cap(a.choice)), reason: await this.redactText(cap(a.reason)), alternatives: toJsonColumn(alternatives), audit_id: auditId }).execute();
        return { recorded: true };
      }
      case 'report_unmet_need': {
        const intent = await this.redactText(cap(a.intent));
        if (!intent) return { recorded: false, reason: 'intent is required' };
        const attempted = Array.isArray(a.attempted) ? a.attempted.filter((x): x is string => typeof x === 'string').slice(0, 20).map((x) => x.slice(0, 64)) : [];
        const groupId = await this.groupFor(ctx, intent, now);
        await db.insertInto('unmet_needs').values({ id: newId(), tenant_id: ctx.tenantId, group_id: groupId, server_id: ctx.server.id, environment_id: ctx.environment.id, task_id: ctx.taskId, user_id: principalUserId(ctx.principal), credential_key: ctx.credentialKey, client_name: ctx.client.name, intent, attempted: toJsonColumn(attempted), created_at: now, audit_id: auditId }).execute();
        const agg = await db.selectFrom('unmet_needs').select([(eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.count<number>('credential_key').distinct().as('p')]).where('group_id', '=', groupId).executeTakeFirst();
        await db.updateTable('need_groups').set({ count: Number(agg?.n ?? 1), distinct_principals: Number(agg?.p ?? 1), last_seen_at: now }).where('id', '=', groupId).execute();
        this.d.metrics?.unmetNeeds.inc({ server: ctx.server.slug });
        this.d.onInboxChanged?.(ctx.tenantId);
        return { recorded: true, group_id: groupId, similar_reports: Math.max(0, Number(agg?.n ?? 1) - 1) };
      }
      case 'report_issue': {
        const tool = cap(a.tool, 64);
        const problem = await this.redactText(cap(a.problem));
        if (!tool || !problem) return { recorded: false, reason: 'tool and problem are required' };
        let evidence: unknown = null;
        if (a.evidence !== undefined) {
          const json = JSON.stringify(a.evidence) ?? 'null';
          evidence = Buffer.byteLength(json) <= 4096 ? (await this.d.redactor()).redact(a.evidence).value : { truncated: (await this.redactText(json.slice(0, 4000))) };
        }
        let related: string | null = null;
        if (typeof a.error_id === 'string') related = (await this.d.errors.get(ctx.tenantId, a.error_id))?.auditId ?? null;
        const id = newId();
        await db.insertInto('issues').values({ id, tenant_id: ctx.tenantId, server_id: ctx.server.id, environment_id: ctx.environment.id, task_id: ctx.taskId, tool_name: tool, problem, evidence: evidence === null ? null : toJsonColumn(evidence), related_audit_id: related, status: 'open', note: null, created_at: now, updated_at: now }).execute();
        this.d.metrics?.issues.inc({ server: ctx.server.slug });
        this.d.onInboxChanged?.(ctx.tenantId);
        return { recorded: true, issue_id: id };
      }
      case 'explain_error': {
        const id = typeof a.error_id === 'string' ? a.error_id : '';
        const ev = id ? await this.d.errors.get(ctx.tenantId, id) : null;
        if (!ev) return { code: 'unknown', title: 'Unknown error id', explanation: `No error ${id} is known (they expire after 7 days).`, how_to_fix: 'Retry the call to get a fresh error_id.', details: {} };
        return { ...explain(ev.code as ErrorCode, ev.detail), details: ev.detail };
      }
      case 'get_examples': {
        const toolName = cap(a.tool, 64);
        const kind = a.kind === 'script' ? 'script' : 'call';
        const rows = await db.selectFrom('examples').select(['arguments', 'code', 'source']).where('server_id', '=', ctx.server.id).where('tool_name', '=', toolName).where('kind', '=', kind).orderBy('success_count', 'desc').limit(5).execute();
        const t = ctx.bundle.build.tools.find((x) => x.name === toolName && !x.hidden);
        const out: Array<Record<string, unknown>> = rows.map((r) => (kind === 'call' ? { arguments: parseJsonColumn(r.arguments) } : { code: r.code }));
        if (kind === 'call' && t) for (const e of t.examples) if (out.length < 5) out.unshift({ ...(e.title ? { title: e.title } : {}), arguments: e.arguments });
        return { examples: out.slice(0, 5), source: rows[0]?.source ?? (t?.examples.length ? 'overlay' : 'none') };
      }
      case 'whoami': {
        const e = ctx.bundle.environment;
        const p = ctx.principal;
        const writeTools = ctx.bundle.build.tools.filter((t) => t.risk.write && !t.hidden);
        return {
          server: ctx.server.slug,
          environment: e.slug,
          environment_kind: e.kind,
          principal: { type: p.type, id: principalId(p), name: p.name },
          scopes: p.scopes,
          writes: { enabled: e.writes.enabled && p.scopes.includes('tools:write'), tools: e.writes.tools ?? writeTools.filter((t) => writeEnabled(ctx, t)).map((t) => t.name), confirm: e.writes.confirm, client_can_confirm: ctx.client.era === 'modern' && Boolean((ctx.client.caps as Record<string, unknown> | null)?.elicitation) },
          code_mode: e.codeMode && ctx.bundle.codeModeEnabled && p.scopes.includes('code:run'),
          limits: { rate_limit: (p.type === 'api_key' ? p.rateLimit : null) ?? e.limits.rateLimit, code: e.limits.code },
          profile: p.type === 'api_key' ? p.profile : null,
        };
      }
      case 'read_result': {
        const handle = typeof a.handle === 'string' ? a.handle : '';
        const offset = Number.isInteger(a.offset) ? Math.max(0, a.offset as number) : 0;
        const limit = Number.isInteger(a.limit) ? Math.min(200, Math.max(1, a.limit as number)) : 50;
        const page = await this.d.pages.read(ctx.tenantId, ctx.credentialKey, handle, offset, limit);
        if (!page) return { recorded: false, reason: 'unknown or expired handle' };
        return page;
      }
    }
  }

  /** Need grouping (§11.5): same normalized-intent hash, else nearest group (cosine ≥ 0.88) when embeddings are ready, else new. */
  private async groupFor(ctx: RunContext, intent: string, now: number): Promise<string> {
    const db = this.d.db;
    const hash = sha256Hex(normalizeIntent(intent) || intent.toLowerCase());
    const same = await db.selectFrom('need_groups').select('id').where('tenant_id', '=', ctx.tenantId).where('server_id', '=', ctx.server.id).where('intent_norm_hash', '=', hash).executeTakeFirst();
    if (same) return same.id;
    let vec: Float32Array | null = null;
    try {
      vec = this.d.embed ? await this.d.embed(intent) : null;
    } catch {
      vec = null;
    }
    if (vec) {
      const groups = await db.selectFrom('need_groups').select(['id', 'centroid', 'count']).where('tenant_id', '=', ctx.tenantId).where('server_id', '=', ctx.server.id).where('centroid', 'is not', null).execute();
      let best: { id: string; sim: number; c: Float32Array; n: number } | null = null;
      for (const g of groups) {
        const c = new Float32Array(new Uint8Array(g.centroid!).buffer.slice(0));
        if (c.length !== vec.length) continue;
        const sim = cosine(c, vec);
        if (!best || sim > best.sim) best = { id: g.id, sim, c, n: Number(g.count) };
      }
      if (best && best.sim >= 0.88) {
        const n = best.n + 1;
        const merged = best.c.map((x, i) => (x * best!.n + vec![i]!) / n);
        await db.updateTable('need_groups').set({ centroid: Buffer.from(new Uint8Array(merged.buffer)) }).where('id', '=', best.id).execute();
        return best.id;
      }
    }
    const id = newId();
    await db.insertInto('need_groups').values({ id, tenant_id: ctx.tenantId, server_id: ctx.server.id, label: intent.slice(0, 200), intent_norm_hash: hash, count: 0, distinct_principals: 0, first_seen_at: now, last_seen_at: now, status: 'open', note: null, centroid: vec ? Buffer.from(new Uint8Array(vec.buffer)) : null }).execute();
    return id;
  }
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}
