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
  /**
   * pagination params understood by the list: page size (`limit`, default and maximum from its schema),
   * page number, offset, an opaque cursor, and id cursors (Stripe `starting_after` / `ending_before`)
   */
  paging: { limit?: string; page?: string; offset?: string; cursor?: string; startingAfter?: string; endingBefore?: string; defaultLimit?: number; maxLimit?: number };
  /** list ops: query params that filter by a range object (`amount[gte]=50`, `created[lt]=…`): param → field */
  rangeFilters?: Record<string, string>;
  /** list ops: sort params (`sort=updated`, `direction=asc`, `order=desc`) */
  sort?: { param?: string; directionParam?: string; defaultDirection?: 'asc' | 'desc'; defaultParam?: string };
  /**
   * list ops: the order without sort params, as the real API lists (0.3.2): newest first where the spec says so
   * (`sort` default a date with `direction` default desc; "most recent … first" in the description) or by vendor
   * convention (Stripe: every list with `starting_after` is newest first by `created`); overlay `mock.order` overrides.
   */
  defaultOrder?: { field: string; direction: 'asc' | 'desc'; source: 'sort_default' | 'description' | 'convention' | 'overlay' };
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
  /**
   * The resource whose seed this one shares (same item schema and id field, fewer scope params:
   * `/v1/charges/{charge}/refunds` → `/v1/refunds`), so an id names the same object in both
   * collections (data version 2).
   */
  seedKey?: string;
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

/** The entity an item schema describes: its schema name, else its `title` (compiled Stripe item schemas are inline, named by title). */
function entityKey(s: JsonSchema | null | undefined): string | null {
  return schemaKey(s) ?? (isObj(s) && typeof s.title === 'string' && s.title.trim() && isObj(s.properties) ? `title:${s.title.trim()}` : null);
}

function singular(word: string): string {
  if (/ies$/.test(word)) return word.slice(0, -3) + 'y';
  if (/sses$|xes$|ches$|shes$/.test(word)) return word.slice(0, -2);
  if (/s$/.test(word) && !/ss$/.test(word)) return word.slice(0, -1);
  return word;
}

/**
 * The object properties of a schema, following `$ref`, `allOf` (merged) and `anyOf`/`oneOf` (first
 * object branch). Item schemas taken from responses are often a bare `$ref` (Stripe
 * `terminal.configuration`): reading `properties` directly found none, so the item id fell back to the
 * path param (`configuration`) while the generated `id` stayed random, and no filter was recognized.
 */
export function objectProps(schema: unknown, depth = 0): Record<string, JsonSchema> {
  if (!isObj(schema) || depth > 8) return {};
  const defs = defsOf(schema);
  const s = typeof schema.$ref === 'string' ? derefSchema(schema, defs) : schema;
  const out: Record<string, JsonSchema> = {};
  const resolve = (v: unknown): JsonSchema => (isObj(v) ? (withDefs(derefSchema(v, defs), defs) as JsonSchema) : {});
  if (isObj(s.properties)) for (const [k, v] of Object.entries(s.properties as Obj)) out[k] = resolve(v);
  if (Array.isArray(s.allOf)) for (const part of s.allOf) Object.assign(out, objectProps(withDefs(resolve(part), defs), depth + 1));
  if (!Object.keys(out).length)
    for (const k of ['anyOf', 'oneOf'] as const)
      if (Array.isArray(s[k])) {
        for (const b of s[k] as unknown[]) {
          const p = objectProps(withDefs(resolve(b), defs), depth + 1);
          if (Object.keys(p).length) return p;
        }
      }
  return out;
}

/** The scalar type of a property schema (`type`, a nullable type list, or an anyOf with one scalar branch). */
export function scalarTypeOf(schema: unknown): 'string' | 'integer' | 'number' | 'boolean' | null {
  if (!isObj(schema)) return null;
  const scalars = ['string', 'integer', 'number', 'boolean'];
  if (typeof schema.type === 'string') return scalars.includes(schema.type) ? (schema.type as 'string') : null;
  if (Array.isArray(schema.type)) {
    const t = (schema.type as string[]).filter((x) => x !== 'null');
    return t.length === 1 && scalars.includes(t[0]!) ? (t[0] as 'string') : null;
  }
  if (Array.isArray(schema.enum) && schema.enum.length) return typeof schema.enum[0] === 'string' ? 'string' : typeof schema.enum[0] === 'boolean' ? 'boolean' : typeof schema.enum[0] === 'number' ? 'number' : null;
  for (const k of ['anyOf', 'oneOf'] as const)
    if (Array.isArray(schema[k])) {
      const ts = (schema[k] as unknown[]).map(scalarTypeOf).filter((x): x is NonNullable<typeof x> => x !== null);
      if (ts.length === 1) return ts[0]!;
    }
  return null;
}

/** A query param schema that accepts a range object (`{gt, gte, lt, lte}`), alone or in an anyOf. */
function isRangeParam(schema: unknown, defs: Obj): boolean {
  if (!isObj(schema)) return false;
  const s = derefSchema(schema, defs);
  const props = isObj(s.properties) ? Object.keys(s.properties as Obj) : [];
  if (props.length && props.every((p) => ['gt', 'gte', 'lt', 'lte'].includes(p))) return true;
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(s[k]) && (s[k] as unknown[]).some((b) => isRangeParam(b, defs))) return true;
  return false;
}

function idFieldFor(itemSchema: JsonSchema, idParam: string | null): { field: string; type: 'integer' | 'string' } {
  const props = objectProps(itemSchema);
  const typeOf = (f: string): 'integer' | 'string' => (scalarTypeOf(props[f]) === 'integer' || scalarTypeOf(props[f]) === 'number' ? 'integer' : 'string');
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
  for (const [k, v] of Object.entries(objectProps(schema))) if (scalarTypeOf(v)) out.add(k);
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
      if (itemSchema && !Object.keys(objectProps(existing.itemSchema)).length && Object.keys(objectProps(itemSchema)).length) {
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
  // nested collections of a top-level resource's objects share its seed (same id → same object)
  const canonical = new Map<string, MockResource>();
  for (const r of Object.values(resources)) {
    const k = entityKey(r.itemSchema);
    if (!k) continue;
    const c = canonical.get(k);
    if (!c || r.scopeParams.length < c.scopeParams.length) canonical.set(k, r);
  }
  for (const r of Object.values(resources)) {
    const c = canonical.get(entityKey(r.itemSchema) ?? '');
    if (c && c !== r && c.idField === r.idField && c.name === r.name) r.seedKey = c.key;
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
      const inProps = isObj(t.inputSchema.properties) ? (t.inputSchema.properties as Obj) : {};
      const inDefs = defsOf(t.inputSchema);
      for (const p of b.params) {
        if (p.in !== 'query') continue;
        const n = p.name.toLowerCase();
        const ps = derefSchema(inProps[p.arg] ?? {}, inDefs);
        if (['limit', 'per_page', 'page_size', 'pagesize'].includes(n)) {
          base.paging.limit = p.name;
          if (typeof ps.default === 'number') base.paging.defaultLimit = ps.default;
          if (typeof ps.maximum === 'number') base.paging.maxLimit = ps.maximum;
        } else if (n === 'page') base.paging.page = p.name;
        else if (n === 'offset') base.paging.offset = p.name;
        else if (['cursor', 'page_token', 'pagetoken', 'after'].includes(n)) base.paging.cursor = p.name;
        else if (n === 'starting_after') base.paging.startingAfter = p.name;
        else if (n === 'ending_before') base.paging.endingBefore = p.name;
        else if (n === 'sort' || n === 'sort_by' || n === 'order_by') {
          (base.sort ??= {}).param = p.name;
          if (typeof ps.default === 'string') base.sort.defaultParam = ps.default;
        }
        else if (n === 'direction' || n === 'order' || n === 'sort_direction') {
          (base.sort ??= {}).directionParam = p.name;
          if (ps.default === 'asc' || ps.default === 'desc') base.sort.defaultDirection = ps.default;
        } else {
          const field = fields.has(p.name) ? p.name : [...fields].find((f) => f.toLowerCase() === n);
          if (!field) continue;
          if (isRangeParam(ps, inDefs)) (base.rangeFilters ??= {})[p.name] = field;
          // a deepObject param that is only a range (`created[gte]`) is not an equality filter on its own
          if (p.style !== 'deepObject' || !isRangeParam(ps, inDefs) || scalarTypeOf(ps)) base.filters[p.name] = field;
        }
      }
      if (isObj(out) && out.type !== 'array' && isObj(out.properties)) {
        const outDefs = defsOf(out);
        const arrProp = Object.entries(out.properties as Obj).find(([, v]) => isObj(v) && derefSchema(v, outDefs).type === 'array');
        if (arrProp) base.listWrapper = { arrayProp: arrProp[0], schema: out };
      }
      const order = newestFirst(base, Object.keys(objectProps(r.itemSchema)), t.description ?? '');
      if (order) base.defaultOrder = order;
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

const CREATED_FIELDS = ['created', 'created_at', 'createdAt', 'creation_date'];
const NEWEST_FIRST_TEXT = /\b(most recent|newest|latest)\b[^.]{0,80}\b(first|top)\b|reverse chronological|sorted by (creation|created) date, (with )?the (most recent|newest)/i;

/** The newest-first order of a list op, when the spec or the vendor's convention says the API lists that way. */
function newestFirst(op: MockOperation, fields: string[], description: string): MockOperation['defaultOrder'] | null {
  // a documented sort default (GitHub `sort=created`, `direction=desc`): only when it is a date listed newest first
  const d = op.sort?.defaultParam;
  if (d) {
    const field = [d, `${d}_at`, `${d}d_at`, d.replace(/d$/, '') + 'd_at'].find((k) => fields.includes(k));
    const isDate = !!field && /(_at|created|updated|pushed)$/.test(field);
    const dir = op.sort?.defaultDirection ?? (isDate ? 'desc' : 'asc');
    return field && isDate && dir === 'desc' ? { field, direction: 'desc', source: 'sort_default' } : null;
  }
  const created = CREATED_FIELDS.find((f) => fields.includes(f));
  if (!created) return null;
  if (NEWEST_FIRST_TEXT.test(description)) return { field: created, direction: 'desc', source: 'description' };
  // Stripe: all list endpoints return the newest objects first (id cursors `starting_after` / `ending_before`, `has_more`)
  const props = op.listWrapper && isObj(op.listWrapper.schema.properties) ? Object.keys(op.listWrapper.schema.properties as Obj) : [];
  if (op.paging.startingAfter && props.includes('has_more') && created === 'created') return { field: created, direction: 'desc', source: 'convention' };
  return null;
}

/** Overlay `mock.order` on list tools: `"<field> asc|desc"` sets the order without sort params, `none` keeps insertion order. */
export function applyMockOrder(model: OpenApiMockModel, tools: Array<Pick<ToolDef, 'binding'>>, order: (tool: Pick<ToolDef, 'binding'>) => string | undefined): void {
  for (const t of tools) {
    if (t.binding.type !== 'http') continue;
    const o = order(t);
    if (!o) continue;
    const b = t.binding as HttpBinding;
    const op = model.operations.find((x) => x.method === b.method && x.pathTemplate === b.pathTemplate && x.kind === 'list');
    if (!op) continue;
    if (o === 'none') delete op.defaultOrder;
    else {
      const [field, dir] = o.split(/\s+/);
      op.defaultOrder = { field: field!, direction: dir === 'asc' ? 'asc' : 'desc', source: 'overlay' };
    }
  }
}

function specificity(p: string): number {
  const segs = p.split('/').filter(Boolean);
  return segs.length * 10 + segs.filter((s) => !isParamSeg(s)).length;
}
