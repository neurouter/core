import { createHash } from 'node:crypto';
import { BUDGET, type State, type StateFlag } from './types.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** Short stable task handle (`t_` + 8 base62) for a task id. */
export function taskHandle(taskId: string): string {
  const h = createHash('sha256').update(taskId).digest();
  let out = 't_';
  for (let i = 0; i < 8; i++) out += B62[h[i]! % 62];
  return out;
}

interface TaskState {
  calls: number;
  env: string;
  writes: string;
  lastCall: string | null;
  lastResult: string | null;
  streak: number;
  at: number;
}

export interface StateInput {
  /** the task's tenant (the database step is tenant-scoped) */
  tenantId?: string;
  /** task id (inferred or explicit); null falls back to the request */
  taskId: string | null;
  requestId: string;
  env: string;
  writes: 'off' | 'on' | 'confirm';
  /** canonical `tool + args` of this call */
  callKey: string;
  /** canonical digest of this call's outcome (ok, data, error code) */
  resultKey: string;
  /** a write tool was called (state is shown in full) */
  write: boolean;
  wrote?: string;
  left?: { calls?: number; seconds?: number };
  scriptCalls?: number;
  flags?: StateFlag[];
  /** flags shown with the full form only (`prod`) */
  fullFlags?: StateFlag[];
  flagPaths?: string[];
  now: number;
}

/** Where the state block's counters live: the task row (P3) or memory (no task row; unit tests). */
export interface StateSource {
  next(i: StateInput): State | Promise<State>;
}

/** The counters behind one state block. */
export interface StepCounts {
  calls: number;
  streak: number;
  /** show the full form (first call, env/writes changed) */
  changed: boolean;
}

/** The state block from its counters: full form on the first call, on changes and on writes; short form otherwise. */
export function stateOf(i: StateInput, c: StepCounts): State {
  const full = c.changed || i.write;
  const flags = [...(full ? (i.fullFlags ?? []) : []), ...(i.flags ?? [])];
  const state: State = {
    ...(full ? { env: i.env, writes: i.writes } : {}),
    task: taskHandle(i.taskId ?? i.requestId),
    call: c.calls,
    ...(c.streak >= 2 ? { streak: c.streak } : {}),
    ...(i.left && Object.keys(i.left).length ? { left: i.left } : {}),
    ...(i.wrote ? { wrote: i.wrote } : {}),
    ...(i.scriptCalls !== undefined ? { script_calls: i.scriptCalls } : {}),
    ...(flags.length ? { flags: [...new Set(flags)] } : {}),
    ...(i.flagPaths?.length ? { flag_paths: i.flagPaths.slice(0, 3) } : {}),
  };
  return fitState(state);
}

/**
 * Contract 2, P3: the state block counted in the task row (`TaskTracker.step`), so every instance serving a task
 * shows the same call number and streak. Calls without a task row fall back to the in-memory tracker.
 */
export class TaskStateSource implements StateSource {
  constructor(
    private readonly tracker: { step(taskId: string, tenantId: string, i: { callKey: string; resultKey: string; env: string; writes: string }): Promise<StepCounts | null> },
    private readonly fallback: StateTracker = new StateTracker(),
  ) {}

  async next(i: StateInput): Promise<State> {
    if (!i.taskId || !i.tenantId) return this.fallback.next(i);
    const c = await this.tracker.step(i.taskId, i.tenantId, { callKey: i.callKey, resultKey: i.resultKey, env: i.env, writes: i.writes }).catch(() => null);
    return c ? stateOf(i, c) : this.fallback.next(i);
  }
}

/**
 * The per-task state block in memory (bounded LRU): the fallback for calls without a task row, and unit tests.
 */
export class StateTracker implements StateSource {
  private readonly tasks = new Map<string, TaskState>();

  constructor(private readonly max = 10_000) {}

  next(i: StateInput): State {
    const key = i.taskId ?? `req:${i.requestId}`;
    const prev = this.tasks.get(key);
    const same = prev !== undefined && prev.lastCall === i.callKey && prev.lastResult === i.resultKey;
    const cur: TaskState = {
      calls: (prev?.calls ?? 0) + 1,
      env: i.env,
      writes: i.writes,
      lastCall: i.callKey,
      lastResult: i.resultKey,
      streak: same ? prev!.streak + 1 : 1,
      at: i.now,
    };
    this.tasks.delete(key);
    this.tasks.set(key, cur);
    if (this.tasks.size > this.max) this.tasks.delete(this.tasks.keys().next().value!);
    return stateOf(i, { calls: cur.calls, streak: cur.streak, changed: !prev || prev.env !== i.env || prev.writes !== i.writes });
  }
}

/** Keeps the state block within 50 tokens (characters ÷ 4 ≤ 200). */
export function fitState(s: State): State {
  const out = { ...s };
  const size = () => JSON.stringify(out).length;
  if (size() > BUDGET.stateChars && out.flag_paths) out.flag_paths = out.flag_paths.map((p) => (p.length > 40 ? `${p.slice(0, 39)}…` : p)).slice(0, 2);
  if (size() > BUDGET.stateChars && out.wrote) out.wrote = out.wrote.length > 60 ? `${out.wrote.slice(0, 59)}…` : out.wrote;
  if (size() > BUDGET.stateChars) delete out.flag_paths;
  if (size() > BUDGET.stateChars && out.wrote) out.wrote = `${out.wrote.slice(0, 30)}…`;
  return out;
}
