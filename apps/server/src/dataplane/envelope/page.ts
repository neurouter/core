import { opsMcpName, READ_RESULT, type ToolDef } from '@neurouter/shared';
import type { CursorPayload } from '../paging/cursor.js';
import { clippedFields } from '../paging/fields.js';
import type { NextSignals } from '../paging/plan.js';
import { effectiveArgs, isPagingArg, requiredOf } from './relations.js';
import { BUDGET, type Page, type Truncated } from './types.js';

/** What the compiler's `shapeResponse` reported about a Neurouter cut. */
export interface ShapeCut {
  totalItems?: number;
  returnedItems?: number;
  totalBytes: number;
  returnedBytes: number;
  fields?: string[];
}

type Schema = Record<string, unknown>;

/** Keys a list wrapper may carry next to its array (totals, cursors, links): `{total_count, items}`, `{data, has_more}`. */
const WRAPPER_KEY = /^(total|count|next|prev|previous|cursor|page|more|has_?more|offset|limit|links?|meta|incomplete_results|object|url|start|end|size)|(total|count|cursor|token|page|url|more)$/i;

/**
 * An item count next to the array (`total_count`, `count`): with it, an object with exactly one array property is a list
 * even when it carries other keys (GitHub `{total_count, repository_selection, repositories}`, B4). Not `total`: an
 * order's `total` is money, and an order with line `items` is an entity.
 */
const COUNT_KEY = /(^|_)count$/i;

/** A wrapper's keys: one array, the others totals/cursors/links, or any keys next to an item count. */
function wrapperKeys(keys: string[], isArray: (k: string) => boolean): boolean {
  const arrays = keys.filter(isArray);
  if (arrays.length !== 1) return false;
  return keys.every((k) => isArray(k) || WRAPPER_KEY.test(k)) || keys.some((k) => !isArray(k) && COUNT_KEY.test(k));
}

/** The list inside a value: the root array, or the only array property of a list wrapper. */
export function listIn(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o);
    if (wrapperKeys(keys, (k) => Array.isArray(o[k]))) return keys.map((k) => o[k]).find(Array.isArray) as unknown[];
  }
  return null;
}

function schemaIsList(s: Schema | undefined): boolean | null {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'array') return true;
  const props = s.properties && typeof s.properties === 'object' ? Object.entries(s.properties as Record<string, Schema>) : null;
  if (!props) return s.type === 'object' ? false : null;
  const byKey = new Map(props);
  return wrapperKeys([...byKey.keys()], (k) => byKey.get(k)?.type === 'array');
}

/**
 * A list tool (contract-v2 §2.1): the shaped success schema is an array or a list wrapper (exactly one array
 * property, the others totals/cursors/links), or the binding has a detected pagination scheme. Without a
 * schema, the value decides. (An entity with one array field, e.g. an order with line `items`, is not a list.)
 */
export function isListTool(t: ToolDef, value: unknown): boolean {
  if (t.binding.type === 'http' && t.binding.pagination) return true;
  const bySchema = schemaIsList(t.outputSchema);
  if (bySchema !== null) return bySchema;
  return listIn(value) !== null;
}

export interface ListView {
  page: Page;
  truncated: Truncated | null;
  hint?: string;
}

/** What the pipeline knows about paging for one list response (contract-v2 §2.1). */
export interface ListPaging {
  /** encodes a next position as `page.next_cursor` (null when cursors are unavailable) */
  encode: (p: CursorPayload) => string | null;
  /** the upstream's next-page signals (null when the items came from a stored result) */
  signals: NextSignals | null;
  /** the stored full value behind a Neurouter cut */
  handle: string | null;
  /** serving a stored result: items already served before this response, its total and the upstream page after it */
  stored?: { offset: number; length: number; total: number | null; then: Exclude<CursorPayload, { k: 'r' }> | null };
  /** the arguments Neurouter adds (left out of `scope` and widening hints) */
  own: string[];
}

/**
 * `page` for a list tool's success. `has_more` is always explicit: Neurouter cut the list, or the upstream signals a
 * next page (Link, cursor token, has_more, total, a full page). `next_cursor` is the signed cursor for the same tool
 * with the same other arguments: the rest of a Neurouter cut (stored result, 1 h), then the upstream's next page.
 * `total` is the upstream total, or the item count when this is the whole list. An empty page is final.
 */
export function listView(t: ToolDef, args: Record<string, unknown>, value: unknown, cut: ShapeCut | undefined, paging: ListPaging): ListView {
  const items = listIn(value) ?? [];
  const count = items.length;
  const neurouterCut = cut?.totalItems !== undefined && cut.returnedItems !== undefined && cut.totalItems > cut.returnedItems;
  const returned = neurouterCut ? cut!.returnedItems! : count;
  const sig = paging.signals;
  let has_more: boolean;
  let next: CursorPayload | null = null;
  let total: number | null;
  if (paging.stored) {
    const st = paging.stored;
    const served = st.offset + returned;
    has_more = count > 0 && (served < st.length || st.then !== null);
    next = served < st.length ? { k: 'r', h: paging.handle ?? '', n: served, t: st.total, then: st.then } : st.then;
    total = st.total;
  } else {
    const upMore = sig?.more ?? false;
    has_more = count > 0 && (neurouterCut || upMore);
    const upNext = upMore ? (sig?.next ?? null) : null;
    total = sig?.total ?? (!upMore && (sig?.first ?? true) ? (neurouterCut ? cut!.totalItems! : count) : null);
    if (neurouterCut && paging.handle) next = { k: 'r', h: paging.handle, n: returned, t: total, then: upNext };
    else if (upMore) next = upNext;
  }
  const next_cursor = has_more && next ? paging.encode(next) : null;
  const page: Page = { count, total, has_more, next_cursor };
  const own = new Set(paging.own);
  const visibleArgs = Object.fromEntries(Object.entries(args).filter(([k]) => !own.has(k)));
  if (count === 0 || neurouterCut) page.scope = effectiveArgs(t, visibleArgs);
  const hint = count === 0 ? widenHint(t, visibleArgs, args) : undefined;
  return { page, truncated: null, ...(hint ? { hint } : {}) };
}

/**
 * `truncated` for an object Neurouter clipped to its byte budget: the clipped paths, and the same call with `fields`
 * naming them (a projection that small is not clipped). Only when that would repeat this very call (one value over
 * the 64 KB tool-mode cap) does `next` fall back to the stored value (`neurouter_read_result`, unlisted).
 */
export function clippedView(cut: ShapeCut, t: ToolDef, args: Record<string, unknown>, fieldsArg: string, handle: string | null): Truncated | null {
  if (!cut.fields?.length) return null;
  const fields = clippedFields(cut.fields).slice(0, 20);
  const omitted_bytes = Math.max(0, cut.totalBytes - cut.returnedBytes);
  const current = Array.isArray(args[fieldsArg]) ? (args[fieldsArg] as string[]) : null;
  const same = current !== null && fields.every((f) => current.includes(f));
  if (same) return handle ? { fields: cut.fields.slice(0, 20), omitted_bytes, next: { tool: opsMcpName(READ_RESULT), args: { handle } } } : null;
  return { fields: cut.fields.slice(0, 20), omitted_bytes, next: { tool: t.name, args: { ...args, [fieldsArg]: fields } } };
}

/** `0 matches. Widen: list_orders({"status":"refunded"})`: the same call without its most specific filter. */
export function widenHint(t: ToolDef, args: Record<string, unknown>, all: Record<string, unknown> = args): string | undefined {
  const req = new Set(requiredOf(t));
  const filters = Object.keys(args).filter((k) => !req.has(k) && !isPagingArg(k) && args[k] !== undefined);
  if (!filters.length) {
    const position = Object.keys(all).filter((k) => (isPagingArg(k) || k === 'nr_cursor') && !/limit|per_page|page_size/i.test(k));
    if (!position.length) return '0 items.';
    const first = Object.fromEntries(Object.entries(all).filter(([k]) => !position.includes(k)));
    const hint = `No items at this ${position.join('/')}. First page: ${t.name}(${JSON.stringify(first)})`;
    return hint.length <= BUDGET.hintChars ? hint : `No items at this ${position.join('/')}; drop it for the first page.`;
  }
  const wider = { ...args };
  delete wider[filters[filters.length - 1]!];
  const call = `${t.name}(${JSON.stringify(wider)})`;
  const hint = `0 matches for these filters (page.scope). Widen: ${call}`;
  return hint.length <= BUDGET.hintChars ? hint : '0 matches for these filters (page.scope). Remove a filter to widen.';
}

/** Up to `max` dotted paths of strings that look like instructions (prompt-injection scan). */
export function untrustedPaths(value: unknown, test: (s: string) => boolean, max = 3): string[] {
  const out: string[] = [];
  const budget = { n: 5000 };
  const walk = (v: unknown, path: string): void => {
    if (out.length >= max || budget.n-- <= 0) return;
    if (typeof v === 'string') {
      if (test(v)) out.push(path || '(data)');
      return;
    }
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v as Record<string, unknown>)) walk(x, path ? `${path}.${k}` : k);
  };
  walk(value, '');
  return out;
}
