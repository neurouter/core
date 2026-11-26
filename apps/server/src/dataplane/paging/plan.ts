import type { HttpParam, ToolDef } from '@neurouter/shared';
import { parsePath } from '@neurouter/compiler';
import type { ArgIssue } from '../envelope/draft.js';
import { isListTool } from '../envelope/page.js';
import type { CursorPayload } from './cursor.js';

type Schema = Record<string, unknown>;

/** One upstream paging parameter: the agent-visible argument, the spec argument and the query parameter name. */
export interface PagingParam {
  arg: string;
  spec: string;
  name: string;
}

/**
 * How a tool pages (contract-v2 §2.1, D6): the upstream paging parameters by role, and the names of the
 * arguments contract 2 adds (`cursor`, `limit`, `fields`; `nr_` prefixed when the upstream already uses the
 * name for something else).
 */
export interface PagingPlan {
  /** a list tool (page on every success) */
  list: boolean;
  size?: PagingParam;
  /** upstream cursor / page token parameter (also `starting_after`) */
  cursor?: PagingParam;
  /** `starting_after`: the cursor is the last item's id */
  startingAfter?: boolean;
  page?: PagingParam;
  offset?: PagingParam;
  /** the binding's response path of the next token (compiler `pagination.nextPath`) */
  nextPath?: string;
  /** the spec declares `Link` response headers: no `rel=next` means the last page */
  link?: boolean;
  /** contract-2 argument names */
  names: { cursor: string | null; limit: string | null; fields: string };
  /** upstream arguments replaced by `cursor`/`limit` in the contract-2 input schema (still accepted) */
  replaced: string[];
}

const SIZE = new Set(['limit', 'per_page', 'perpage', 'page_size', 'pagesize', 'max_results', 'maxresults']);
const CURSOR = new Set(['cursor', 'page_token', 'pagetoken', 'next_token', 'nexttoken', 'after', 'continuation_token', 'continuationtoken', 'next_cursor']);
const PAGE = new Set(['page', 'page_number', 'pagenumber']);
const OFFSET = new Set(['offset', 'skip']);

const cache = new WeakMap<ToolDef, PagingPlan>();

function propsOf(t: ToolDef): Record<string, Schema> {
  const p = t.inputSchema.properties;
  return p && typeof p === 'object' ? (p as Record<string, Schema>) : {};
}

/** The paging plan of a tool (cached per tool definition). */
export function pagingPlan(t: ToolDef): PagingPlan {
  const hit = cache.get(t);
  if (hit) return hit;
  const props = propsOf(t);
  const visible = (p: HttpParam): string | null => {
    const inv = Object.entries(t.args?.renamed ?? {}).find(([, orig]) => orig === p.arg)?.[0];
    const arg = inv ?? p.arg;
    return arg in props ? arg : null;
  };
  const plan: PagingPlan = { list: false, names: { cursor: null, limit: null, fields: 'fields' }, replaced: [] };
  if (t.binding.type === 'http') {
    for (const p of t.binding.params) {
      if (p.in !== 'query') continue;
      const arg = visible(p);
      if (!arg) continue;
      const n = p.name.toLowerCase();
      const param = { arg, spec: p.arg, name: p.name };
      if (SIZE.has(n) && !plan.size) plan.size = param;
      else if (n === 'starting_after' && !plan.cursor) {
        plan.cursor = param;
        plan.startingAfter = true;
      } else if (CURSOR.has(n) && !plan.cursor) plan.cursor = param;
      else if (PAGE.has(n) && !plan.page) plan.page = param;
      else if (OFFSET.has(n) && !plan.offset) plan.offset = param;
    }
    if (t.binding.pagination?.nextPath) plan.nextPath = t.binding.pagination.nextPath;
    if (t.binding.pagination?.style === 'link') plan.link = true;
  }
  plan.list = t.kind !== 'composite' && isListTool(t, undefined);
  if (!plan.list) {
    // only list tools page; a non-list tool keeps its upstream parameters as they are
    delete plan.size;
    delete plan.cursor;
    delete plan.page;
    delete plan.offset;
    delete plan.startingAfter;
  }
  const free = (name: string, ours: string | undefined) => (name in props && ours !== name ? `nr_${name}` : name);
  if (plan.list) {
    plan.names.cursor = free('cursor', plan.cursor?.arg);
    if (plan.size) plan.names.limit = free('limit', plan.size.arg);
    for (const p of [plan.cursor, plan.page, plan.offset]) if (p && p.arg !== plan.names.cursor) plan.replaced.push(p.arg);
    if (plan.size && plan.names.limit !== plan.size.arg) plan.replaced.push(plan.size.arg);
  }
  plan.names.fields = free('fields', undefined);
  cache.set(t, plan);
  return plan;
}

/**
 * The contract-2 input schema (D6): `cursor` on list tools (replacing the upstream page/offset/cursor parameters),
 * `limit` where the upstream pages (the upstream page size under one name), `fields` on every tool. Arguments the
 * upstream already uses for something else get the `nr_` prefix.
 */
export function v2InputSchema(t: ToolDef, defaultFields?: string[]): Schema {
  const plan = pagingPlan(t);
  const props = { ...propsOf(t) };
  for (const r of plan.replaced) delete props[r];
  if (plan.names.cursor) props[plan.names.cursor] = { type: 'string', description: 'page.next_cursor of the previous call; repeat the other arguments unchanged.' };
  // the upstream's own `limit` stays as it is; another page-size name is offered as `limit`
  if (plan.names.limit && plan.size && plan.names.limit !== plan.size.arg) {
    const s = propsOf(t)[plan.size.arg] ?? {};
    props[plan.names.limit] = { ...pick(s, ['type', 'minimum', 'maximum', 'default']), type: s.type ?? 'integer', description: 'Items per page.' };
  }
  const def = defaultFields?.length ? ` Default: ${defaultFields.slice(0, 8).join(', ')}${defaultFields.length > 8 ? ', …' : ''}.` : '';
  props[plan.names.fields] = { type: 'array', items: { type: 'string' }, maxItems: 50, description: `Return only these fields (dot paths${plan.list ? ', per item' : ''}, e.g. ["id","customer.name"]).${def}` };
  const required = Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]).filter((r) => !plan.replaced.includes(r)) : undefined;
  const out: Schema = { ...t.inputSchema, properties: props };
  if (required) out.required = required;
  return out;
}

function pick(o: Schema, keys: string[]): Schema {
  return Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
}

export interface SplitArgs {
  /** the arguments for the upstream (agent-visible upstream names; `limit` mapped to the upstream page size) */
  upstream: Record<string, unknown>;
  cursor?: string;
  fields?: string[];
  issues: ArgIssue[];
}

/** Takes the contract-2 arguments out of a call (and checks them; the upstream arguments are validated as before). */
export function splitArgs(plan: PagingPlan, args: Record<string, unknown>): SplitArgs {
  const upstream = { ...args };
  const issues: ArgIssue[] = [];
  const out: SplitArgs = { upstream, issues };
  const c = plan.names.cursor;
  if (c && upstream[c] !== undefined) {
    const v = upstream[c];
    delete upstream[c];
    if (typeof v === 'string' && v.length > 0 && v.length <= 8192) out.cursor = v;
    else if (v !== null) issues.push({ path: `/${c}`, keyword: 'type', params: { type: 'string' }, message: 'must be string' });
  }
  const l = plan.names.limit;
  if (l && plan.size && l !== plan.size.arg && upstream[l] !== undefined) {
    if (upstream[plan.size.arg] === undefined) upstream[plan.size.arg] = upstream[l];
    delete upstream[l];
  }
  const f = plan.names.fields;
  if (upstream[f] !== undefined) {
    const v = upstream[f];
    delete upstream[f];
    if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string')) issues.push({ path: `/${f}`, keyword: 'type', params: { type: 'array of strings (≤ 50)' }, message: 'must be an array of dot paths' });
    else {
      const bad = (v as string[]).filter((p) => !validPath(p));
      if (bad.length) issues.push({ path: `/${f}`, keyword: 'format', params: { format: 'dot path (a.b.c)' }, message: `invalid paths: ${bad.slice(0, 3).join(', ')}` });
      else if (v.length) out.fields = [...new Set(v as string[])];
    }
  }
  return out;
}

function validPath(p: string): boolean {
  if (!p.trim() || p.length > 200) return false;
  try {
    parsePath(p);
    return true;
  } catch {
    return false;
  }
}

/** The list inside a raw upstream value: the root array or the only array property (any other keys). */
export function itemsOf(v: unknown): unknown[] | null {
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    const arrays = Object.values(v as Record<string, unknown>).filter(Array.isArray);
    if (arrays.length === 1) return arrays[0] as unknown[];
  }
  return null;
}

/** Puts a page position into the spec arguments (after validation). `extraQuery` takes Link parameters no argument maps to. */
export function applyPosition(t: ToolDef, plan: PagingPlan, specArgs: Record<string, unknown>, p: Exclude<CursorPayload, { k: 'r' }>): { extraQuery: Record<string, string | string[]> } {
  const extraQuery: Record<string, string | string[]> = {};
  if (p.k === 'u' && plan.cursor) specArgs[plan.cursor.spec] = p.v;
  else if (p.k === 'p' && plan.page) specArgs[plan.page.spec] = p.n;
  else if (p.k === 'o' && plan.offset) specArgs[plan.offset.spec] = p.n;
  else if (p.k === 'l' && t.binding.type === 'http') {
    const byName = new Map(t.binding.params.filter((x) => x.in === 'query').map((x) => [x.name, x.arg]));
    for (const [name, value] of Object.entries(p.q)) {
      const arg = byName.get(name);
      if (arg) specArgs[arg] = Array.isArray(value) ? value : coerce(value);
      else extraQuery[name] = value;
    }
  }
  return { extraQuery };
}

const coerce = (v: string): string | number => (/^(0|[1-9]\d{0,14})$/.test(v) ? Number(v) : v);

/** What the upstream says about the next page. */
export interface NextSignals {
  /** a next page exists */
  more: boolean;
  /** where it starts (null when the upstream signals more but gives nothing Neurouter can follow) */
  next: Exclude<CursorPayload, { k: 'r' }> | null;
  /** the upstream's total item count, when it reports one */
  total: number | null;
  /** this was the first upstream page (no position argument) */
  first: boolean;
}

const TOTAL_KEYS = ['total_count', 'totalCount', 'total', 'total_results', 'totalResults', 'count_total', 'totalItems', 'total_items'];
const TOKEN_KEY = /^(next_?cursor|next_?page_?token|next_?token|end_?cursor|cursor|next|next_?page|next_?url|next_?link|continuation_?token)$/i;
const MORE_KEY = /^(has_?more|has_?next(_?page)?|more|more_?results)$/i;
const NESTED = /^(meta|pagination|paging|page_?info|response_?metadata|links|_links|cursor|pages)$/i;

/** The upstream's integer total (`total_count`, `total`, …), top level or one level down (`meta.total`). */
export function upstreamTotal(v: unknown): number | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of TOTAL_KEYS) if (typeof o[k] === 'number' && Number.isInteger(o[k]) && (o[k] as number) >= 0) return o[k] as number;
  for (const [k, x] of Object.entries(o)) {
    if (!NESTED.test(k) || !x || typeof x !== 'object' || Array.isArray(x)) continue;
    for (const tk of TOTAL_KEYS) {
      const y = (x as Record<string, unknown>)[tk];
      if (typeof y === 'number' && Number.isInteger(y) && y >= 0) return y;
    }
  }
  return null;
}

function valueAtPath(v: unknown, path: string): unknown {
  let cur = v;
  for (const k of path.split('.').filter(Boolean)) cur = cur && typeof cur === 'object' && !Array.isArray(cur) ? (cur as Record<string, unknown>)[k] : undefined;
  return cur;
}

/** Next-page token / URL / flag in a body: the binding's next path, else known keys at the top or one level down. */
function bodySignals(v: unknown, nextPath: string | undefined): { token?: string; url?: string; page?: number; more?: boolean } {
  const out: { token?: string; url?: string; page?: number; more?: boolean } = {};
  if (!v || typeof v !== 'object' || Array.isArray(v)) return out;
  const take = (k: string, x: unknown) => {
    if (MORE_KEY.test(k) && typeof x === 'boolean') out.more ??= x;
    else if (TOKEN_KEY.test(k)) {
      const val = x && typeof x === 'object' && !Array.isArray(x) && typeof (x as Record<string, unknown>).href === 'string' ? (x as Record<string, unknown>).href : x;
      if (typeof val === 'string' && val.trim()) {
        if (/^(https?:\/\/|\/|\?)/i.test(val)) out.url ??= val;
        else out.token ??= val;
      } else if (typeof val === 'number' && Number.isInteger(val) && val > 0 && /page/i.test(k)) out.page ??= val;
    }
  };
  if (nextPath) take(nextPath.split('.').pop() ?? nextPath, valueAtPath(v, nextPath));
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (NESTED.test(k) && x && typeof x === 'object' && !Array.isArray(x)) for (const [k2, y] of Object.entries(x as Record<string, unknown>)) take(k2, y);
    else take(k, x);
  }
  return out;
}

/** `<https://api.example.com/x?page=2>; rel="next"` → the URL. */
export function linkNext(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const m = /<([^>]+)>\s*;(.*)$/.exec(part.trim());
    if (m && /rel="?([^"]*\s)?next(\s[^"]*)?"?/i.test(m[2]!)) return m[1]!;
  }
  return null;
}

/** The query of a next URL when it points at the environment's API (same origin as the base URL); else null. */
export function linkQuery(url: string, baseUrl: string): Record<string, string | string[]> | null {
  let base: URL;
  let u: URL;
  try {
    base = new URL(baseUrl);
    u = new URL(url, base);
  } catch {
    return null;
  }
  if (u.origin !== base.origin) return null;
  const q: Record<string, string | string[]> = {};
  for (const [k, v] of u.searchParams) {
    const prev = q[k];
    q[k] = prev === undefined ? v : Array.isArray(prev) ? [...prev, v] : [prev, v];
  }
  return Object.keys(q).length ? q : null;
}

/**
 * Whether the upstream has a next page and where it starts, from the raw (unshaped) body and headers.
 * `count` is the number of items the upstream returned on this page. A `Link: rel=next` wins, then a body token
 * (cursor APIs) or the last id (`starting_after`), then page/offset arithmetic. An explicit `has_more`/total decides
 * `more`; an API that declares `Link` headers and sent no `rel=next` is on its last page; other page/offset APIs
 * without a signal are assumed to have more when the page is full. An empty page is final.
 */
export function nextSignals(plan: PagingPlan, specArgs: Record<string, unknown>, body: unknown, headers: Record<string, string>, baseUrl: string, sizeDefault: number | undefined): NextSignals {
  const items = itemsOf(body) ?? [];
  const count = items.length;
  const total = upstreamTotal(body);
  const sig = bodySignals(body, plan.nextPath);
  const pageNo = plan.page ? Math.max(1, Number(specArgs[plan.page.spec] ?? 1) || 1) : null;
  const offset = plan.offset ? Math.max(0, Number(specArgs[plan.offset.spec] ?? 0) || 0) : null;
  const size = plan.size ? Number(specArgs[plan.size.spec] ?? sizeDefault) || undefined : undefined;
  const first = (plan.cursor ? specArgs[plan.cursor.spec] === undefined : true) && (pageNo === null || pageNo === 1) && !offset;
  const before = offset ?? (pageNo !== null && size ? (pageNo - 1) * size : first ? 0 : null);
  const link = linkNext(headers.link) ?? sig.url ?? null;
  const linkQ = link ? linkQuery(link, baseUrl) : null;

  let more: boolean;
  if (count === 0) more = false;
  else if (sig.more !== undefined) more = sig.more;
  else if (link) more = true;
  else if (sig.token) more = true;
  else if (total !== null && before !== null) more = before + count < total;
  else if (plan.link) more = false;
  else if (size !== undefined && (plan.page || plan.offset)) more = count >= size;
  else more = false;

  let next: NextSignals['next'] = null;
  if (more) {
    if (linkQ) next = { k: 'l', q: linkQ };
    else if (plan.cursor && plan.startingAfter) {
      const last = items[items.length - 1];
      const id = last && typeof last === 'object' ? (last as Record<string, unknown>).id : undefined;
      if (typeof id === 'string' || typeof id === 'number') next = { k: 'u', v: String(id) };
    } else if (plan.cursor && sig.token) next = { k: 'u', v: sig.token };
    else if (plan.page && pageNo !== null) next = { k: 'p', n: sig.page ?? pageNo + 1 };
    else if (plan.offset && offset !== null) next = { k: 'o', n: offset + count };
  }
  return { more, next, total, first };
}
