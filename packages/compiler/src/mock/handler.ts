/**
 * In-process mock upstream (backend spec §16). Keyed by HTTP method + path so the data plane calls
 * it exactly like a real upstream; `npx neurouter mock` wraps it in Fastify.
 */
import type { JsonSchema } from '@neurouter/shared';
import { isObj, type Obj } from '../util.js';
import { generateValue, hashSeed, seededFaker } from './generate.js';
import { handleGraphqlMock } from './graphql.js';
import type { MockModel, MockOperation, OpenApiMockModel } from './model.js';
import { asStateStore, DEFAULT_SEED, MockLimitError, newItem, toMockNs, type MockNs, type MockStateStore, type MockStore } from './store.js';
import { defsOf } from '../openapi/schema.js';

export interface MockRequest {
  method: string;
  /** path relative to the base URL, optionally with a query string */
  path: string;
  query?: Record<string, string | string[] | undefined>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

const JSON_HEADERS = { 'content-type': 'application/json' };

function problem(status: number, title: string, detail: string, extra: Obj = {}): MockResponse {
  return { status, headers: { 'content-type': 'application/problem+json' }, body: { type: 'about:blank', title, status, detail, ...extra } };
}

interface Compiled {
  op: MockOperation;
  re: RegExp;
  names: string[];
}

const compiledCache = new WeakMap<OpenApiMockModel, Compiled[]>();

function compiled(model: OpenApiMockModel): Compiled[] {
  let c = compiledCache.get(model);
  if (!c) {
    c = model.operations.map((op) => {
      const names: string[] = [];
      const pattern = op.pathTemplate
        .split('/')
        .map((seg) => {
          const m = /^\{(.+)\}$/.exec(seg);
          if (m) {
            names.push(m[1]!);
            return '([^/]+)';
          }
          return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join('/');
      return { op, re: new RegExp(`^${pattern}/?$`), names };
    });
    compiledCache.set(model, c);
  }
  return c;
}

function firstQuery(q: MockRequest['query'], name: string | undefined): string | undefined {
  if (!name || !q) return undefined;
  const v = q[name];
  return Array.isArray(v) ? v[0] : v;
}

function checkBody(schema: JsonSchema | null, body: unknown): string[] {
  if (!schema) return [];
  const errors: string[] = [];
  if (schema.type === 'object' || isObj(schema.properties)) {
    if (!isObj(body)) return ['request body must be a JSON object'];
    for (const r of (schema.required as string[] | undefined) ?? []) if (body[r] === undefined) errors.push(`missing required field "${r}"`);
    const props = isObj(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    for (const [k, v] of Object.entries(body)) {
      const t = props[k]?.type;
      if (!t || v === null) continue;
      const actual = Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
      const ok = t === actual || (t === 'number' && actual === 'integer') || (Array.isArray(t) && (t as string[]).includes(actual));
      if (!ok) errors.push(`field "${k}" must be ${String(t)}`);
    }
  }
  return errors;
}

/**
 * A list response wrapped in an object (`{total_count, items}`, Stripe's `{object, data, has_more, url}`):
 * the envelope's other fields are generated from its schema so required ones are present.
 */
function listEnvelope(op: MockOperation, nsSeed: number, page: Obj[], total: number, more: boolean, nextCursor: string | null | undefined): Obj {
  const w = op.listWrapper!;
  const props = isObj(w.schema.properties) ? (w.schema.properties as Obj) : {};
  const { [w.arrayProp]: _items, ...rest } = props;
  const faker = seededFaker(hashSeed(nsSeed, op.method, op.pathTemplate, 'envelope'));
  const base = generateValue({ ...w.schema, properties: rest, required: ((w.schema.required as string[] | undefined) ?? []).filter((r) => r !== w.arrayProp) }, 'result', { faker, defs: defsOf(w.schema), depth: 0, index: 1 });
  const out: Obj = isObj(base) ? base : {};
  const closed = w.schema.additionalProperties === false;
  if (!closed || 'total_count' in props) out.total_count = total;
  if ('has_more' in props) out.has_more = more;
  // next-page tokens point at the next page (the list answers them), and are null/absent on the last page;
  // without MOCK_PAGING_HEADER the generated placeholder stays (the 0.1/0.2 mock answers, recorded in goldens)
  for (const k of nextCursor === undefined ? [] : Object.keys(props)) {
    if (!NEXT_TOKEN.test(k)) continue;
    const p = isObj(props[k]) ? (props[k] as Obj) : {};
    const nullable = p.nullable === true || (Array.isArray(p.type) && p.type.includes('null'));
    if (more && nextCursor !== null) out[k] = nextCursor;
    else if (nullable) out[k] = null;
    else delete out[k];
  }
  out[w.arrayProp] = page;
  return out;
}

const NEXT_TOKEN = /^(next_?cursor|next_?page_?token|next_?token)$/i;

/**
 * Request header that makes list next-page tokens real (`tokens`): the token in the body is the next page's
 * position, which the list accepts back as its cursor parameter. Neurouter's contract-2 pipeline sends it (its
 * cursors carry upstream tokens); without it the mock keeps answering as before.
 */
export const MOCK_PAGING_HEADER = 'x-neurouter-mock-paging';

function nowIso(store: MockStateStore): string {
  return new Date(store.now()).toISOString();
}

function touch(item: Obj, store: MockStateStore, created: boolean): void {
  if ('updated_at' in item || created) if ('updated_at' in item) item.updated_at = nowIso(store);
  if (created && 'created_at' in item) item.created_at = nowIso(store);
}

/**
 * Answers one mock request. `store` is any `MockStateStore` (a bare `MockStore` is wrapped in memory);
 * `namespace` is a `MockNs` or, for standalone use, a bare namespace name.
 */
export async function handleMockRequest(model: MockModel, store: MockStateStore | MockStore, namespace: MockNs | string, req: MockRequest): Promise<MockResponse> {
  const method = req.method.toUpperCase();
  const [rawPath, qs] = req.path.split('?', 2) as [string, string | undefined];
  const query: Record<string, string | string[] | undefined> = { ...(req.query ?? {}) };
  if (qs) for (const [k, v] of new URLSearchParams(qs)) query[k] = query[k] === undefined ? v : ([] as string[]).concat(query[k] as string | string[], v);
  if (model.kind === 'graphql') {
    if (rawPath.replace(/\/$/, '') !== model.endpointPath.replace(/\/$/, '')) return problem(404, 'Not Found', `No GraphQL endpoint at ${rawPath}`);
    const body = isObj(req.body) ? req.body : { query: firstQuery(query, 'query'), variables: undefined };
    return { status: 200, headers: JSON_HEADERS, body: await handleGraphqlMock(model, body as { query?: string; variables?: Obj }) };
  }

  let matchedPath = false;
  for (const c of compiled(model)) {
    const m = c.re.exec(rawPath);
    if (!m) continue;
    matchedPath = true;
    if (c.op.method !== method && !(method === 'HEAD' && c.op.method === 'GET')) continue;
    const params: Record<string, string> = {};
    c.names.forEach((n, i) => (params[n] = decodeURIComponent(m[i + 1]!)));
    try {
      const realTokens = Object.entries(req.headers ?? {}).some(([k, v]) => k.toLowerCase() === MOCK_PAGING_HEADER && v === 'tokens');
      return await dispatch(model, asStateStore(store), toMockNs(namespace), c.op, params, query, req.body, realTokens);
    } catch (err) {
      if (err instanceof MockLimitError) return problem(err.status, err.status === 507 ? 'Insufficient Storage' : 'Payload Too Large', err.message, { code: err.code });
      throw err;
    }
  }
  return matchedPath ? problem(405, 'Method Not Allowed', `${method} is not supported on ${rawPath}`) : problem(404, 'Not Found', `No mock operation for ${method} ${rawPath}`);
}

/** Params in a seed: case-insensitive values (`Hello-World` and `hello-world` name the same repo). */
function seedParams(params: Record<string, string>): string {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, String(params[k]).toLowerCase()]));
}

async function dispatch(model: OpenApiMockModel, store: MockStateStore, ns: MockNs, op: MockOperation, params: Record<string, string>, query: Record<string, string | string[] | undefined>, body: unknown, realTokens = false): Promise<MockResponse> {
  // derived from the namespace seed, not its name: an eval attempt sees what generation saw
  const nsSeed = (await store.seedOf?.(ns)) ?? DEFAULT_SEED;
  const resource = op.resource ? model.resources[op.resource] : undefined;
  if (!resource || op.kind === 'action') {
    if (op.requestSchema && op.method !== 'GET') {
      const errs = checkBody(op.requestSchema, body);
      if (errs.length) return problem(422, 'Unprocessable Entity', errs.join('; '), { errors: errs });
    }
    if (op.successStatus === 204 || !op.responseSchema) return { status: op.successStatus, headers: op.successStatus === 204 ? {} : JSON_HEADERS, body: op.successStatus === 204 ? null : {} };
    const faker = seededFaker(hashSeed(nsSeed, op.method, op.pathTemplate, seedParams(params)));
    const defs = isObj(op.responseSchema.$defs) ? (op.responseSchema.$defs as Obj) : {};
    return { status: op.successStatus, headers: JSON_HEADERS, body: generateValue(op.responseSchema, 'result', { faker, defs, depth: 0, index: 1 }) };
  }
  const scope = Object.fromEntries(resource.scopeParams.map((p) => [p, params[p] ?? '']));

  switch (op.kind) {
    case 'list': {
      let items = await store.list(ns, resource, scope);
      for (const [param, field] of Object.entries(op.filters)) {
        const raw = query[param];
        if (raw === undefined || raw === '') continue;
        const wanted = new Set((Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(',')).map((v) => v.trim()));
        if (wanted.has('all')) continue;
        items = items.filter((it) => wanted.has(String(it[field])));
      }
      const total = items.length;
      const paged = op.paging.limit || op.paging.page || op.paging.offset || op.paging.cursor || op.paging.startingAfter;
      const limit = Math.max(1, Math.min(1000, Number(firstQuery(query, op.paging.limit) ?? (paged ? 30 : total || 1)) || 30));
      let offset = 0;
      const after = op.paging.startingAfter ? firstQuery(query, op.paging.startingAfter) : undefined;
      if (op.paging.offset) offset = Number(firstQuery(query, op.paging.offset) ?? 0) || 0;
      else if (after) offset = items.findIndex((it) => String(it[resource.idField]) === after) + 1;
      else if (op.paging.cursor && firstQuery(query, op.paging.cursor)) offset = Number(firstQuery(query, op.paging.cursor)) || 0;
      else if (op.paging.page) offset = (Math.max(1, Number(firstQuery(query, op.paging.page) ?? 1) || 1) - 1) * limit;
      const page = items.slice(offset, offset + limit);
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (offset + limit < total && op.paging.page) headers.link = `<?${op.paging.page}=${Math.floor(offset / limit) + 2}&${op.paging.limit ?? 'per_page'}=${limit}>; rel="next"`;
      const more = offset + page.length < total;
      if (op.listWrapper) return { status: 200, headers, body: listEnvelope(op, nsSeed, page, total, more, !realTokens ? undefined : more && op.paging.cursor ? String(offset + page.length) : null) };
      return { status: op.successStatus, headers, body: page };
    }
    case 'create': {
      const errs = checkBody(op.requestSchema, body);
      if (errs.length) return problem(422, 'Unprocessable Entity', errs.join('; '), { errors: errs });
      const item = await store.create(ns, resource, scope, (id) => {
        const it = { ...newItem(resource, hashSeed(nsSeed, resource.key, id), id, scope), ...(isObj(body) ? body : {}) };
        it[resource.idField] = resource.idType === 'integer' ? id : `${resource.name}_${id}`;
        touch(it, store, true);
        return it;
      });
      return { status: op.successStatus === 200 ? 200 : op.successStatus, headers: JSON_HEADERS, body: item };
    }
    case 'read': {
      const item = await store.get(ns, resource, scope, params[op.idParam!] ?? '');
      if (!item) return problem(404, 'Not Found', `${resource.name} ${params[op.idParam!]} not found`);
      return { status: 200, headers: JSON_HEADERS, body: item };
    }
    case 'update':
    case 'replace': {
      const id = op.bodyId ? (isObj(body) ? String(body[resource.idField] ?? '') : '') : (params[op.idParam!] ?? '');
      const prev = await store.get(ns, resource, scope, id);
      if (!prev) return problem(404, 'Not Found', `${resource.name} ${id} not found`);
      if (!isObj(body)) return problem(422, 'Unprocessable Entity', 'request body must be a JSON object');
      const next = op.kind === 'update' ? { ...prev, ...body } : { ...body };
      next[resource.idField] = prev[resource.idField];
      touch(next, store, false);
      // last writer wins; a concurrent delete in between makes it a 404
      if (!(await store.put(ns, resource, scope, id, next))) return problem(404, 'Not Found', `${resource.name} ${id} not found`);
      return { status: op.successStatus === 204 ? 200 : op.successStatus, headers: JSON_HEADERS, body: next };
    }
    case 'delete': {
      if (!(await store.remove(ns, resource, scope, params[op.idParam!] ?? ''))) return problem(404, 'Not Found', `${resource.name} ${params[op.idParam!]} not found`);
      return { status: 204, headers: {}, body: null };
    }
  }
  return problem(500, 'Internal Server Error', 'unhandled mock operation');
}
