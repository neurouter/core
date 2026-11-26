import { sql, type Kysely } from 'kysely';
import type { TaskFraming, TaskOutcome } from '@neurouter/shared';
import type { MainDB } from '../../kernel/db/schema.js';
import { newId } from '../../kernel/lib/ids.js';
import { toJsonColumn } from '../../kernel/lib/json.js';
import type { PriorCall } from '../pipeline/policy.js';

export const TASK_IDLE_MS = 10 * 60_000;

export interface TaskOwner {
  tenantId: string;
  serverId: string;
  environmentId: string;
  credentialKey: string;
  clientName: string | null;
  clientVersion: string | null;
  principalType: string;
  userId: string | null;
  apiKeyId: string | null;
  oauthClientId: string | null;
  traceId: string | null;
  /** Persisted as `tasks.origin` (eval tasks stay filterable after their eval key is garbage-collected). */
  origin: 'live' | 'eval';
  /** contract 2 (D1): the MCP session id, when the client has one; tasks are inferred per session */
  sessionKey?: string | null;
}

/** One step of a task's state block (contract-v2 §2.4), computed in the database so every instance counts the same. */
export interface StateStep {
  /** n-th call of the task */
  calls: number;
  /** identical call + result streak (1 = not a repeat) */
  streak: number;
  /** first call of the task, or env/writes changed since the last answer */
  changed: boolean;
}

export type CounterField = 'call_count' | 'error_count' | 'write_count' | 'blocked_count' | 'script_count' | 'decision_count' | 'ops_count';

/**
 * Task framing (§11.2, §12.1; idle-gap logic ADAPT Hub observability/sessions.ts):
 * explicit `_meta` task id (same credential only) → the open task of (credential, client) active in
 * the last 10 min → a new inferred task. One indexed read per request, cached 5 s per credential.
 * Also keeps a bounded in-memory call history per task for data-flow policies.
 */
export class TaskTracker {
  private readonly cache = new Map<string, { at: number; taskId: string | null }>();
  private readonly history = new Map<string, PriorCall[]>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly now: () => number,
    /** Task changed (SSE `task.updated`); carries the task's tenant so only that tenant's consoles hear it (spec §4.7). */
    private readonly onChange?: (taskId: string, tenantId: string) => void,
  ) {}

  private key(o: Pick<TaskOwner, 'environmentId' | 'credentialKey' | 'clientName' | 'sessionKey'>): string {
    return `${o.environmentId}|${o.credentialKey}|${o.clientName ?? ''}|${o.sessionKey ?? ''}`;
  }

  /** Resolves the request's task; `create: false` only looks (tools/list does not open tasks). */
  async resolve(o: TaskOwner, metaTaskId: string | null, opts: { create: boolean; framing?: TaskFraming } = { create: true }): Promise<{ taskId: string | null; created: boolean; framing: TaskFraming | null }> {
    const t = this.now();
    if (metaTaskId) {
      const row = await this.db.selectFrom('tasks').select(['id', 'credential_key', 'status', 'framing']).where('id', '=', metaTaskId).where('tenant_id', '=', o.tenantId).executeTakeFirst();
      if (row && row.credential_key === o.credentialKey && row.status === 'open') return { taskId: row.id, created: false, framing: row.framing };
    }
    const k = this.key(o);
    const hit = this.cache.get(k);
    let open: { id: string; framing: TaskFraming } | null = null;
    if (hit && t - hit.at < 5000 && hit.taskId) {
      const row = await this.db.selectFrom('tasks').select(['id', 'framing', 'status', 'last_activity_at']).where('id', '=', hit.taskId).where('tenant_id', '=', o.tenantId).executeTakeFirst();
      if (row && row.status === 'open' && row.last_activity_at > t - TASK_IDLE_MS) open = { id: row.id, framing: row.framing };
    }
    if (!open) {
      let q = this.db
        .selectFrom('tasks')
        .select(['id', 'framing'])
        .where('tenant_id', '=', o.tenantId)
        .where('credential_key', '=', o.credentialKey)
        .where('environment_id', '=', o.environmentId)
        .where('status', '=', 'open')
        .where('last_activity_at', '>', t - TASK_IDLE_MS)
        .orderBy('last_activity_at', 'desc')
        .limit(1);
      q = o.clientName === null ? q.where('client_name', 'is', null) : q.where('client_name', '=', o.clientName);
      // contract 2 (D1): a session's calls form its own task (two parallel sessions of one client are two tasks)
      if (o.sessionKey) q = q.where('session_key', '=', o.sessionKey);
      const row = await q.executeTakeFirst();
      if (row) open = { id: row.id, framing: row.framing };
    }
    if (open) {
      this.cache.set(k, { at: t, taskId: open.id });
      return { taskId: open.id, created: false, framing: open.framing };
    }
    if (!opts.create) return { taskId: null, created: false, framing: null };
    const id = await this.create(o, opts.framing ?? 'inferred', null);
    return { taskId: id, created: true, framing: opts.framing ?? 'inferred' };
  }

  async create(o: TaskOwner, framing: TaskFraming, goal: string | null): Promise<string> {
    const id = newId();
    const t = this.now();
    await this.db
      .insertInto('tasks')
      .values({
        id,
        tenant_id: o.tenantId,
        server_id: o.serverId,
        environment_id: o.environmentId,
        user_id: o.userId,
        api_key_id: o.apiKeyId,
        oauth_client_id: o.oauthClientId,
        principal_type: o.principalType,
        credential_key: o.credentialKey,
        client_name: o.clientName,
        client_version: o.clientVersion,
        goal,
        outcome: null,
        notes: null,
        framing,
        inferred_label: null,
        status: 'open',
        started_at: t,
        last_activity_at: t,
        ended_at: null,
        trace_id: o.traceId,
        origin: o.origin,
        session_key: o.sessionKey ?? null,
      })
      .execute();
    this.cache.set(this.key(o), { at: t, taskId: id });
    this.onChange?.(id, o.tenantId);
    return id;
  }

  /** `neurouter_begin_task`: closes the open explicit task of (credential, client) as abandoned, opens a new explicit one. */
  async begin(o: TaskOwner, goal: string, currentTaskId: string | null): Promise<{ taskId: string; attachedCalls: number }> {
    const t = this.now();
    // an inferred task that has only just started (no explicit framing yet) is upgraded instead of replaced
    if (currentTaskId) {
      const cur = await this.db.selectFrom('tasks').select(['id', 'framing', 'call_count', 'goal']).where('id', '=', currentTaskId).where('tenant_id', '=', o.tenantId).executeTakeFirst();
      if (cur && cur.framing === 'inferred') {
        await this.db.updateTable('tasks').set({ framing: 'explicit', goal, last_activity_at: t }).where('id', '=', cur.id).where('tenant_id', '=', o.tenantId).execute();
        this.onChange?.(cur.id, o.tenantId);
        return { taskId: cur.id, attachedCalls: cur.call_count };
      }
      if (cur && cur.framing === 'explicit') await this.close(cur.id, 'abandoned', null);
    }
    const id = await this.create(o, 'explicit', goal);
    return { taskId: id, attachedCalls: 0 };
  }

  async close(taskId: string, outcome: TaskOutcome, notes: string | null): Promise<void> {
    const t = this.now();
    // tenant-scope: tenant-from-row (task ids come from a tenant-scoped resolve; the row's tenant labels the event)
    const row = await this.db.selectFrom('tasks').select('tenant_id').where('id', '=', taskId).executeTakeFirst();
    if (!row) return;
    await this.db.updateTable('tasks').set({ status: 'closed', outcome, notes, ended_at: t, last_activity_at: t }).where('id', '=', taskId).where('tenant_id', '=', row.tenant_id).where('status', '=', 'open').execute();
    for (const [k, v] of this.cache) if (v.taskId === taskId) this.cache.delete(k);
    this.history.delete(taskId);
    this.onChange?.(taskId, row.tenant_id);
  }

  /**
   * `neurouter_report(done|blocked)` (contract-v2 §4.2): closes the task with `success` (done) or `partial`
   * (blocked; the outcome list has no `blocked`, `exit_kind` says it) and the report text as notes.
   */
  async closeWith(taskId: string, tenantId: string, kind: 'done' | 'blocked', notes: string | null): Promise<void> {
    await this.db.updateTable('tasks').set({ exit_kind: kind }).where('id', '=', taskId).where('tenant_id', '=', tenantId).where('status', '=', 'open').execute();
    await this.close(taskId, kind === 'done' ? 'success' : 'partial', notes);
  }

  /**
   * One state-block step (contract-v2 §2.4) in the task row: the call counter increments atomically, the streak
   * counts identical call + result pairs, and `changed` says whether env/writes differ from the last answer. Works
   * across instances (P1 kept this per instance). Null when the task row is gone.
   */
  async step(taskId: string, tenantId: string, i: { callKey: string; resultKey: string; env: string; writes: string }): Promise<StateStep | null> {
    // tenant-scope: child-of-scoped (task id from a tenant-scoped resolve)
    const prev = await this.db.selectFrom('tasks').select(['state_env', 'state_writes', 'state_calls']).where('id', '=', taskId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!prev) return null;
    const row = await this.db
      .updateTable('tasks')
      .set({
        state_calls: sql<number>`state_calls + 1`,
        state_streak: sql<number>`case when state_call_key = ${i.callKey} and state_result_key = ${i.resultKey} then state_streak + 1 else 1 end`,
        state_call_key: i.callKey,
        state_result_key: i.resultKey,
        state_env: i.env,
        state_writes: i.writes,
      })
      .where('id', '=', taskId)
      .where('tenant_id', '=', tenantId)
      .returning(['state_calls', 'state_streak'])
      .executeTakeFirst();
    if (!row) return null;
    return { calls: Number(row.state_calls), streak: Number(row.state_streak), changed: Number(prev.state_calls) === 0 || prev.state_env !== i.env || prev.state_writes !== i.writes };
  }

  /**
   * Contract 2 (D1): an inferred task's label from its first calls (a search query, else the first tool's title)
   * until the labeler job or the agent says more. Only when the task has no goal and no label yet.
   */
  async labelOnce(taskId: string, tenantId: string, goal: string): Promise<void> {
    const label = { goal: goal.slice(0, 200), outcome: 'unknown', confidence: 0.3, model: 'neurouter:first-calls' };
    // tenant-scope: child-of-scoped (task id from a tenant-scoped resolve)
    await this.db.updateTable('tasks').set({ inferred_label: toJsonColumn(label) }).where('id', '=', taskId).where('tenant_id', '=', tenantId).where('inferred_label', 'is', null).where('goal', 'is', null).execute();
  }

  /** Counter bump + activity (fire-and-forget from the hot path). */
  bump(taskId: string | null, fields: Partial<Record<CounterField, number>>): void {
    if (!taskId) return;
    const t = this.now();
    const work = async () => {
      // tenant-scope: child-of-scoped (task id from a tenant-scoped resolve)
      const row = await this.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
      if (!row) return;
      const set: Record<string, number> = { last_activity_at: t };
      for (const [k, v] of Object.entries(fields)) set[k] = Number(row[k as CounterField] ?? 0) + (v ?? 0);
      await this.db.updateTable('tasks').set(set).where('id', '=', taskId).where('tenant_id', '=', row.tenant_id).execute();
      this.onChange?.(taskId, row.tenant_id);
    };
    void work().catch(() => {});
  }

  async bumpNow(taskId: string | null, fields: Partial<Record<CounterField, number>>): Promise<void> {
    if (!taskId) return;
    // tenant-scope: child-of-scoped (task id from a tenant-scoped resolve)
    const row = await this.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
    if (!row) return;
    const set: Record<string, number> = { last_activity_at: this.now() };
    for (const [k, v] of Object.entries(fields)) set[k] = Number(row[k as CounterField] ?? 0) + (v ?? 0);
    await this.db.updateTable('tasks').where('tenant_id', '=', row.tenant_id).set(set).where('id', '=', taskId).execute();
  }

  /** Returns true the first time it is called for a task (one-time begin_task tip on inferred tasks). */
  async takeHint(taskId: string): Promise<boolean> {
    // tenant-scope: child-of-scoped (task id from a tenant-scoped resolve)
    const res = await this.db.updateTable('tasks').set({ hinted: 1 }).where('id', '=', taskId).where('hinted', '=', 0).executeTakeFirst();
    return Number(res.numUpdatedRows) > 0;
  }

  callHistory(taskId: string | null): PriorCall[] {
    return taskId ? (this.history.get(taskId) ?? []) : [];
  }

  remember(taskId: string | null, call: PriorCall): void {
    if (!taskId) return;
    const h = this.history.get(taskId) ?? [];
    h.push(call);
    if (h.length > 200) h.shift();
    this.history.set(taskId, h);
    if (this.history.size > 5000) this.history.delete(this.history.keys().next().value!);
  }

  /** Job `tasks.close-idle`: explicit → abandoned, inferred/script → unknown. */
  async closeIdle(): Promise<number> {
    const cutoff = this.now() - TASK_IDLE_MS;
    // tenant-scope: system-job (idle tasks of every tenant)
    const rows = await this.db.selectFrom('tasks').select(['id', 'framing']).where('status', '=', 'open').where('last_activity_at', '<=', cutoff).limit(1000).execute();
    for (const r of rows) await this.close(r.id, r.framing === 'explicit' ? 'abandoned' : 'unknown', null);
    return rows.length;
  }
}
