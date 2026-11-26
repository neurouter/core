/**
 * Response shaping (backend spec §9.9): include/exclude → flatten → maxItems → redact → maxBytes.
 * Pure; the data plane stores `full` behind a result handle when `truncated` is set.
 */
import type { ResponseShaping } from '@neurouter/shared';
import { deleteAt, flattenAt, includePaths, parsePath, replaceAt } from './overlay/paths.js';
import { clone, isObj, jsonBytes } from './util.js';

export const REDACTED_VALUE = { $redacted: 'overlay' } as const;

export interface TruncationInfo {
  totalItems?: number;
  returnedItems?: number;
  totalBytes: number;
  returnedBytes: number;
}

export interface ShapeResult {
  /** what the agent sees (first page when truncated) */
  value: unknown;
  /** the full shaped value (after include/exclude/flatten/redact), for result pages */
  full: unknown;
  truncated?: TruncationInfo;
}

export interface ShapeOptions {
  /** fallback byte cap when the overlay sets none */
  maxBytes?: number;
}

/** Locates the list to cut: the root array, or the only array property of a root object. */
function listOf(v: unknown): { get: () => unknown[]; set: (a: unknown[]) => void } | null {
  if (Array.isArray(v)) return null; // handled by caller (root)
  if (isObj(v)) {
    const arrays = Object.entries(v).filter(([, x]) => Array.isArray(x));
    if (arrays.length === 1) {
      const key = arrays[0]![0];
      return { get: () => v[key] as unknown[], set: (a) => (v[key] = a) };
    }
  }
  return null;
}

export function shapeResponse(input: unknown, shaping: ResponseShaping | undefined, opts: ShapeOptions = {}): ShapeResult {
  let v: unknown = clone(input);
  const s = shaping ?? {};
  if (s.include?.length) v = includePaths(v, s.include);
  for (const p of s.exclude ?? []) deleteAt(v, parsePath(p));
  for (const [p, target] of Object.entries(s.flatten ?? {})) flattenAt(v, p, target);
  for (const p of s.redact ?? []) replaceAt(v, parsePath(p), { ...REDACTED_VALUE });
  const full = v;
  const totalBytes = jsonBytes(full);
  let truncated: TruncationInfo | undefined;
  let out: unknown = full;

  const cutList = (n: number): unknown => {
    if (Array.isArray(full)) return full.slice(0, n);
    const l = listOf(full);
    if (!l) return full;
    const copy = { ...(full as Record<string, unknown>) };
    const inner = listOf(copy)!;
    inner.set(l.get().slice(0, n));
    return copy;
  };
  const listLen = Array.isArray(full) ? full.length : (listOf(full)?.get().length ?? null);

  if (s.maxItems !== undefined && listLen !== null && listLen > s.maxItems) {
    out = cutList(s.maxItems);
    truncated = { totalItems: listLen, returnedItems: s.maxItems, totalBytes, returnedBytes: jsonBytes(out) };
  }

  const maxBytes = s.maxBytes ?? opts.maxBytes;
  if (maxBytes !== undefined && jsonBytes(out) > maxBytes) {
    const curLen = Array.isArray(out) ? out.length : (listOf(out)?.get().length ?? null);
    if (listLen !== null && curLen !== null && curLen > 0) {
      // binary search the largest prefix that fits
      let lo = 0;
      let hi = curLen;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (jsonBytes(cutList(mid)) <= maxBytes) lo = mid;
        else hi = mid - 1;
      }
      out = cutList(lo);
      truncated = { totalItems: listLen, returnedItems: lo, totalBytes, returnedBytes: jsonBytes(out) };
    } else {
      const text = JSON.stringify(out) ?? '';
      out = { $truncated: true, preview: text.slice(0, Math.max(0, maxBytes - 64)) };
      truncated = { totalBytes, returnedBytes: jsonBytes(out) };
    }
  }
  return truncated ? { value: out, full, truncated } : { value: out, full };
}

/** MCP `structuredContent` must be an object: arrays → `{ items }`, scalars → `{ data }`. */
export function wrapStructured(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { items: value };
  if (isObj(value)) return value;
  return { data: value };
}

/* ------------------------------------------------------------------ output schema shaping */

type Schema = Record<string, unknown>;
type Seg = ReturnType<typeof parsePath>[number];

function childSchema(s: Schema | undefined, seg: Seg): Schema | undefined {
  if (!isObj(s)) return undefined;
  if (seg.kind === 'each') return isObj(s.items) ? (s.items as Schema) : undefined;
  return isObj(s.properties) ? ((s.properties as Record<string, Schema>)[seg.key] ?? undefined) : undefined;
}

function projectSchema(s: Schema, paths: Seg[][]): Schema {
  if (paths.some((p) => p.length === 0)) return s;
  const each = paths.filter((p) => p[0]!.kind === 'each').map((p) => p.slice(1));
  const keys = new Map<string, Seg[][]>();
  for (const p of paths) if (p[0]!.kind === 'key') keys.set((p[0] as { key: string }).key, [...(keys.get((p[0] as { key: string }).key) ?? []), p.slice(1)]);
  if (each.length && isObj(s.items)) return { ...s, items: projectSchema(s.items as Schema, each) };
  if (keys.size && isObj(s.properties)) {
    const props: Record<string, Schema> = {};
    for (const [k, sub] of keys) {
      const child = (s.properties as Record<string, Schema>)[k];
      if (child) props[k] = projectSchema(child, sub);
    }
    const req = Array.isArray(s.required) ? (s.required as string[]).filter((r) => r in props) : [];
    const out: Schema = { ...s, properties: props };
    if (req.length) out.required = req;
    else delete out.required;
    return out;
  }
  if (keys.size && isObj(s.items)) return { ...s, items: projectSchema(s.items as Schema, paths) };
  return s;
}

function removeSchemaPath(s: Schema, segs: Seg[]): void {
  let cur: Schema | undefined = s;
  for (let i = 0; i < segs.length - 1; i++) cur = childSchema(cur, segs[i]!);
  const last = segs[segs.length - 1];
  if (cur && last?.kind === 'key' && isObj(cur.properties)) {
    delete (cur.properties as Record<string, unknown>)[last.key];
    if (Array.isArray(cur.required)) cur.required = (cur.required as string[]).filter((r) => r !== last.key);
  }
}

/** Applies include/exclude/flatten to an output schema (the "success response schema after shaping"). */
export function shapeOutputSchema(schema: Record<string, unknown> | undefined, shaping: ResponseShaping | undefined): Record<string, unknown> | undefined {
  if (!schema || !shaping || (!shaping.include?.length && !shaping.exclude?.length && !shaping.flatten)) return schema;
  const wrapped = typeof schema['x-neurouter-wrapped'] === 'string' ? (schema['x-neurouter-wrapped'] as string) : null;
  let root: Schema = clone(wrapped && isObj(schema.properties) ? ((schema.properties as Record<string, Schema>)[wrapped] as Schema) : schema);
  try {
    if (shaping.include?.length) root = projectSchema(root, shaping.include.map(parsePath));
    for (const p of shaping.exclude ?? []) removeSchemaPath(root, parsePath(p));
    for (const [p, target] of Object.entries(shaping.flatten ?? {})) {
      const segs = parsePath(p);
      let lastEach = -1;
      segs.forEach((s, i) => (s.kind === 'each' ? (lastEach = i) : null));
      let container: Schema | undefined = root;
      for (const s of segs.slice(0, lastEach + 1)) container = childSchema(container, s);
      let leaf: Schema | undefined = container;
      for (const s of segs.slice(lastEach + 1)) leaf = childSchema(leaf, s);
      if (container && leaf && isObj(container.properties)) {
        const rel = segs.slice(lastEach + 1);
        removeSchemaPath(container, rel);
        // prune parents left without properties (mirrors flattenAt on values)
        for (let k = rel.length - 1; k >= 1; k--) {
          let parent: Schema | undefined = container;
          for (const s of rel.slice(0, k)) parent = childSchema(parent, s);
          if (parent && isObj(parent.properties) && Object.keys(parent.properties).length === 0) removeSchemaPath(container, rel.slice(0, k));
          else break;
        }
        (container.properties as Record<string, Schema>)[target] = leaf;
      }
    }
  } catch {
    return schema;
  }
  if (wrapped) return { ...schema, properties: { [wrapped]: root } };
  return root;
}
