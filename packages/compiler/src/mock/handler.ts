/**
 * In-process mock upstream (backend spec §16). Keyed by HTTP method + path so the data plane calls
 * it exactly like a real upstream; `npx neurouter mock` wraps it in Fastify.
 */
import type { JsonSchema } from '@neurouter/shared';
import { isObj, type Obj } from '../util.js';
import { generateValue, hashSeed, seededFaker } from './generate.js';
import { handleGraphqlMock } from './graphql.js';
import type { MockModel, MockOperation, OpenApiMockModel } from './model.js';
import { newItem, type MockStore } from './store.js';

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

function nowIso(store: MockStore): string {
  return new Date(store.now()).toISOString();
}

function touch(item: Obj, store: MockStore, created: boolean): void {
  if ('updated_at' in item || created) if ('updated_at' in item) item.updated_at = nowIso(store);
  if (created && 'created_at' in item) item.created_at = nowIso(store);
}

export async function handleMockRequest(model: MockModel, store: MockStore, namespace: string, req: MockRequest): Promise<MockResponse> {
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
    return dispatch(model, store, namespace, c.op, params, query, req.body);
  }
  return matchedPath ? problem(405, 'Method Not Allowed', `${method} is not supported on ${rawPath}`) : problem(404, 'Not Found', `No mock operation for ${method} ${rawPath}`);
}

function dispatch(model: OpenApiMockModel, store: MockStore, namespace: string, op: MockOperation, params: Record<string, string>, query: Record<string, string | string[] | undefined>, body: unknown): MockResponse {
  const resource = op.resource ? model.resources[op.resource] : undefined;
  if (!resource || op.kind === 'action') {
    if (op.requestSchema && op.method !== 'GET') {
      const errs = checkBody(op.requestSchema, body);
      if (errs.length) return problem(422, 'Unprocessable Entity', errs.join('; '), { errors: errs });
    }
    if (op.successStatus === 204 || !op.responseSchema) return { status: op.successStatus, headers: op.successStatus === 204 ? {} : JSON_HEADERS, body: op.successStatus === 204 ? null : {} };
    const faker = seededFaker(hashSeed(namespace, op.method, op.pathTemplate, JSON.stringify(params)));
    const defs = isObj(op.responseSchema.$defs) ? (op.responseSchema.$defs as Obj) : {};
    return { status: op.successStatus, headers: JSON_HEADERS, body: generateValue(op.responseSchema, 'result', { faker, defs, depth: 0, index: 1 }) };
  }
  const scope = Object.fromEntries(resource.scopeParams.map((p) => [p, params[p] ?? '']));
  const coll = store.collection(namespace, resource, scope);
  const idOf = (it: Obj) => String(it[resource.idField]);
  const find = (id: string) => coll.items.findIndex((it) => idOf(it) === id);

  switch (op.kind) {
    case 'list': {
      let items = coll.items;
      for (const [param, field] of Object.entries(op.filters)) {
        const raw = query[param];
        if (raw === undefined || raw === '') continue;
        const wanted = new Set((Array.isArray(raw) ? raw : [raw]).flatMap((v) => v.split(',')).map((v) => v.trim()));
        if (wanted.has('all')) continue;
        items = items.filter((it) => wanted.has(String(it[field])));
      }
      const total = items.length;
      const paged = op.paging.limit || op.paging.page || op.paging.offset || op.paging.cursor;
      const limit = Math.max(1, Math.min(1000, Number(firstQuery(query, op.paging.limit) ?? (paged ? 30 : total || 1)) || 30));
      let offset = 0;
      if (op.paging.offset) offset = Number(firstQuery(query, op.paging.offset) ?? 0) || 0;
      else if (op.paging.cursor && firstQuery(query, op.paging.cursor)) offset = Number(firstQuery(query, op.paging.cursor)) || 0;
      else if (op.paging.page) offset = (Math.max(1, Number(firstQuery(query, op.paging.page) ?? 1) || 1) - 1) * limit;
      const page = items.slice(offset, offset + limit);
      const headers: Record<string, string> = { ...JSON_HEADERS };
      if (offset + limit < total && op.paging.page) headers.link = `<?${op.paging.page}=${Math.floor(offset / limit) + 2}&${op.paging.limit ?? 'per_page'}=${limit}>; rel="next"`;
      if (op.listWrapper) return { status: 200, headers, body: { total_count: total, [op.listWrapper.arrayProp]: page } };
      return { status: op.successStatus, headers, body: page };
    }
    case 'create': {
      const errs = checkBody(op.requestSchema, body);
      if (errs.length) return problem(422, 'Unprocessable Entity', errs.join('; '), { errors: errs });
      const id = coll.nextId++;
      const item = { ...newItem(resource, hashSeed(namespace, resource.key, id), id, scope), ...(isObj(body) ? body : {}) };
      item[resource.idField] = resource.idType === 'integer' ? id : `${resource.name}_${id}`;
      touch(item, store, true);
      coll.items.push(item);
      return { status: op.successStatus === 200 ? 200 : op.successStatus, headers: JSON_HEADERS, body: item };
    }
    case 'read': {
      const i = find(params[op.idParam!] ?? '');
      if (i < 0) return problem(404, 'Not Found', `${resource.name} ${params[op.idParam!]} not found`);
      return { status: 200, headers: JSON_HEADERS, body: coll.items[i] };
    }
    case 'update':
    case 'replace': {
      const id = op.bodyId ? (isObj(body) ? String(body[resource.idField] ?? '') : '') : (params[op.idParam!] ?? '');
      const i = find(id);
      if (i < 0) return problem(404, 'Not Found', `${resource.name} ${id} not found`);
      if (!isObj(body)) return problem(422, 'Unprocessable Entity', 'request body must be a JSON object');
      const prev = coll.items[i]!;
      const next = op.kind === 'update' ? { ...prev, ...body } : { ...body };
      next[resource.idField] = prev[resource.idField];
      touch(next, store, false);
      coll.items[i] = next;
      return { status: op.successStatus === 204 ? 200 : op.successStatus, headers: JSON_HEADERS, body: next };
    }
    case 'delete': {
      const i = find(params[op.idParam!] ?? '');
      if (i < 0) return problem(404, 'Not Found', `${resource.name} ${params[op.idParam!]} not found`);
      coll.items.splice(i, 1);
      return { status: 204, headers: {}, body: null };
    }
  }
  return problem(500, 'Internal Server Error', 'unhandled mock operation');
}
