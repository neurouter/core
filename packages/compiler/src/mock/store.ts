/**
 * In-memory mock state (backend spec §16): `Map<namespace, …>` with LRU eviction and idle TTL.
 * Collections are seeded lazily and deterministically per (namespace seed, resource, scope).
 */
import type { JsonSchema } from '@neurouter/shared';
import { isObj, type Obj } from '../util.js';
import { generateValue, hashSeed, seededFaker } from './generate.js';
import type { MockResource, OpenApiMockModel } from './model.js';

export const SEED_ITEMS = 20;
export const DEFAULT_SEED = 42;

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

  namespaces(): string[] {
    return [...this.ns.keys()];
  }

  /** The (lazily seeded) collection for a resource and scope. */
  collection(namespace: string, resource: MockResource, scope: Record<string, string>): Collection {
    const s = this.state(namespace);
    const scopeKey = resource.scopeParams.map((p) => `${p}=${scope[p] ?? ''}`).join('&');
    const key = `${resource.key}|${scopeKey}`;
    let c = s.collections.get(key);
    if (!c) {
      c = seedCollection(resource, scope, hashSeed(s.seed, resource.key, scopeKey));
      s.collections.set(key, c);
    }
    return c;
  }
}

export function newItem(resource: MockResource, seed: number, index: number, scope: Record<string, string>): Obj {
  const faker = seededFaker(seed);
  const defs = isObj(resource.itemSchema.$defs) ? (resource.itemSchema.$defs as Obj) : {};
  const v = generateValue(resource.itemSchema as JsonSchema, resource.name, { faker, defs, depth: 0, index });
  const item: Obj = isObj(v) ? v : {};
  item[resource.idField] = resource.idType === 'integer' ? index : `${resource.name}_${index}`;
  const props = isObj(resource.itemSchema.properties) ? resource.itemSchema.properties : {};
  for (const sp of resource.scopeParams) if (sp in props && scope[sp] !== undefined) item[sp] = scope[sp];
  return item;
}

function seedCollection(resource: MockResource, scope: Record<string, string>, seed: number): Collection {
  const items: Obj[] = [];
  for (let i = 1; i <= SEED_ITEMS; i++) items.push(newItem(resource, hashSeed(seed, i), i, scope));
  return { items, nextId: SEED_ITEMS + 1 };
}

/** Up to `n` sample entities per resource in the default scope (for eval task generation). */
export function sampleEntities(model: OpenApiMockModel, store: MockStore, namespace: string, n = 3): Array<{ resource: string; name: string; scope: Record<string, string>; idField: string; items: Obj[] }> {
  return Object.values(model.resources).map((r) => {
    const scope = Object.fromEntries(r.scopeParams.map((p) => [p, defaultScopeValue(p, r)]));
    return { resource: r.key, name: r.name, scope, idField: r.idField, items: store.collection(namespace, r, scope).items.slice(0, n) };
  });
}
