/**
 * JSONPath subset for overlay `response.*` and `redact` (backend spec §8.4): `a.b`, `a[]` (every
 * item), `[].x` (root array), `a[].b[].c`. No filters, no wildcards.
 */
import { isObj } from '../util.js';

export type PathSeg = { kind: 'key'; key: string } | { kind: 'each' };

export class PathSyntaxError extends Error {}

export function parsePath(path: string): PathSeg[] {
  const p = path.trim();
  if (!p) throw new PathSyntaxError('empty path');
  const segs: PathSeg[] = [];
  let i = 0;
  let expectKey = true;
  while (i < p.length) {
    if (p.startsWith('[]', i)) {
      segs.push({ kind: 'each' });
      i += 2;
      expectKey = false;
      continue;
    }
    if (p[i] === '.') {
      if (segs.length === 0 || expectKey) throw new PathSyntaxError(`unexpected "." at ${i} in "${path}"`);
      i++;
      expectKey = true;
      continue;
    }
    if (!expectKey && segs.length > 0) throw new PathSyntaxError(`expected "." or "[]" at ${i} in "${path}"`);
    const m = /^[^.[\]]+/.exec(p.slice(i));
    if (!m) throw new PathSyntaxError(`unexpected "${p[i]}" at ${i} in "${path}"`);
    segs.push({ kind: 'key', key: m[0] });
    i += m[0].length;
    expectKey = false;
  }
  if (expectKey && segs.length > 0) throw new PathSyntaxError(`path "${path}" ends with "."`);
  return segs;
}

export function formatPath(segs: PathSeg[]): string {
  let out = '';
  for (const s of segs) {
    if (s.kind === 'each') out += '[]';
    else out += (out && !out.endsWith('.') ? '.' : '') + s.key;
  }
  return out;
}

/** All values addressed by the path. */
export function getAll(value: unknown, segs: PathSeg[]): unknown[] {
  let cur: unknown[] = [value];
  for (const s of segs) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (s.kind === 'each') {
        if (Array.isArray(v)) next.push(...v);
      } else if (isObj(v) && s.key in v) next.push(v[s.key]);
    }
    cur = next;
  }
  return cur;
}

/** Visits each parent container + key addressed by the path (for in-place edits). */
function visitParents(value: unknown, segs: PathSeg[], fn: (parent: Record<string, unknown> | unknown[], key: string | number) => void): void {
  if (segs.length === 0) return;
  const walk = (v: unknown, i: number) => {
    const s = segs[i]!;
    const last = i === segs.length - 1;
    if (s.kind === 'each') {
      if (!Array.isArray(v)) return;
      for (let k = 0; k < v.length; k++) {
        if (last) fn(v, k);
        else walk(v[k], i + 1);
      }
    } else if (isObj(v) && s.key in v) {
      if (last) fn(v, s.key);
      else walk(v[s.key], i + 1);
    }
  };
  walk(value, 0);
}

/** Deletes the addressed values (in place). */
export function deleteAt(value: unknown, segs: PathSeg[]): void {
  const removals: Array<[unknown[], number]> = [];
  visitParents(value, segs, (parent, key) => {
    if (Array.isArray(parent)) removals.push([parent, key as number]);
    else delete parent[key as string];
  });
  for (const [arr, idx] of removals.sort((a, b) => b[1] - a[1])) arr.splice(idx, 1);
}

/** Replaces the addressed values (in place). */
export function replaceAt(value: unknown, segs: PathSeg[], replacement: unknown): void {
  visitParents(value, segs, (parent, key) => {
    if (Array.isArray(parent)) parent[key as number] = replacement;
    else parent[key as string] = replacement;
  });
}

interface IncludeNode {
  leaf: boolean;
  each?: IncludeNode;
  keys: Map<string, IncludeNode>;
}

function node(): IncludeNode {
  return { leaf: false, keys: new Map() };
}

export function buildIncludeTree(paths: PathSeg[][]): IncludeNode {
  const root = node();
  for (const segs of paths) {
    let cur = root;
    for (const s of segs) {
      if (s.kind === 'each') cur = cur.each ??= node();
      else {
        let n = cur.keys.get(s.key);
        if (!n) cur.keys.set(s.key, (n = node()));
        cur = n;
      }
    }
    cur.leaf = true;
  }
  return root;
}

/** Keeps only the included paths. Values whose shape does not match the path are kept unchanged. */
export function project(value: unknown, tree: IncludeNode): unknown {
  if (tree.leaf) return value;
  if (tree.each && Array.isArray(value)) return value.map((v) => project(v, tree.each!));
  if (tree.keys.size > 0 && isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, child] of tree.keys) if (k in value) out[k] = project(value[k], child);
    return out;
  }
  if (tree.keys.size > 0 && Array.isArray(value) && !tree.each) return value.map((v) => project(v, tree));
  return value;
}

export function includePaths(value: unknown, paths: string[]): unknown {
  return project(value, buildIncludeTree(paths.map(parsePath)));
}

/**
 * Flatten `{ "[].user.login": "author" }`: inside the container addressed by the part before the
 * last `[]` (or the root), set `author` to the value at the remaining path and drop the original.
 */
export function flattenAt(value: unknown, path: string, target: string): void {
  const segs = parsePath(path);
  let lastEach = -1;
  segs.forEach((s, i) => {
    if (s.kind === 'each') lastEach = i;
  });
  const containerPath = segs.slice(0, lastEach + 1);
  const rel = segs.slice(lastEach + 1);
  if (rel.length === 0) return;
  const containers = containerPath.length ? getAll(value, containerPath) : [value];
  for (const c of containers) {
    if (!isObj(c)) continue;
    const got = getAll(c, rel);
    if (got.length === 0) continue;
    // remove the original leaf and prune parents that became empty
    deleteAt(c, rel);
    for (let k = rel.length - 1; k >= 1; k--) {
      const parentVals = getAll(c, rel.slice(0, k));
      const p = parentVals[0];
      if (isObj(p) && Object.keys(p).length === 0) deleteAt(c, rel.slice(0, k));
      else break;
    }
    c[target] = got[0];
  }
}

export function validatePaths(paths: string[]): string[] {
  const errors: string[] = [];
  for (const p of paths) {
    try {
      parsePath(p);
    } catch (e) {
      errors.push((e as Error).message);
    }
  }
  return errors;
}
