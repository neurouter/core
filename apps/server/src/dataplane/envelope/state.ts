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

/**
 * The per-task state block (contract-v2 §2.4): call counter and identical-result streaks per task. In memory
 * per instance (bounded LRU); a task served by several instances counts per instance (P3 moves task state
 * to the task tracker).
 */
export class StateTracker {
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
    const full = !prev || prev.env !== i.env || prev.writes !== i.writes || i.write;
    const flags = [...(full ? (i.fullFlags ?? []) : []), ...(i.flags ?? [])];
    const state: State = {
      ...(full ? { env: i.env, writes: i.writes } : {}),
      task: taskHandle(i.taskId ?? i.requestId),
      call: cur.calls,
      ...(cur.streak >= 2 ? { streak: cur.streak } : {}),
      ...(i.left && Object.keys(i.left).length ? { left: i.left } : {}),
      ...(i.wrote ? { wrote: i.wrote } : {}),
      ...(i.scriptCalls !== undefined ? { script_calls: i.scriptCalls } : {}),
      ...(flags.length ? { flags: [...new Set(flags)] } : {}),
      ...(i.flagPaths?.length ? { flag_paths: i.flagPaths.slice(0, 3) } : {}),
    };
    return fitState(state);
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
