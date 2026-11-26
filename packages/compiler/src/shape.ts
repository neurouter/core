/**
 * Response shaping (backend spec §9.9): include/exclude → flatten → maxItems → redact → maxBytes.
 * Pure; the data plane stores `full` behind a result handle when `truncated` is set.
 */
import type { ResponseShaping } from '@neurouter/shared';
import { deleteAt, flattenAt, includePaths, parsePath, replaceAt } from './overlay/paths.js';
import { defRefName, defsOf, pruneDefs } from './openapi/schema.js';
import { clone, isObj, jsonBytes } from './util.js';

export const REDACTED_VALUE = { $redacted: 'overlay' } as const;

export interface TruncationInfo {
  totalItems?: number;
  returnedItems?: number;
  totalBytes: number;
  returnedBytes: number;
  /** Paths (`a.b`, `items[3].body`) whose string values were clipped or nested lists cut, for oversized objects. */
  fields?: string[];
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
  /**
   * false: no size limits at all, neither `maxItems` nor `maxBytes` (results of tool calls inside
   * `run_script`: the script reduces the data, and its own result-size limit applies to what it returns).
   * include/exclude/flatten/redact still apply.
   */
  limits?: boolean;
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

  if (opts.limits !== false && s.maxItems !== undefined && listLen !== null && listLen > s.maxItems) {
    out = cutList(s.maxItems);
    truncated = { totalItems: listLen, returnedItems: s.maxItems, totalBytes, returnedBytes: jsonBytes(out) };
  }

  const maxBytes = opts.limits === false ? undefined : (s.maxBytes ?? opts.maxBytes);
  if (maxBytes !== undefined && jsonBytes(out) > maxBytes) {
    const curLen = Array.isArray(out) ? out.length : (listOf(out)?.get().length ?? null);
    // an object with one list is a list wrapper (search results) only when the list is most of it
    const listHeavy = Array.isArray(out) || (curLen !== null && jsonBytes(listOf(out)!.get()) * 2 >= jsonBytes(out));
    if (listLen !== null && curLen !== null && curLen > 0 && listHeavy) {
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
      // an object (or a string) keeps its shape: the largest strings are clipped and nested lists cut,
      // and the paths are reported, so the value still matches its schema's structure
      const clipped = clipToFit(out, maxBytes);
      out = clipped.value;
      truncated = { totalBytes, returnedBytes: jsonBytes(out), fields: clipped.fields };
    }
  }
  return truncated ? { value: out, full, truncated } : { value: out, full };
}

const CLIP_KEEP = 200;
const CLIP_MIN = 40;

/**
 * Shrinks a value towards `maxBytes` without changing its structure: strings longer than 200
 * characters are clipped (largest first, to their first 200 characters plus `…`), then nested lists are
 * halved (largest first), then strings are clipped to 40 characters. Types, keys and required fields
 * stay; values may still exceed the cap when the structure alone is larger.
 */
export function clipToFit(input: unknown, maxBytes: number): { value: unknown; fields: string[] } {
  const value = clone(input);
  const fields = new Set<string>();
  type Ref = { holder: Record<string, unknown> | unknown[]; key: string | number; path: string; size: number };
  const collect = (want: 'string' | 'array', min: number): Ref[] => {
    const out: Ref[] = [];
    const walk = (v: unknown, holder: Ref['holder'] | null, key: string | number, path: string, depth: number) => {
      if (depth > 32) return;
      if (typeof v === 'string' && want === 'string' && holder && v.length > min) out.push({ holder, key, path, size: v.length });
      if (Array.isArray(v)) {
        if (want === 'array' && holder && v.length > 1) out.push({ holder, key, path, size: jsonBytes(v) });
        v.forEach((x, i) => walk(x, v, i, `${path}[${i}]`, depth + 1));
      } else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, v, k, path ? `${path}.${k}` : k, depth + 1);
    };
    walk(value, null, '', '', 0);
    return out.sort((a, b) => b.size - a.size);
  };
  const set = (r: Ref, v: unknown) => ((r.holder as Record<string | number, unknown>)[r.key] = v);
  const get = (r: Ref) => (r.holder as Record<string | number, unknown>)[r.key];
  const fits = () => jsonBytes(value) <= maxBytes;
  if (typeof value === 'string') {
    const v = value.length > maxBytes ? `${value.slice(0, Math.max(CLIP_MIN, maxBytes - 8))}…` : value;
    return { value: v, fields: v === value ? [] : ['$'] };
  }
  for (const r of collect('string', CLIP_KEEP)) {
    if (fits()) break;
    set(r, `${String(get(r)).slice(0, CLIP_KEEP)}…`);
    fields.add(r.path);
  }
  for (let round = 0; round < 8 && !fits(); round++) {
    const arrays = collect('array', 0);
    if (!arrays.length) break;
    for (const r of arrays) {
      if (fits()) break;
      const a = get(r) as unknown[];
      set(r, a.slice(0, Math.ceil(a.length / 2)));
      fields.add(r.path);
    }
  }
  for (const r of collect('string', CLIP_MIN)) {
    if (fits()) break;
    set(r, `${String(get(r)).slice(0, CLIP_MIN)}…`);
    fields.add(r.path);
  }
  return { value, fields: [...fields].sort() };
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

/**
 * Output schemas may reference shared components (`#/$defs/…`). Shaping edits the schema along the
 * shaped paths, so a reference on such a path is replaced in place by a copy of its definition
 * (the root is a private clone), and the other uses of the component stay intact.
 */
function inlineRef(s: Schema, defs: Schema): Schema {
  for (let i = 0; i < 16; i++) {
    const n = defRefName(s.$ref);
    if (n === null || !isObj(defs[n])) return s;
    const { $ref: _r, ...rest } = s;
    const copy = clone(defs[n] as Schema);
    for (const k of Object.keys(s)) delete s[k];
    Object.assign(s, copy, rest);
    if (!s['x-schema-name'] && !s.title) s['x-schema-name'] = n;
  }
  return s;
}

function childSchema(s: Schema | undefined, seg: Seg, defs: Schema): Schema | undefined {
  if (!isObj(s)) return undefined;
  inlineRef(s, defs);
  let child: unknown;
  if (seg.kind === 'each') child = s.items;
  else child = isObj(s.properties) ? (s.properties as Record<string, Schema>)[seg.key] : undefined;
  if (!isObj(child)) return undefined;
  return inlineRef(child as Schema, defs);
}

function projectSchema(s: Schema, paths: Seg[][], defs: Schema): Schema {
  inlineRef(s, defs);
  if (paths.some((p) => p.length === 0)) return s;
  const each = paths.filter((p) => p[0]!.kind === 'each').map((p) => p.slice(1));
  const keys = new Map<string, Seg[][]>();
  for (const p of paths) if (p[0]!.kind === 'key') keys.set((p[0] as { key: string }).key, [...(keys.get((p[0] as { key: string }).key) ?? []), p.slice(1)]);
  if (each.length && isObj(s.items)) return { ...s, items: projectSchema(s.items as Schema, each, defs) };
  if (keys.size && isObj(s.properties)) {
    const props: Record<string, Schema> = {};
    for (const [k, sub] of keys) {
      const child = (s.properties as Record<string, Schema>)[k];
      if (child) props[k] = projectSchema(child, sub, defs);
    }
    const req = Array.isArray(s.required) ? (s.required as string[]).filter((r) => r in props) : [];
    const out: Schema = { ...s, properties: props };
    if (req.length) out.required = req;
    else delete out.required;
    return out;
  }
  if (keys.size && isObj(s.items)) return { ...s, items: projectSchema(s.items as Schema, paths, defs) };
  return s;
}

function removeSchemaPath(s: Schema, segs: Seg[], defs: Schema): void {
  let cur: Schema | undefined = s;
  for (let i = 0; i < segs.length - 1; i++) cur = childSchema(cur, segs[i]!, defs);
  const last = segs[segs.length - 1];
  if (cur) inlineRef(cur, defs);
  if (cur && last?.kind === 'key' && isObj(cur.properties)) {
    delete (cur.properties as Record<string, unknown>)[last.key];
    if (Array.isArray(cur.required)) cur.required = (cur.required as string[]).filter((r) => r !== last.key);
  }
}

/** Applies include/exclude/flatten to an output schema (the "success response schema after shaping"). */
export function shapeOutputSchema(schema: Record<string, unknown> | undefined, shaping: ResponseShaping | undefined): Record<string, unknown> | undefined {
  if (!schema || !shaping || (!shaping.include?.length && !shaping.exclude?.length && !shaping.flatten)) return schema;
  const wrapped = typeof schema['x-neurouter-wrapped'] === 'string' ? (schema['x-neurouter-wrapped'] as string) : null;
  const defs = defsOf(schema) as Schema;
  let root: Schema = clone(wrapped && isObj(schema.properties) ? ((schema.properties as Record<string, Schema>)[wrapped] as Schema) : schema);
  try {
    if (shaping.include?.length) root = projectSchema(root, shaping.include.map(parsePath), defs);
    for (const p of shaping.exclude ?? []) removeSchemaPath(root, parsePath(p), defs);
    for (const [p, target] of Object.entries(shaping.flatten ?? {})) {
      const segs = parsePath(p);
      let lastEach = -1;
      segs.forEach((s, i) => (s.kind === 'each' ? (lastEach = i) : null));
      let container: Schema | undefined = root;
      for (const s of segs.slice(0, lastEach + 1)) container = childSchema(container, s, defs);
      let leaf: Schema | undefined = container;
      for (const s of segs.slice(lastEach + 1)) leaf = childSchema(leaf, s, defs);
      if (container && leaf && isObj(container.properties)) {
        const rel = segs.slice(lastEach + 1);
        removeSchemaPath(container, rel, defs);
        // prune parents left without properties (mirrors flattenAt on values)
        for (let k = rel.length - 1; k >= 1; k--) {
          let parent: Schema | undefined = container;
          for (const s of rel.slice(0, k)) parent = childSchema(parent, s, defs);
          if (parent && isObj(parent.properties) && Object.keys(parent.properties).length === 0) removeSchemaPath(container, rel.slice(0, k), defs);
          else break;
        }
        (container.properties as Record<string, Schema>)[target] = leaf;
      }
    }
  } catch {
    return schema;
  }
  if (wrapped) return pruneDefs({ ...schema, properties: { [wrapped]: root } });
  return pruneDefs(root);
}
