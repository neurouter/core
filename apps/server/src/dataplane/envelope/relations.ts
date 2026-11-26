import type { ToolDef } from '@neurouter/shared';
import type { Call } from './types.js';

type Schema = Record<string, unknown>;

export function propsOf(t: Pick<ToolDef, 'inputSchema'>): Record<string, Schema> {
  const p = t.inputSchema.properties;
  return p && typeof p === 'object' ? (p as Record<string, Schema>) : {};
}

export function requiredOf(t: Pick<ToolDef, 'inputSchema'>): string[] {
  return Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : [];
}

const PAGING = new Set(['limit', 'per_page', 'page', 'cursor', 'offset', 'page_size', 'page_token', 'starting_after', 'ending_before', 'after', 'before']);
export const isPagingArg = (name: string): boolean => PAGING.has(name.toLowerCase());

/** Effective arguments: the call's arguments plus the input schema's defaults for the ones left out. */
export function effectiveArgs(t: Pick<ToolDef, 'inputSchema'>, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, p] of Object.entries(propsOf(t))) {
    if (args[k] !== undefined) out[k] = args[k];
    else if (p && p.default !== undefined) out[k] = p.default;
  }
  for (const [k, v] of Object.entries(args)) if (!(k in out)) out[k] = v;
  return out;
}

/** `cancel_order` → `order`, `issues_get` → `issue`, `get_pet_by_id` → `pet`: the entity a tool is about. */
export function nounOf(t: Pick<ToolDef, 'name' | 'binding'>): string {
  if (t.binding.type === 'http') {
    const parts = t.binding.pathTemplate.split('/').filter(Boolean);
    const i = lastParamIndex(parts);
    // `/orders/{id}/cancel` → `orders` (the segment before the last id), `/orders` → `orders`
    const noun = i > 0 ? parts[i - 1]! : ([...parts].reverse().find((s) => !s.startsWith('{')) ?? t.name);
    return singular(noun.replace(/[-_]/g, ' '));
  }
  const words = t.name.split('_').filter((w) => !['get', 'list', 'create', 'update', 'delete', 'cancel', 'by', 'id'].includes(w));
  return singular(words[words.length - 1] ?? t.name);
}

function singular(w: string): string {
  if (/ies$/.test(w)) return `${w.slice(0, -3)}y`;
  if (/(ss|us)$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

function lastParamIndex(parts: string[]): number {
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i]!.startsWith('{')) return i;
  return -1;
}

/** Agent-facing argument name of a path parameter (`orderId` → `order_id` after renaming). */
function argForPathParam(t: ToolDef, param: string): string | null {
  if (t.binding.type !== 'http') return null;
  const hit = t.binding.params.find((p) => p.in === 'path' && p.name === param);
  return hit ? hit.arg : null;
}

/** The value of the last path id of a call (`get_order(order_id='x')` → `{ arg: 'order_id', value: 'x' }`). */
export function pathId(t: ToolDef, args: Record<string, unknown>): { arg: string; value: unknown } | null {
  if (t.binding.type !== 'http') return null;
  const parts = t.binding.pathTemplate.split('/').filter(Boolean);
  const i = lastParamIndex(parts);
  if (i < 0) return null;
  const arg = argForPathParam(t, parts[i]!.slice(1, -1));
  return arg && args[arg] !== undefined ? { arg, value: args[arg] } : null;
}

/** Fills a target tool's required arguments from the current call (same names), plus `limit`'s default. */
function carryArgs(target: ToolDef, args: Record<string, unknown>, withLimit: boolean): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const r of requiredOf(target)) {
    if (args[r] === undefined) return null;
    out[r] = args[r];
  }
  const limit = propsOf(target).limit;
  if (withLimit && limit && limit.default !== undefined) out.limit = limit.default;
  return out;
}

const httpTools = (tools: ToolDef[]) => tools.filter((t): t is ToolDef & { binding: { type: 'http'; method: string; pathTemplate: string } } => t.binding.type === 'http');

/** The list call for the collection a path id belongs to (`get_order` 404 → `list_orders({"limit":20})`). */
export function parentListCall(t: ToolDef, args: Record<string, unknown>, tools: ToolDef[]): Call | null {
  if (t.binding.type !== 'http') return null;
  const parts = t.binding.pathTemplate.split('/').filter(Boolean);
  const i = lastParamIndex(parts);
  if (i < 0) return null;
  const prefix = `/${parts.slice(0, i).join('/')}`;
  for (const c of httpTools(tools)) {
    if (c.name === t.name || c.binding.method.toUpperCase() !== 'GET' || c.binding.pathTemplate !== prefix || c.risk.write) continue;
    const a = carryArgs(c, args, true);
    if (a) return { tool: c.name, args: a };
  }
  return null;
}

/** A read of the entity a write targets (`cancel_order` → `get_order(order_id)`): the actual state after a refusal or conflict. */
export function readCall(t: ToolDef, args: Record<string, unknown>, tools: ToolDef[]): Call | null {
  if (t.binding.type !== 'http') return null;
  const parts = t.binding.pathTemplate.split('/').filter(Boolean);
  const candidates: string[] = [];
  for (let n = parts.length; n >= 1; n--) candidates.push(`/${parts.slice(0, n).join('/')}`);
  for (const path of candidates) {
    for (const c of httpTools(tools)) {
      if (c.name === t.name || c.binding.method.toUpperCase() !== 'GET' || c.binding.pathTemplate !== path || c.risk.write) continue;
      const a = carryArgs(c, args, !path.endsWith('}'));
      if (a) return { tool: c.name, args: a };
    }
  }
  return null;
}

/** A copy-ready example call: the first overlay/spec example, else required arguments from defaults/enums. */
export function exampleArgs(t: ToolDef): Record<string, unknown> | null {
  const ex = t.examples[0]?.arguments;
  if (ex && typeof ex === 'object') return ex;
  const out: Record<string, unknown> = {};
  const props = propsOf(t);
  for (const r of requiredOf(t)) {
    const v = sampleValue(props[r]);
    if (v === undefined) return null;
    out[r] = v;
  }
  return out;
}

/** A schema's default, first enum value or first example (no invented values). */
export function sampleValue(p: Schema | undefined): unknown {
  if (!p) return undefined;
  if (p.default !== undefined) return p.default;
  if (Array.isArray(p.enum) && p.enum.length) return p.enum[0];
  if (Array.isArray(p.examples) && p.examples.length) return p.examples[0];
  if (p.example !== undefined) return p.example;
  return undefined;
}

/** Similarity of two identifiers (case/underscore-insensitive), 0..1. */
export function similarity(a: string, b: string): number {
  const x = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const y = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!x || !y) return 0;
  if (x === y) return 1;
  const d = levenshtein(x, y);
  return 1 - d / Math.max(x.length, y.length);
}

function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n]!;
}

/** The `n` names most similar to `name` (≥ 0.4 similarity), best first. */
export function closestNames(name: string, names: readonly string[], n = 3, min = 0.4): string[] {
  return names
    .map((x) => ({ x, s: similarity(name, x) }))
    .filter((r) => r.s >= min && r.x !== name)
    .sort((a, b) => b.s - a.s || a.x.localeCompare(b.x))
    .slice(0, n)
    .map((r) => r.x);
}
