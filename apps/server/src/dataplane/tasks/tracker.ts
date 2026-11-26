import type { Kysely } from 'kysely';
import type { TaskFraming, TaskOutcome } from '@neurouter/shared';
import type { MainDB } from '../../kernel/db/schema.js';
import { newId } from '../../kernel/lib/ids.js';
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
    private readonly onChange?: (taskId: string) => void,
  ) {}

  private key(o: Pick<TaskOwner, 'environmentId' | 'credentialKey' | 'clientName'>): string {
    return `${o.environmentId}|${o.credentialKey}|${o.clientName ?? ''}`;
  }

  /** Resolves the request's task; `create: false` only looks (tools/list does not open tasks). */
  async resolve(o: TaskOwner, metaTaskId: string | null, opts: { create: boolean; framing?: TaskFraming } = { create: true }): Promise<{ taskId: string | null; created: boolean; framing: TaskFraming | null }> {
    const t = this.now();
    if (metaTaskId) {
      const row = await this.db.selectFrom('tasks').select(['id', 'credential_key', 'status', 'framing']).where('id', '=', metaTaskId).executeTakeFirst();
      if (row && row.credential_key === o.credentialKey && row.status === 'open') return { taskId: row.id, created: false, framing: row.framing };
    }
    const k = this.key(o);
    const hit = this.cache.get(k);
    let open: { id: string; framing: TaskFraming } | null = null;
    if (hit && t - hit.at < 5000 && hit.taskId) {
      const row = await this.db.selectFrom('tasks').select(['id', 'framing', 'status', 'last_activity_at']).where('id', '=', hit.taskId).executeTakeFirst();
      if (row && row.status === 'open' && row.last_activity_at > t - TASK_IDLE_MS) open = { id: row.id, framing: row.framing };
    }
    if (!open) {
      let q = this.db
        .selectFrom('tasks')
        .select(['id', 'framing'])
        .where('credential_key', '=', o.credentialKey)
        .where('environment_id', '=', o.environmentId)
        .where('status', '=', 'open')
        .where('last_activity_at', '>', t - TASK_IDLE_MS)
        .orderBy('last_activity_at', 'desc')
        .limit(1);
      q = o.clientName === null ? q.where('client_name', 'is', null) : q.where('client_name', '=', o.clientName);
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
      })
      .execute();
    this.cache.set(this.key(o), { at: t, taskId: id });
    this.onChange?.(id);
    return id;
  }

  /** `neurouter_begin_task`: closes the open explicit task of (credential, client) as abandoned, opens a new explicit one. */
  async begin(o: TaskOwner, goal: string, currentTaskId: string | null): Promise<{ taskId: string; attachedCalls: number }> {
    const t = this.now();
    // an inferred task that has only just started (no explicit framing yet) is upgraded instead of replaced
    if (currentTaskId) {
      const cur = await this.db.selectFrom('tasks').select(['id', 'framing', 'call_count', 'goal']).where('id', '=', currentTaskId).executeTakeFirst();
      if (cur && cur.framing === 'inferred') {
        await this.db.updateTable('tasks').set({ framing: 'explicit', goal, last_activity_at: t }).where('id', '=', cur.id).execute();
        this.onChange?.(cur.id);
        return { taskId: cur.id, attachedCalls: cur.call_count };
      }
      if (cur && cur.framing === 'explicit') await this.close(cur.id, 'abandoned', null);
    }
    const id = await this.create(o, 'explicit', goal);
    return { taskId: id, attachedCalls: 0 };
  }

  async close(taskId: string, outcome: TaskOutcome, notes: string | null): Promise<void> {
    const t = this.now();
    await this.db.updateTable('tasks').set({ status: 'closed', outcome, notes, ended_at: t, last_activity_at: t }).where('id', '=', taskId).where('status', '=', 'open').execute();
    for (const [k, v] of this.cache) if (v.taskId === taskId) this.cache.delete(k);
    this.history.delete(taskId);
    this.onChange?.(taskId);
  }

  /** Counter bump + activity (fire-and-forget from the hot path). */
  bump(taskId: string | null, fields: Partial<Record<CounterField, number>>): void {
    if (!taskId) return;
    const t = this.now();
    const work = async () => {
      const row = await this.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
      if (!row) return;
      const set: Record<string, number> = { last_activity_at: t };
      for (const [k, v] of Object.entries(fields)) set[k] = Number(row[k as CounterField] ?? 0) + (v ?? 0);
      await this.db.updateTable('tasks').set(set).where('id', '=', taskId).execute();
      this.onChange?.(taskId);
    };
    void work().catch(() => {});
  }

  async bumpNow(taskId: string | null, fields: Partial<Record<CounterField, number>>): Promise<void> {
    if (!taskId) return;
    const row = await this.db.selectFrom('tasks').selectAll().where('id', '=', taskId).executeTakeFirst();
    if (!row) return;
    const set: Record<string, number> = { last_activity_at: this.now() };
    for (const [k, v] of Object.entries(fields)) set[k] = Number(row[k as CounterField] ?? 0) + (v ?? 0);
    await this.db.updateTable('tasks').set(set).where('id', '=', taskId).execute();
  }

  /** Returns true the first time it is called for a task (one-time begin_task tip on inferred tasks). */
  async takeHint(taskId: string): Promise<boolean> {
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
    const rows = await this.db.selectFrom('tasks').select(['id', 'framing']).where('status', '=', 'open').where('last_activity_at', '<=', cutoff).limit(1000).execute();
    for (const r of rows) await this.close(r.id, r.framing === 'explicit' ? 'abandoned' : 'unknown', null);
    return rows.length;
  }
}
