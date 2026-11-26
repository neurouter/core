/**
 * Mock model inferred from the tool model (backend spec §16): resources from collection/item
 * paths, operations classified as list/create/read/replace/update/delete/action, scopes from the
 * path params before the collection segment. Plain JSON so it can be stored with a build.
 */
import type { HttpBinding, JsonSchema, ToolDef } from '@neurouter/shared';
import { defRefName, defsOf, derefSchema, withDefs } from '../openapi/schema.js';
import { isObj, type Obj } from '../util.js';

export type MockOpKind = 'list' | 'create' | 'read' | 'replace' | 'update' | 'delete' | 'action';

export interface MockOperation {
  method: HttpBinding['method'];
  pathTemplate: string;
  kind: MockOpKind;
  /** resource key (collection path template) for stateful kinds */
  resource: string | null;
  /** path params bound to the scope (resource scope params) */
  scopeParams: string[];
  /** item id path param (read/update/replace/delete) */
  idParam: string | null;
  successStatus: number;
  /** list ops: query params that filter by an item field (param name → field) */
  filters: Record<string, string>;
  /** list ops: response wrapper (`null` = bare array; else the array property and its sibling schema) */
  listWrapper: { arrayProp: string; schema: JsonSchema } | null;
  responseSchema: JsonSchema | null;
  requestSchema: JsonSchema | null;
  /** PUT/PATCH on a collection path updating the item named by the body id (Petstore `PUT /pet`) */
  bodyId?: boolean;
  /** pagination params understood by the list */
  paging: { limit?: string; page?: string; offset?: string; cursor?: string };
  example?: unknown;
}

export interface MockResource {
  key: string;
  name: string;
  itemSchema: JsonSchema;
  idField: string;
  idType: 'integer' | 'string';
  scopeParams: string[];
  /** default scope values (from examples or `demo`) */
  defaultScope: Record<string, string>;
}

export interface OpenApiMockModel {
  kind: 'openapi';
  resources: Record<string, MockResource>;
  operations: MockOperation[];
}

export interface GraphqlMockModel {
  kind: 'graphql';
  /** the SDL (or introspection JSON) text; the executable schema is built lazily */
  schemaText: string;
  format: 'graphql-sdl' | 'graphql-introspection';
  endpointPath: string;
}

export type MockModel = OpenApiMockModel | GraphqlMockModel;

const isParamSeg = (s: string) => /^\{.+\}$/.test(s);
const paramName = (s: string) => s.slice(1, -1);

/**
 * The response schema without the MCP wrapper, with `#/$defs` references followed at the top and the
 * root's `$defs` attached (so the generator can still resolve nested references).
 */
function unwrapOutput(o: JsonSchema | undefined): JsonSchema | null {
  if (!isObj(o)) return null;
  const defs = defsOf(o);
  const w = o['x-neurouter-wrapped'];
  if (typeof w === 'string' && isObj(o.properties)) {
    const inner = (o.properties as Obj)[w];
    return isObj(inner) ? (withDefs(derefSchema(inner, defs), defs) as JsonSchema) : null;
  }
  return o;
}

/** Array items of a schema, dereferenced, carrying the root's `$defs`. */
function itemsOf(s: JsonSchema | null): JsonSchema | null {
  if (!isObj(s) || !isObj(s.items)) return null;
  const defs = defsOf(s);
  return withDefs(derefSchema(s.items, defs), defs) as JsonSchema;
}

function schemaKey(s: JsonSchema | null | undefined): string | null {
  if (!isObj(s)) return null;
  if (typeof s['x-schema-name'] === 'string') return s['x-schema-name'] as string;
  return defRefName(s.$ref);
}

function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/sses$|xes$|ches$|shes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

function idFieldFor(itemSchema: JsonSchema, idParam: string | null): { field: string; type: 'integer' | 'string' } {
  const props = isObj(itemSchema.properties) ? (itemSchema.properties as Record<string, JsonSchema>) : {};
  const typeOf = (f: string): 'integer' | 'string' => (props[f]?.type === 'integer' || props[f]?.type === 'number' ? 'integer' : 'string');
  if (idParam) {
    if (idParam in props) return { field: idParam, type: typeOf(idParam) };
    const lower = idParam.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const f of Object.keys(props)) {
      const lf = f.toLowerCase().replace(/[^a-z0-9]/g, '');
      if (lf !== '' && lower.endsWith(lf) && lf.length >= 2) return { field: f, type: typeOf(f) };
    }
  }
  if ('id' in props) return { field: 'id', type: typeOf('id') };
  if (idParam) return { field: idParam, type: 'string' };
  return { field: 'id', type: 'integer' };
}

function paramArg(binding: HttpBinding, name: string): string {
  return binding.params.find((p) => p.name === name)?.arg ?? name;
}

function scalarProps(schema: JsonSchema | null): Set<string> {
  const out = new Set<string>();
  if (isObj(schema?.properties)) for (const [k, v] of Object.entries(schema.properties as Obj)) if (isObj(v) && ['string', 'integer', 'number', 'boolean'].includes(v.type as string)) out.add(k);
  return out;
}

function bodySchema(t: ToolDef): JsonSchema | null {
  const b = t.binding as HttpBinding;
  if (!b.body) return null;
  const props = isObj(t.inputSchema.properties) ? (t.inputSchema.properties as Record<string, JsonSchema>) : {};
  if (b.body.arg) {
    const defs = defsOf(t.inputSchema);
    const s = props[b.body.arg];
    return s ? (withDefs(derefSchema(s, defs), defs) as JsonSchema) : null;
  }
  const names = b.body.properties ?? [];
  return { type: 'object', properties: Object.fromEntries(names.filter((n) => n in props).map((n) => [n, props[n]!])), required: ((t.inputSchema.required as string[]) ?? []).filter((r) => names.includes(r)) };
}

/** Builds the mock model from compiled (pre-overlay) HTTP tools. */
export function buildMockModel(tools: ToolDef[]): OpenApiMockModel {
  const http = tools.filter((t) => t.binding.type === 'http');
  const byPath = new Map<string, ToolDef[]>();
  for (const t of http) {
    const p = (t.binding as HttpBinding).pathTemplate;
    byPath.set(p, [...(byPath.get(p) ?? []), t]);
  }
  const resources: Record<string, MockResource> = {};
  const ensureResource = (collection: string, itemSchema: JsonSchema | null, idParam: string | null) => {
    const segs = collection.split('/').filter(Boolean);
    const scopeParams = segs.filter(isParamSeg).map(paramName);
    const existing = resources[collection];
    if (existing) {
      if (itemSchema && !isObj(existing.itemSchema.properties) && isObj(itemSchema.properties)) {
        const id = idFieldFor(itemSchema, idParam);
        Object.assign(existing, { itemSchema, idField: id.field, idType: id.type });
      }
      return existing;
    }
    const schema = itemSchema ?? { type: 'object', properties: { id: { type: 'integer' } } };
    const id = idFieldFor(schema, idParam);
    const last = segs.filter((s) => !isParamSeg(s)).pop() ?? 'item';
    resources[collection] = { key: collection, name: singular(last.replace(/[^A-Za-z0-9]/g, '_').toLowerCase()) || 'item', itemSchema: schema, idField: id.field, idType: id.type, scopeParams, defaultScope: {} };
    return resources[collection];
  };

  // pass 1: item paths define resources (collection = parent path)
  for (const [path, ts] of byPath) {
    const segs = path.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last || !isParamSeg(last)) continue;
    const collection = '/' + segs.slice(0, -1).join('/');
    if (segs.length < 2 || isParamSeg(segs[segs.length - 2]!)) continue;
    const read = ts.find((t) => (t.binding as HttpBinding).method === 'GET');
    const listT = byPath.get(collection)?.find((t) => (t.binding as HttpBinding).method === 'GET');
    const listOut = unwrapOutput(listT?.outputSchema);
    const item = unwrapOutput(read?.outputSchema) ?? (isObj(listOut) && listOut.type === 'array' ? itemsOf(listOut) : null);
    ensureResource(collection, item, paramName(last));
  }
  // pass 2: collection paths with GET array (unless it lists a known resource's items: a list alias)
  const pass1Schemas = new Set(Object.values(resources).map((r) => schemaKey(r.itemSchema)).filter((k): k is string => !!k));
  for (const [path, ts] of byPath) {
    if (resources[path]) continue;
    const segs = path.split('/').filter(Boolean);
    const last = segs[segs.length - 1];
    if (!last || isParamSeg(last)) continue;
    const get = ts.find((t) => (t.binding as HttpBinding).method === 'GET');
    const out = unwrapOutput(get?.outputSchema);
    if (isObj(out) && out.type === 'array') {
      const k = schemaKey(out.items as JsonSchema);
      if (k && pass1Schemas.has(k) && !ts.some((t) => (t.binding as HttpBinding).method === 'POST')) continue;
      ensureResource(path, itemsOf(out), null);
    }
  }
  const bySchemaName = new Map<string, string>();
  for (const r of Object.values(resources)) {
    const k = schemaKey(r.itemSchema);
    if (k && !bySchemaName.has(k)) bySchemaName.set(k, r.key);
  }

  const operations: MockOperation[] = [];
  for (const t of http) {
    const b = t.binding as HttpBinding;
    const segs = b.pathTemplate.split('/').filter(Boolean);
    const last = segs[segs.length - 1] ?? '';
    const out = unwrapOutput(t.outputSchema);
    const success = b.successStatuses[0] ?? 200;
    const base: MockOperation = {
      method: b.method,
      pathTemplate: b.pathTemplate,
      kind: 'action',
      resource: null,
      scopeParams: [],
      idParam: null,
      successStatus: success,
      filters: {},
      listWrapper: null,
      responseSchema: out,
      requestSchema: bodySchema(t),
      paging: {},
    };
    const parent = '/' + segs.slice(0, -1).join('/');
    let resKey: string | null = null;
    if (isParamSeg(last) && resources[parent]) {
      resKey = parent;
      base.idParam = paramName(last);
      base.kind = b.method === 'GET' ? 'read' : b.method === 'PUT' ? 'replace' : b.method === 'PATCH' ? 'update' : b.method === 'DELETE' ? 'delete' : 'action';
    } else if (resources[b.pathTemplate]) {
      resKey = b.pathTemplate;
      if (b.method === 'GET') base.kind = 'list';
      else if (b.method === 'POST') base.kind = 'create';
      else if (b.method === 'PUT' || b.method === 'PATCH') {
        base.kind = b.method === 'PUT' ? 'replace' : 'update';
        base.bodyId = true;
      }
    } else if (b.method === 'GET') {
      // list alias: GET returning an array of a known resource's item schema (Petstore /pet/findByStatus)
      const arr = isObj(out) && out.type === 'array' ? (out.items as JsonSchema) : null;
      const k = schemaKey(arr);
      if (k && bySchemaName.has(k)) {
        resKey = bySchemaName.get(k)!;
        base.kind = 'list';
      }
    }
    if (resKey) {
      const r = resources[resKey]!;
      base.resource = resKey;
      base.scopeParams = r.scopeParams;
      if (base.kind === 'action' && b.method !== 'GET') base.resource = null;
    }
    if (base.kind === 'list' && base.resource) {
      const r = resources[base.resource]!;
      const fields = scalarProps(r.itemSchema);
      for (const p of b.params) {
        if (p.in !== 'query') continue;
        const n = p.name.toLowerCase();
        if (['limit', 'per_page', 'page_size', 'pagesize'].includes(n)) base.paging.limit = p.name;
        else if (n === 'page') base.paging.page = p.name;
        else if (n === 'offset') base.paging.offset = p.name;
        else if (['cursor', 'page_token', 'after'].includes(n)) base.paging.cursor = p.name;
        else if (fields.has(p.name)) base.filters[p.name] = p.name;
        else {
          const match = [...fields].find((f) => f.toLowerCase() === n);
          if (match) base.filters[p.name] = match;
        }
      }
      if (isObj(out) && out.type !== 'array' && isObj(out.properties)) {
        const outDefs = defsOf(out);
        const arrProp = Object.entries(out.properties as Obj).find(([, v]) => isObj(v) && derefSchema(v, outDefs).type === 'array');
        if (arrProp) base.listWrapper = { arrayProp: arrProp[0], schema: out };
      }
    }
    // default scope values from examples
    if (base.resource && t.examples[0]) {
      const r = resources[base.resource]!;
      for (const sp of r.scopeParams) {
        const v = t.examples[0].arguments[paramArg(b, sp)];
        if ((typeof v === 'string' || typeof v === 'number') && r.defaultScope[sp] === undefined) r.defaultScope[sp] = String(v);
      }
    }
    operations.push(base);
  }
  // most specific first: more literal segments, then fewer params
  operations.sort((a, b) => specificity(b.pathTemplate) - specificity(a.pathTemplate));
  return { kind: 'openapi', resources, operations };
}

function specificity(p: string): number {
  const segs = p.split('/').filter(Boolean);
  return segs.length * 10 + segs.filter((s) => !isParamSeg(s)).length;
}
