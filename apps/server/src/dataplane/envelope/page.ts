import { opsMcpName, READ_RESULT, type ToolDef } from '@neurouter/shared';
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

/** The list inside a value: the root array or the only array property of a root object. */
export function listIn(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const arrays = Object.values(v as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }
  return null;
}

function schemaIsList(s: Schema | undefined): boolean | null {
  if (!s || typeof s !== 'object') return null;
  if (s.type === 'array') return true;
  const props = s.properties && typeof s.properties === 'object' ? Object.values(s.properties as Record<string, Schema>) : null;
  if (s.type === 'object' || props) return (props ?? []).filter((p) => p && p.type === 'array').length === 1;
  return null;
}

/**
 * A list tool (contract-v2 §2.1): the shaped success schema is an array or an object with exactly one array
 * property, or the binding has a detected pagination scheme. Without a schema, the value decides.
 */
export function isListTool(t: ToolDef, value: unknown): boolean {
  if (t.binding.type === 'http' && t.binding.pagination) return true;
  const bySchema = schemaIsList(t.outputSchema);
  if (bySchema !== null) return bySchema;
  return listIn(value) !== null;
}

const TOTAL_KEYS = ['total_count', 'totalCount', 'total', 'total_results', 'totalResults', 'count_total'];
const NEXT_KEYS = /^(next_?cursor|next_?page_?token|next_?token|next_?page|next|has_?more)$/i;

function upstreamTotal(v: unknown): number | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  for (const k of TOTAL_KEYS) {
    const x = (v as Record<string, unknown>)[k];
    if (typeof x === 'number' && Number.isFinite(x) && x >= 0) return x;
  }
  return null;
}

function upstreamNext(v: unknown, headers: Record<string, string>): boolean {
  if (/rel="?next"?/i.test(headers.link ?? '')) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (!NEXT_KEYS.test(k)) continue;
    if (k.toLowerCase().replace('_', '') === 'hasmore') return x === true;
    if ((typeof x === 'string' && x.trim()) || (typeof x === 'number' && x > 0)) return true;
  }
  return false;
}

export interface ListView {
  page: Page;
  truncated: Truncated | null;
  hint?: string;
}

/**
 * `page` for a list tool's success. `has_more` is always explicit: Neurouter cut the list, the upstream
 * total exceeds the items, or (without a total) the upstream signals a next page (cursor field, `Link: rel=next`). An empty
 * page is final. `next_cursor` stays null until P2's cursor codec; Neurouter's own cuts are fetched with
 * `truncated.next` (the stored result page) meanwhile.
 */
export function listView(t: ToolDef, args: Record<string, unknown>, value: unknown, cut: ShapeCut | undefined, handle: string | null, headers: Record<string, string>): ListView {
  const items = listIn(value) ?? [];
  const count = items.length;
  const neurouterCut = cut?.totalItems !== undefined && cut.returnedItems !== undefined && cut.totalItems > cut.returnedItems;
  const upTotal = upstreamTotal(value);
  const total = neurouterCut ? cut!.totalItems! : upTotal;
  // the upstream total decides when there is one; otherwise a next-page signal (cursor field, Link rel=next)
  const has_more = count > 0 && (neurouterCut || (upTotal !== null ? upTotal > count : upstreamNext(value, headers)));
  const page: Page = { count, total, has_more, next_cursor: null };
  if (count === 0 || neurouterCut) page.scope = effectiveArgs(t, args);
  let truncated: Truncated | null = null;
  if (neurouterCut && handle) {
    truncated = { items_omitted: cut!.totalItems! - cut!.returnedItems!, omitted_bytes: Math.max(0, cut!.totalBytes - cut!.returnedBytes), next: { tool: opsMcpName(READ_RESULT), args: { handle, offset: cut!.returnedItems! } } };
  }
  const hint = count === 0 ? widenHint(t, args) : undefined;
  return { page, truncated, ...(hint ? { hint } : {}) };
}

/** `truncated` for an object Neurouter clipped to its byte budget (fields named; the whole value behind `next`). */
export function clippedView(cut: ShapeCut, handle: string | null): Truncated | null {
  if (!cut.fields?.length || !handle) return null;
  return { fields: cut.fields.slice(0, 20), omitted_bytes: Math.max(0, cut.totalBytes - cut.returnedBytes), next: { tool: opsMcpName(READ_RESULT), args: { handle } } };
}

/** `0 matches. Widen: list_orders({"status":"refunded"})`: the same call without its most specific filter. */
export function widenHint(t: ToolDef, args: Record<string, unknown>): string | undefined {
  const req = new Set(requiredOf(t));
  const filters = Object.keys(args).filter((k) => !req.has(k) && !isPagingArg(k) && args[k] !== undefined);
  if (!filters.length) return '0 matches.';
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
