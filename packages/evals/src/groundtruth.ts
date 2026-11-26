/**
 * Outcome-based ground truth. A task's expected values are not frozen at generation: at run time the
 * task's reference calls are executed against the same mock seed (and data version) the agent's
 * namespace uses, and answer checks name values of that outcome symbolically (`ref[0].data.name`).
 * Paths: `ref[<i>]` then `.field`, `[<n>]`, `[*]` (every element) or `["field with spaces"]`.
 * `ref[i].data` is the tool's result value: the contract-2 envelope's `data`, or the contract-1 body.
 */
import type { ReferenceCall } from '@neurouter/shared';
import type { McpCallResult } from './mcp.js';
import { resultText } from './mcp.js';
import type { ObservedCall } from './types.js';

export interface RefOutcome {
  tool: string;
  ok: boolean;
  /** The result value (envelope `data` on contract 2, the body on contract 1). */
  data: unknown;
  error?: string | null;
}

export interface GroundTruth {
  refs: RefOutcome[];
  /** Per reference index: the outcome of each alternative tool, called with the same arguments. */
  alternatives?: Record<number, Record<string, RefOutcome>>;
}

/** One reference session: a fresh mock namespace with the attempt's seed and data version. */
export interface RefSession {
  call(tool: string, args: Record<string, unknown>): Promise<RefOutcome>;
  close?(): Promise<void>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** A contract-2 result envelope (`{ok, data, page, truncated, error, state}`). */
export function isEnvelope(v: unknown): v is { ok: boolean; data?: unknown; error?: { message?: string; code?: string } | null } {
  return isObj(v) && typeof v.ok === 'boolean' && ('data' in v || 'error' in v) && ('state' in v || 'page' in v || 'truncated' in v || 'error' in v);
}

/** Parses a tool result text (contract 1: the body as JSON or text; contract 2: the envelope). */
export function parseResultText(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return t;
  }
}

/** The outcome of one MCP tool result, for both contracts. */
export function outcomeFromResult(tool: string, res: McpCallResult): RefOutcome {
  const text = resultText(res);
  let v: unknown = parseResultText(text);
  if (typeof v === 'string' && isObj(res.structuredContent)) v = res.structuredContent;
  if (isEnvelope(v)) {
    const ok = v.ok && !res.isError;
    return { tool, ok, data: v.data ?? null, error: ok ? null : (v.error?.message ?? v.error?.code ?? 'error') };
  }
  return { tool, ok: !res.isError, data: v, error: res.isError ? text.slice(0, 300) : null };
}

/** The value of a transcript tool-result text (contract 2 envelopes unwrapped to `data`). */
export function resultValue(text: string): unknown {
  const v = parseResultText(text);
  return isEnvelope(v) ? (v.data ?? null) : v;
}

type Seg = { key: string } | { index: number } | { all: true };

export function parseGroundTruthPath(path: string): { ref: number; segs: Seg[] } | null {
  const m = /^ref\[(\d+)\]/.exec(path);
  if (!m) return null;
  const segs: Seg[] = [];
  let rest = path.slice(m[0].length);
  while (rest.length) {
    let mm: RegExpExecArray | null;
    if ((mm = /^\.([^.[\]]+)/.exec(rest))) segs.push({ key: mm[1]! });
    else if ((mm = /^\[(\d+)\]/.exec(rest))) segs.push({ index: Number(mm[1]) });
    else if ((mm = /^\[\*\]/.exec(rest))) segs.push({ all: true });
    else if ((mm = /^\["((?:[^"\\]|\\.)*)"\]/.exec(rest))) segs.push({ key: JSON.parse(`"${mm[1]!}"`) as string });
    else return null;
    rest = rest.slice(mm[0].length);
  }
  return { ref: Number(m[1]), segs };
}

export function formatGroundTruthPath(ref: number, segs: Array<string | number | '*'>): string {
  return `ref[${ref}]${segs.map((s) => (s === '*' ? '[*]' : typeof s === 'number' ? `[${s}]` : /^[A-Za-z_][A-Za-z0-9_]*$/.test(s) ? `.${s}` : `[${JSON.stringify(s)}]`)).join('')}`;
}

/** Every value at a path (wildcards expand); `[]` when the path does not resolve. */
export function resolvePath(gt: GroundTruth, path: string): unknown[] {
  const p = parseGroundTruthPath(path);
  const ref = p ? gt.refs[p.ref] : undefined;
  if (!p || !ref) return [];
  let cur: unknown[] = [{ data: ref.data, ok: ref.ok, error: ref.error ?? null }];
  for (const s of p.segs) {
    const next: unknown[] = [];
    for (const v of cur) {
      if ('key' in s) {
        if (isObj(v) && s.key in v) next.push(v[s.key]);
      } else if ('index' in s) {
        if (Array.isArray(v) && s.index < v.length) next.push(v[s.index]);
      } else if (Array.isArray(v)) next.push(...v);
    }
    cur = next;
  }
  return cur.filter((v) => v !== undefined);
}

export function hasWildcard(path: string | string[]): boolean {
  return (Array.isArray(path) ? path : [path]).some((p) => p.includes('[*]'));
}

/** `{"$from": "<path>"}` (a value taken from an earlier reference result). */
export function isFromRef(v: unknown): v is { $from: string } {
  return isObj(v) && typeof v.$from === 'string' && Object.keys(v).length === 1;
}

/** Replaces `{"$from": path}` values by the first value at the path (unresolvable ones stay as they are). */
export function resolveArgs<T>(v: T, gt: GroundTruth | null | undefined): T {
  if (isFromRef(v)) {
    const got = gt ? resolvePath(gt, v.$from) : [];
    return (got.length ? got[0] : v) as T;
  }
  if (Array.isArray(v)) return v.map((x) => resolveArgs(x, gt)) as T;
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, resolveArgs(x, gt)])) as T;
  return v;
}

/**
 * Executes a task's reference calls in one fresh session (each call's `$from` arguments resolved from
 * the earlier outcomes), then each reference's alternative tools with the same arguments.
 */
export async function computeGroundTruth(refs: ReferenceCall[], open: () => Promise<RefSession>): Promise<GroundTruth> {
  const gt: GroundTruth = { refs: [] };
  if (!refs.length) return gt;
  const s = await open();
  try {
    for (const r of refs) {
      const args = resolveArgs(r.arguments, gt);
      gt.refs.push(await s.call(r.tool, args).catch((err: unknown) => ({ tool: r.tool, ok: false, data: null, error: (err as Error).message })));
    }
    for (const [i, r] of refs.entries()) {
      if (!r.alternatives?.length) continue;
      const args = resolveArgs(r.arguments, gt);
      const alts: Record<string, RefOutcome> = {};
      for (const a of r.alternatives) alts[a.tool] = await s.call(a.tool, args).catch((err: unknown) => ({ tool: a.tool, ok: false, data: null, error: (err as Error).message }));
      (gt.alternatives ??= {})[i] = alts;
    }
  } finally {
    await s.close?.().catch(() => {});
  }
  return gt;
}

/**
 * The ground truth as the agent's path saw it: a reference whose tool the agent never called, but one of
 * whose alternatives it did call successfully, is replaced by that alternative's outcome.
 */
export function groundTruthForCalls(gt: GroundTruth, refs: ReferenceCall[], calls: Pick<ObservedCall, 'tool' | 'status'>[]): GroundTruth {
  if (!gt.alternatives) return gt;
  const out: RefOutcome[] = gt.refs.map((r, i) => {
    const alts = gt.alternatives?.[i];
    if (!alts || calls.some((c) => c.tool === refs[i]?.tool && c.status === 'ok')) return r;
    const used = Object.keys(alts).find((t) => calls.some((c) => c.tool === t && c.status === 'ok'));
    return used ? alts[used]! : r;
  });
  return { ...gt, refs: out };
}

/** Compact ground-truth preview for reports (scalar leaves only, ≤ `max` characters). */
export function groundTruthPreview(gt: GroundTruth, max = 600): string {
  const s = JSON.stringify(gt.refs.map((r) => ({ tool: r.tool, ok: r.ok, ...(r.error ? { error: r.error } : {}), data: r.data })));
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
