/**
 * Mock state (backend spec §16, multi-tenancy spec §7.2). `MockStateStore` is the async interface the
 * handler goes through; `MemoryMockStateStore` keeps it in process memory (`MockStore`: LRU eviction
 * and idle TTL), the server's `DbMockStateStore` keeps it in the database so every instance sees it.
 * Collections are seeded lazily and deterministically per (namespace seed, resource): the seed items
 * do not depend on the namespace name or the scope values, so the sample entities the eval generator
 * sees (`gen:` namespace, default scope) are exactly what an eval attempt (`eval:` namespace, any
 * spelling of `owner/repo`) reads. Scope params on the items are set to the requested scope.
 */
import type { JsonSchema } from '@neurouter/shared';
import { isObj, sha256Hex, type Obj } from '../util.js';
import { generateValue, hashSeed, MOCK_DATA_VERSION, mockDataVersionOf, mockScaleOf, scaledCount, SEED_ITEMS, seededFaker, type MockDataVersion, type MockScale } from './generate.js';
import type { MockResource, OpenApiMockModel } from './model.js';

export { SEED_ITEMS };
export const DEFAULT_SEED = 42;
/** Max items per collection (create beyond it → 507 `mock_collection_full`). */
export const MOCK_MAX_ITEMS = 1000;
/** Max JSON size of one item (→ 413 `mock_item_too_large`). */
export const MOCK_MAX_ITEM_BYTES = 64 * 1024;

/**
 * A mock state namespace, bound to a tenant and an environment. `name` is `env` (the environment's
 * shared state), `eval:<runId>:<taskRun>` (one eval attempt) or `gen:…` (eval generation / previews).
 * Standalone use (CLI) leaves `tenantId`/`environmentId` empty.
 */
export interface MockNs {
  tenantId: string;
  environmentId: string;
  name: string;
}

export type MockScope = Record<string, string>;

/** The async state store behind the mock handler (spec §7.2). Item ids are `String(item[resource.idField])`. */
export interface MockStateStore {
  /** Clock for server-generated timestamps (`created_at`, `updated_at`). */
  now(): number;
  /** Items in insertion order; the collection is seeded lazily (deterministic per seed, resource, scope). */
  list(ns: MockNs, r: MockResource, scope: MockScope): Promise<Obj[]>;
  get(ns: MockNs, r: MockResource, scope: MockScope, id: string): Promise<Obj | null>;
  /** Allocates the next id and stores `make(id)`. Throws `MockLimitError` when the collection is full or the item too large. */
  create(ns: MockNs, r: MockResource, scope: MockScope, make: (id: number) => Obj): Promise<Obj>;
  /** Replaces an item (last writer wins); false = not found. */
  put(ns: MockNs, r: MockResource, scope: MockScope, id: string, next: Obj): Promise<boolean>;
  /** false = not found. */
  remove(ns: MockNs, r: MockResource, scope: MockScope, id: string): Promise<boolean>;
  /** Drops the namespace; it is reseeded on next use (with `seed`, default the store seed). */
  reset(ns: MockNs, seed?: number): Promise<void>;
  /** The namespace's seed (created items and action responses derive from it); default `DEFAULT_SEED`. */
  seedOf?(ns: MockNs): Promise<number>;
}

/** A store limit was hit (§7.5); the handler answers with a problem JSON. */
export class MockLimitError extends Error {
  constructor(
    readonly status: 413 | 507,
    readonly code: 'mock_collection_full' | 'mock_item_too_large',
    message: string,
  ) {
    super(message);
    this.name = 'MockLimitError';
  }
}

export function collectionFull(r: MockResource): MockLimitError {
  return new MockLimitError(507, 'mock_collection_full', `The mock ${r.name} collection is full (${MOCK_MAX_ITEMS} items); reset the mock state or delete items`);
}

/** Serialized item and its size; throws when over `MOCK_MAX_ITEM_BYTES`. */
export function itemJson(r: MockResource, item: Obj): { json: string; bytes: number } {
  const json = JSON.stringify(item);
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > MOCK_MAX_ITEM_BYTES) throw new MockLimitError(413, 'mock_item_too_large', `A mock ${r.name} item is limited to ${MOCK_MAX_ITEM_BYTES} bytes of JSON (got ${bytes})`);
  return { json, bytes };
}

/** `name=value&…` over the resource's scope params (the collection's partition key). */
export function scopeKeyOf(r: MockResource, scope: MockScope): string {
  return r.scopeParams.map((p) => `${p}=${scope[p] ?? ''}`).join('&');
}

/** `<resource.key>|<scopeKey>`, or its sha256 hex when longer than 200 chars (DB key column). */
export function collectionKeyOf(r: MockResource, scope: MockScope): string {
  const key = `${r.key}|${scopeKeyOf(r, scope)}`;
  return key.length > 200 ? sha256Hex(key) : key;
}

/**
 * The string the handler derives per-namespace seeds from (created items, action responses). The
 * environment namespace keeps its historical `env:<environmentId>` so outputs don't change.
 */
export function mockSeedKey(ns: MockNs): string {
  return ns.name === 'env' && ns.environmentId ? `env:${ns.environmentId}` : ns.name;
}

/** A bare namespace string (CLI, older callers) as a `MockNs` without tenant or environment. */
export function toMockNs(ns: MockNs | string): MockNs {
  return typeof ns === 'string' ? { tenantId: '', environmentId: '', name: ns } : ns;
}

/**
 * Seed of a resource's collections: the namespace seed and the resource, never the scope values. From
 * data version 2 a nested collection of a top-level resource's objects uses that resource's seed
 * (`seedKey`), so `refund_1` listed under a charge is the `refund_1` that `GET /v1/refunds/refund_1` returns.
 */
export function collectionSeed(r: MockResource, nsSeed: number, dv: MockDataVersion = MOCK_DATA_VERSION, scale?: MockScale | null, scope?: MockScope): number {
  const base = hashSeed(nsSeed, dv >= 2 && r.seedKey ? r.seedKey : r.key);
  // a scaled namespace seeds each scope of a nested collection on its own (scope values case-insensitive);
  // a collection that shares a top-level resource's objects (`seedKey`) keeps sharing them
  if (!scale || !r.scopeParams.length || (dv >= 2 && r.seedKey) || !scope) return base;
  return hashSeed(base, ...r.scopeParams.map((p) => String(scope[p] ?? '').toLowerCase()));
}

/**
 * The seed items of a collection (exactly what both stores hold before any write): `SEED_ITEMS` (20), or
 * the count a scaled namespace asks for (`scale`, see `MockScale`). `dv`: mock data version.
 */
export function seedItems(r: MockResource, scope: MockScope, nsSeed: number, dv: MockDataVersion = MOCK_DATA_VERSION, scale?: MockScale | null): Obj[] {
  const seed = collectionSeed(r, nsSeed, dv, scale, scope);
  const n = scaledCount(scale, r.name, seed);
  const items: Obj[] = [];
  for (let i = 1; i <= n; i++) items.push(newItem(r, hashSeed(seed, i), i, scope, dv));
  return items;
}

/** The seed items of a collection in a namespace (its data version and scale come from the name). */
export function seedItemsFor(r: MockResource, scope: MockScope, nsSeed: number, namespace: string): Obj[] {
  return seedItems(r, scope, nsSeed, mockDataVersionOf(namespace), mockScaleOf(namespace));
}

export interface Collection {
  items: Obj[];
  nextId: number;
}

interface NsState {
  seed: number;
  collections: Map<string, Collection>;
  lastUsed: number;
}

export interface MockStoreOptions {
  seed?: number;
  maxNamespaces?: number;
  idleTtlMs?: number;
  now?: () => number;
}

const SCOPE_DEFAULTS: Record<string, string> = { owner: 'octocat', repo: 'hello-world', org: 'acme', username: 'octocat', user: 'octocat' };

export function defaultScopeValue(param: string, resource: MockResource): string {
  return resource.defaultScope[param] ?? SCOPE_DEFAULTS[param] ?? 'demo';
}

export class MockStore {
  private readonly ns = new Map<string, NsState>();
  readonly seed: number;
  private readonly max: number;
  private readonly ttl: number;
  readonly now: () => number;

  constructor(opts: MockStoreOptions = {}) {
    this.seed = opts.seed ?? DEFAULT_SEED;
    this.max = opts.maxNamespaces ?? 500;
    this.ttl = opts.idleTtlMs ?? 3_600_000;
    this.now = opts.now ?? Date.now;
  }

  private state(namespace: string): NsState {
    const t = this.now();
    let s = this.ns.get(namespace);
    if (s && t - s.lastUsed > this.ttl) s = undefined;
    if (!s) s = { seed: this.seed, collections: new Map(), lastUsed: t };
    this.ns.delete(namespace);
    s.lastUsed = t;
    this.ns.set(namespace, s);
    while (this.ns.size > this.max) this.ns.delete(this.ns.keys().next().value!);
    return s;
  }

  /** Drops the namespace's state; it is reseeded (with `seed`, default the store seed) on next use. */
  resetNamespace(namespace: string, seed?: number): void {
    this.ns.delete(namespace);
    if (seed !== undefined) this.ns.set(namespace, { seed, collections: new Map(), lastUsed: this.now() });
  }

  /** The namespace's seed (the store seed unless it was reset with another). */
  seedOf(namespace: string): number {
    return this.ns.get(namespace)?.seed ?? this.seed;
  }

  namespaces(): string[] {
    return [...this.ns.keys()];
  }

  /** The (lazily seeded) collection for a resource and scope. */
  collection(namespace: string, resource: MockResource, scope: Record<string, string>): Collection {
    const s = this.state(namespace);
    const key = `${resource.key}|${scopeKeyOf(resource, scope)}`;
    let c = s.collections.get(key);
    if (!c) {
      const items = seedItemsFor(resource, scope, s.seed, namespace);
      c = { items, nextId: Math.max(SEED_ITEMS, items.length) + 1 };
      s.collections.set(key, c);
    }
    return c;
  }
}

/**
 * `MockStore` behind the async `MockStateStore` interface (CLI `mock`, CLI `eval --spec`, and the
 * server with `NEUROUTER_MOCK_STORE=memory`). Namespaces are keyed by tenant + environment + name;
 * a `MockNs` without tenant and environment uses the bare name (so `MockStore.resetNamespace(name)` works).
 */
export class MemoryMockStateStore implements MockStateStore {
  readonly store: MockStore;

  constructor(opts: MockStoreOptions | MockStore = {}) {
    this.store = opts instanceof MockStore ? opts : new MockStore(opts);
  }

  static key(ns: MockNs): string {
    return ns.tenantId || ns.environmentId ? `${ns.tenantId}/${ns.environmentId}/${ns.name}` : ns.name;
  }

  now(): number {
    return this.store.now();
  }

  private coll(ns: MockNs, r: MockResource, scope: MockScope): Collection {
    return this.store.collection(MemoryMockStateStore.key(ns), r, scope);
  }

  private index(c: Collection, r: MockResource, id: string): number {
    return c.items.findIndex((it) => String(it[r.idField]) === id);
  }

  async list(ns: MockNs, r: MockResource, scope: MockScope): Promise<Obj[]> {
    return [...this.coll(ns, r, scope).items];
  }

  async get(ns: MockNs, r: MockResource, scope: MockScope, id: string): Promise<Obj | null> {
    const c = this.coll(ns, r, scope);
    return c.items[this.index(c, r, id)] ?? null;
  }

  async create(ns: MockNs, r: MockResource, scope: MockScope, make: (id: number) => Obj): Promise<Obj> {
    const c = this.coll(ns, r, scope);
    if (c.items.length >= MOCK_MAX_ITEMS) throw collectionFull(r);
    const item = make(c.nextId);
    itemJson(r, item);
    c.nextId++;
    c.items.push(item);
    return item;
  }

  async put(ns: MockNs, r: MockResource, scope: MockScope, id: string, next: Obj): Promise<boolean> {
    const c = this.coll(ns, r, scope);
    const i = this.index(c, r, id);
    if (i < 0) return false;
    itemJson(r, next);
    c.items[i] = next;
    return true;
  }

  async remove(ns: MockNs, r: MockResource, scope: MockScope, id: string): Promise<boolean> {
    const c = this.coll(ns, r, scope);
    const i = this.index(c, r, id);
    if (i < 0) return false;
    c.items.splice(i, 1);
    return true;
  }

  async reset(ns: MockNs, seed?: number): Promise<void> {
    this.store.resetNamespace(MemoryMockStateStore.key(ns), seed);
  }

  async seedOf(ns: MockNs): Promise<number> {
    return this.store.seedOf(MemoryMockStateStore.key(ns));
  }
}

const wrappers = new WeakMap<MockStore, MemoryMockStateStore>();
/** Accepts a bare `MockStore` (older callers) wherever a `MockStateStore` is expected. */
export function asStateStore(store: MockStateStore | MockStore): MockStateStore {
  if (!(store instanceof MockStore)) return store;
  let w = wrappers.get(store);
  if (!w) wrappers.set(store, (w = new MemoryMockStateStore(store)));
  return w;
}

export function newItem(resource: MockResource, seed: number, index: number, scope: Record<string, string>, dv: MockDataVersion = MOCK_DATA_VERSION): Obj {
  const faker = seededFaker(seed);
  const defs = isObj(resource.itemSchema.$defs) ? (resource.itemSchema.$defs as Obj) : {};
  const v = generateValue(resource.itemSchema as JsonSchema, resource.name, { faker, defs, depth: 0, index, dv, resource: resource.name });
  const item: Obj = isObj(v) ? v : {};
  item[resource.idField] = resource.idType === 'integer' ? index : `${resource.name}_${index}`;
  const props = isObj(resource.itemSchema.properties) ? resource.itemSchema.properties : {};
  for (const sp of resource.scopeParams) if (sp in props && scope[sp] !== undefined) item[sp] = scope[sp];
  return item;
}

/** Up to `n` sample entities per resource in the default scope (for eval task generation). */
export async function sampleEntities(model: OpenApiMockModel, store: MockStateStore | MockStore, namespace: MockNs | string, n = 3): Promise<Array<{ resource: string; name: string; scope: Record<string, string>; idField: string; items: Obj[] }>> {
  const s = asStateStore(store);
  const ns = toMockNs(namespace);
  const out = [];
  for (const r of Object.values(model.resources)) {
    const scope = Object.fromEntries(r.scopeParams.map((p) => [p, defaultScopeValue(p, r)]));
    out.push({ resource: r.key, name: r.name, scope, idField: r.idField, items: (await s.list(ns, r, scope)).slice(0, n) });
  }
  return out;
}
