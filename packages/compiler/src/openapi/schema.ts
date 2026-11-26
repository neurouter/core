/**
 * OAS 3.1 schema → JSON Schema 2020-12 for tool inputs/outputs (backend spec §8.2 step 4).
 *
 * Local component `$ref`s are inlined when they are small, not recursive and not too deep; every
 * other component is emitted once per tool under `$defs` and referenced as `{"$ref":"#/$defs/<Name>"}`
 * (deduplicated). The `$defs` of one tool are bounded: components are added breadth-first from the
 * root until `maxBytes`, and references to the rest become open placeholders (`{}` plus
 * `x-neurouter-omitted`), which accept any value. Specs with densely linked components (Stripe's
 * expandable fields) therefore compile to schemas of bounded size instead of exponential copies.
 */
import { isObj, type Obj } from '../util.js';

const KEEP = new Set([
  'type', 'properties', 'items', 'prefixItems', 'required', 'enum', 'const', 'default', 'format', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties',
  'maxProperties', 'description', 'title', 'oneOf', 'anyOf', 'allOf', 'not', 'additionalProperties', 'examples', 'deprecated', 'readOnly',
  'writeOnly', 'contentMediaType', 'contentEncoding', 'patternProperties',
]);

/** Schema nesting depth (levels and reference hops) below which small components are inlined. */
export const INLINE_DEPTH = 8;
/** Guard for non-component pointers (`#/paths/…`) that refer to each other. */
const MAX_WALK_DEPTH = 64;

export interface SchemaLimits {
  /** A component whose fully inlined form (estimated from the spec) is larger than this goes to `$defs`. */
  inlineMaxBytes: number;
  /** Budget for the root plus `$defs`; components past it become open placeholders. */
  maxBytes: number;
  /** A component this large or larger is inlined once per schema; later uses reference `$defs`. */
  dedupeMinBytes: number;
}

/**
 * Tool inputs: everything an agent fills in stays inline as before (GitHub's largest input is ~40 KB);
 * only pathological request bodies are referenced or trimmed.
 */
export const INPUT_SCHEMA_LIMITS: SchemaLimits = { inlineMaxBytes: 64 * 1024, maxBytes: 256 * 1024, dedupeMinBytes: Infinity };
/**
 * Tool outputs (sent to clients in `tools/list` and used for code-mode return types): shared
 * components are referenced once, and a tool's whole output schema stays below 64 KB.
 */
export const OUTPUT_SCHEMA_LIMITS: SchemaLimits = { inlineMaxBytes: 4 * 1024, maxBytes: 64 * 1024, dedupeMinBytes: 512 };

export interface ConvertOptions {
  /** drop `readOnly` properties (inputs) or `writeOnly` properties (outputs) */
  drop?: 'readOnly' | 'writeOnly';
  /** default: INPUT_SCHEMA_LIMITS */
  limits?: SchemaLimits;
}

export interface ConvertResult {
  schema: Obj;
  /** `$defs` the schema refers to (attach them to the root you return to the agent) */
  defs: Obj;
  /** components replaced by open placeholders because the budget ran out */
  omitted: string[];
  /** serialized size of schema + defs */
  bytes: number;
  /** serialized size of the root alone (above `maxBytes`: the schema cannot be published within the budget) */
  rootBytes: number;
}

/** Marker of a component left out of a schema (the placeholder accepts any value). */
export const OMITTED_KEY = 'x-neurouter-omitted';

interface WalkCtx {
  opts: ConvertOptions;
  limits: SchemaLimits;
  /** def key → component name, in discovery order (breadth-first from the root) */
  queue: string[];
  queued: Set<string>;
  /** components inlined so far (dedupe: the next use references `$defs`) */
  inlined: Set<string>;
}

class Over extends Error {}

export class SchemaResolver {
  private readonly componentSchemas: Obj;
  /** component name → estimated fully inlined size (capped; Infinity when over the cap) */
  private readonly expanded = new Map<string, number>();
  /** component name → `$defs` key (unique, pointer-safe) */
  private readonly keys = new Map<string, string>();
  private readonly usedKeys = new Set<string>();

  constructor(private readonly doc: Obj) {
    const comps = isObj(doc.components) ? doc.components : {};
    this.componentSchemas = isObj(comps.schemas) ? comps.schemas : {};
  }

  /** Resolves a local JSON pointer `#/a/b` (any component kind). */
  pointer(ref: string): unknown {
    if (!ref.startsWith('#/')) return undefined;
    let cur: unknown = this.doc;
    for (const raw of ref.slice(2).split('/')) {
      const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
      if (!isObj(cur) && !Array.isArray(cur)) return undefined;
      cur = (cur as Obj)[seg];
    }
    return cur;
  }

  /** Follows `$ref` chains for non-schema objects (parameters, requestBodies, responses). */
  deref<T = Obj>(v: unknown, guard = 0): T | undefined {
    if (isObj(v) && typeof v.$ref === 'string' && guard < 20) return this.deref<T>(this.pointer(v.$ref), guard + 1);
    return v as T | undefined;
  }

  /** Name of a component schema ref (`#/components/schemas/Pet` → `Pet`). */
  static refName(ref: string): string | null {
    const m = /^#\/components\/schemas\/(.+)$/.exec(ref);
    return m ? decodeURIComponent(m[1]!).replace(/~1/g, '/').replace(/~0/g, '~') : null;
  }

  /** `$defs` key of a component: its name when pointer-safe, else a sanitized unique name. */
  defKey(name: string): string {
    let k = this.keys.get(name);
    if (k !== undefined) return k;
    const base = /^[A-Za-z0-9._-]+$/.test(name) ? name : name.replace(/[^A-Za-z0-9._-]/g, '_') || 'schema';
    k = base;
    for (let i = 2; this.usedKeys.has(k); i++) k = `${base}_${i}`;
    this.keys.set(name, k);
    this.usedKeys.add(k);
    return k;
  }

  /** `object`/`array`/… of a component when it says so directly (a hint for mock values of omitted parts). */
  private componentType(name: string): string | null {
    const c = this.componentSchemas[name];
    if (!isObj(c)) return null;
    if (typeof c.type === 'string') return c.type;
    return isObj(c.properties) ? 'object' : null;
  }

  private nameOfKey(key: string): string {
    for (const [n, k] of this.keys) if (k === key) return n;
    return key;
  }

  /**
   * Estimated size of a component with every non-recursive reference inlined (as the converter
   * would at most), from the raw spec. Bounded work: the walk stops once it passes `cap`.
   */
  expandedSize(name: string, cap = INPUT_SCHEMA_LIMITS.inlineMaxBytes): number {
    const hit = this.expanded.get(name);
    if (hit !== undefined) return hit;
    const budget = { left: cap };
    let size: number;
    try {
      this.estimate(this.componentSchemas[name], [name], 1, budget);
      size = cap - budget.left;
    } catch (e) {
      if (!(e instanceof Over)) throw e;
      size = Infinity;
    }
    this.expanded.set(name, size);
    return size;
  }

  private estimate(raw: unknown, stack: string[], depth: number, budget: { left: number }): void {
    if (budget.left < 0) throw new Over();
    if (!isObj(raw)) {
      budget.left -= 6;
      return;
    }
    if (typeof raw.$ref === 'string') {
      const name = SchemaResolver.refName(raw.$ref);
      if (name === null || stack.includes(name) || depth >= INLINE_DEPTH) {
        budget.left -= 40;
        return;
      }
      this.estimate(this.componentSchemas[name], [...stack, name], depth + 1, budget);
      return;
    }
    budget.left -= 2;
    for (const [k, v] of Object.entries(raw)) {
      if (!KEEP.has(k) && k !== 'example') continue;
      budget.left -= k.length + 4;
      if ((k === 'properties' || k === 'patternProperties') && isObj(v)) {
        for (const [pk, pv] of Object.entries(v)) {
          budget.left -= pk.length + 4;
          this.estimate(pv, stack, depth + 1, budget);
        }
      } else if (k === 'items' || k === 'not' || (k === 'additionalProperties' && isObj(v))) this.estimate(v, stack, depth + 1, budget);
      else if ((k === 'allOf' || k === 'anyOf' || k === 'oneOf' || k === 'prefixItems') && Array.isArray(v)) for (const x of v) this.estimate(x, stack, depth + 1, budget);
      else budget.left -= plainSize(v);
      if (budget.left < 0) throw new Over();
    }
  }

  /**
   * Converts a schema (see the module comment for how references are inlined, shared or trimmed).
   * With deduplication on, the plain inlined form is tried too and the smaller complete one wins, so
   * a schema never grows compared with inlining alone.
   */
  convert(schema: unknown, opts: ConvertOptions = {}): ConvertResult {
    const limits = opts.limits ?? INPUT_SCHEMA_LIMITS;
    let best = this.convertWith(schema, opts, limits);
    // without $defs nothing was shared or trimmed: the plain form is the same schema
    if (Number.isFinite(limits.dedupeMinBytes) && Object.keys(best.defs).length) {
      const plain = this.convertWith(schema, opts, { ...limits, dedupeMinBytes: Infinity, inlineMaxBytes: Math.max(limits.inlineMaxBytes, INPUT_SCHEMA_LIMITS.inlineMaxBytes) });
      if (plain.omitted.length < best.omitted.length || (plain.omitted.length === best.omitted.length && plain.bytes < best.bytes)) best = plain;
    }
    // a root that is too large with components inlined: reference every component instead
    if (best.rootBytes > limits.maxBytes && limits.inlineMaxBytes > 0) best = this.convertWith(schema, opts, { ...limits, inlineMaxBytes: 0 });
    return best;
  }

  private convertWith(schema: unknown, opts: ConvertOptions, limits: SchemaLimits): ConvertResult {
    const ctx: WalkCtx = { opts, limits, queue: [], queued: new Set(), inlined: new Set() };
    // the root itself is never a bare reference: callers inspect its type and properties
    let out: Obj;
    const rootName = isObj(schema) && typeof schema.$ref === 'string' ? SchemaResolver.refName(schema.$ref) : null;
    if (rootName !== null && isObj(this.componentSchemas[rootName])) {
      out = this.walk(this.componentSchemas[rootName], 1, [rootName], ctx);
      if (!out.title && /^[A-Za-z][A-Za-z0-9_]*$/.test(rootName)) out = { ...out, 'x-schema-name': rootName };
    } else out = this.walk(schema, 0, [], ctx);

    let bytes = jsonSize(out);
    const defs: Obj = {};
    const omitted: string[] = [];
    const refsOnly: WalkCtx = { ...ctx, limits: { ...limits, inlineMaxBytes: 0 } };
    // breadth-first from the root: nearer components keep their full schema
    for (let i = 0; i < ctx.queue.length; i++) {
      const name = ctx.queue[i]!;
      const key = this.defKey(name);
      if (bytes >= limits.maxBytes) {
        omitted.push(name);
        continue;
      }
      let body = this.walk(this.componentSchemas[name], 0, [name], ctx);
      let size = jsonSize(body) + key.length + 4;
      // too large with its small parts inlined: keep its own fields and reference the parts
      if (bytes + size > limits.maxBytes && limits.inlineMaxBytes > 0) {
        body = this.walk(this.componentSchemas[name], 0, [name], refsOnly);
        size = jsonSize(body) + key.length + 4;
      }
      if (bytes + size > limits.maxBytes) {
        omitted.push(name);
        continue;
      }
      defs[key] = body;
      bytes += size;
    }
    if (omitted.length) {
      // placeholders are a little longer than references: drop the farthest defs until it fits
      const kept = Object.keys(defs);
      for (;;) {
        const gone = new Map(omitted.map((n) => [`#/$defs/${this.defKey(n)}`, { name: n, type: this.componentType(n) }]));
        out = replaceRefs(out, gone) as Obj;
        for (const k of Object.keys(defs)) defs[k] = replaceRefs(defs[k], gone);
        bytes = jsonSize(out) + jsonSize(defs);
        if (bytes <= limits.maxBytes || !kept.length) break;
        const drop = kept.splice(Math.max(0, kept.length - Math.max(1, Math.ceil(kept.length / 10))));
        for (const k of drop) {
          delete defs[k];
          omitted.push(this.nameOfKey(k));
        }
      }
    }
    return { schema: out, defs, omitted, bytes, rootBytes: jsonSize(out) };
  }

  private ref(name: string, ctx: WalkCtx): Obj {
    if (!ctx.queued.has(name)) {
      ctx.queued.add(name);
      ctx.queue.push(name);
    }
    return { $ref: `#/$defs/${this.defKey(name)}` };
  }

  private walk(raw: unknown, depth: number, stack: string[], ctx: WalkCtx): Obj {
    if (raw === true || raw === undefined) return {};
    if (raw === false) return { not: {} };
    if (!isObj(raw) || depth > MAX_WALK_DEPTH) return {};
    const opts = ctx.opts;
    if (typeof raw.$ref === 'string') {
      const name = SchemaResolver.refName(raw.$ref);
      if (name !== null) {
        const target = this.componentSchemas[name];
        if (target === undefined) return {};
        const size = this.expandedSize(name);
        if (stack.includes(name) || depth >= INLINE_DEPTH || size > ctx.limits.inlineMaxBytes || ctx.queued.has(name)) return this.ref(name, ctx);
        if (size >= ctx.limits.dedupeMinBytes) {
          if (ctx.inlined.has(name)) return this.ref(name, ctx);
          ctx.inlined.add(name);
        }
        const res = this.walk(target, depth + 1, [...stack, name], ctx);
        if (!res.title && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return { ...res, 'x-schema-name': name };
        return res;
      }
      const target = this.pointer(raw.$ref);
      return target === undefined ? {} : this.walk(target, depth + 1, stack, ctx);
    }
    const out: Obj = {};
    for (const [k, v] of Object.entries(raw)) {
      if (!KEEP.has(k)) {
        if (k === 'example' && out.examples === undefined) out.examples = [v];
        continue;
      }
      switch (k) {
        case 'properties': {
          if (!isObj(v)) break;
          const props: Obj = {};
          const dropped: string[] = [];
          for (const [pk, pv] of Object.entries(v)) {
            const walked = this.walk(pv, depth + 1, stack, ctx);
            if (opts.drop && (walked[opts.drop] === true || this.refFlag(pv, opts.drop))) {
              dropped.push(pk);
              continue;
            }
            props[pk] = walked;
          }
          out.properties = props;
          if (dropped.length && Array.isArray(raw.required)) out.required = (raw.required as string[]).filter((r) => !dropped.includes(r));
          break;
        }
        case 'items':
        case 'not':
          out[k] = this.walk(v, depth + 1, stack, ctx);
          break;
        case 'additionalProperties':
          out[k] = typeof v === 'boolean' ? v : this.walk(v, depth + 1, stack, ctx);
          break;
        case 'patternProperties':
          if (isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, this.walk(pv, depth + 1, stack, ctx)]));
          break;
        case 'prefixItems':
        case 'oneOf':
        case 'anyOf':
        case 'allOf':
          if (Array.isArray(v)) out[k] = v.map((x) => this.walk(x, depth + 1, stack, ctx));
          break;
        case 'required':
          if (out.required === undefined && Array.isArray(v)) out.required = [...(v as string[])];
          break;
        case 'readOnly':
        case 'writeOnly':
          if (v === true) out[k] = true;
          break;
        default:
          out[k] = v;
      }
    }
    // allOf of objects → merge (common in specs; keeps schemas agent-friendly)
    if (Array.isArray(out.allOf) && (out.allOf as Obj[]).every((s) => isObj(s) && !s.$ref && (s.type === 'object' || s.properties))) {
      const parts = out.allOf as Obj[];
      delete out.allOf;
      const props: Obj = { ...((out.properties as Obj) ?? {}) };
      const req = new Set<string>((out.required as string[]) ?? []);
      for (const p of parts) {
        Object.assign(props, (p.properties as Obj) ?? {});
        for (const r of (p.required as string[]) ?? []) req.add(r);
        if (!out.description && typeof p.description === 'string') out.description = p.description;
      }
      out.type = 'object';
      out.properties = props;
      if (req.size) out.required = [...req];
    }
    return out;
  }

  /** `readOnly`/`writeOnly` set on a referenced component (the reference itself carries no flag). */
  private refFlag(raw: unknown, flag: 'readOnly' | 'writeOnly'): boolean {
    if (!isObj(raw) || typeof raw.$ref !== 'string') return false;
    const name = SchemaResolver.refName(raw.$ref);
    const target = name !== null ? this.componentSchemas[name] : undefined;
    return isObj(target) && target[flag] === true;
  }
}

/** Rough serialized size of a plain JSON value (no allocation). */
function plainSize(v: unknown, depth = 0): number {
  if (typeof v === 'string') return v.length + 2;
  if (Array.isArray(v)) return depth > 16 ? 2 : v.reduce<number>((a, x) => a + plainSize(x, depth + 1) + 1, 2);
  if (isObj(v)) return depth > 16 ? 2 : Object.entries(v).reduce<number>((a, [k, x]) => a + k.length + 3 + plainSize(x, depth + 1), 2);
  return 6;
}

function jsonSize(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v) ?? 'null', 'utf8');
}

/** Marker hint: the JSON type of an omitted component (does not constrain validation). */
export const OMITTED_TYPE_KEY = 'x-neurouter-omitted-type';

/** Replaces `{"$ref": <gone>}` with an open placeholder (copy-on-write). */
function replaceRefs(v: unknown, gone: Map<string, { name: string; type: string | null }>): unknown {
  if (Array.isArray(v)) {
    let changed = false;
    const out = v.map((x) => {
      const y = replaceRefs(x, gone);
      if (y !== x) changed = true;
      return y;
    });
    return changed ? out : v;
  }
  if (!isObj(v)) return v;
  if (typeof v.$ref === 'string' && gone.has(v.$ref)) {
    const { name, type } = gone.get(v.$ref)!;
    return { description: `${name} (schema omitted: too large to include)`, [OMITTED_KEY]: name, ...(type ? { [OMITTED_TYPE_KEY]: type } : {}) };
  }
  let out: Obj | null = null;
  for (const [k, x] of Object.entries(v)) {
    const y = replaceRefs(x, gone);
    if (y !== x) (out ??= { ...v })[k] = y;
  }
  return out ?? v;
}

/* ------------------------------------------------------------------ reading schemas with $defs */

/** The `$defs` of a root schema ({} when none). */
export function defsOf(root: unknown): Obj {
  return isObj(root) && isObj(root.$defs) ? root.$defs : {};
}

/** The `$defs` name a local reference points at (`#/$defs/Name` → `Name`). */
export function defRefName(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const m = /^#\/\$defs\/(.+)$/.exec(ref);
  return m ? m[1]!.replace(/~1/g, '/').replace(/~0/g, '~') : null;
}

/**
 * Follows `#/$defs/…` references (chains included) to the schema they name, tagged with
 * `x-schema-name`. Anything else is returned as is.
 */
export function derefSchema(s: unknown, defs: Obj): Obj {
  let cur: unknown = s;
  let name: string | null = null;
  for (let i = 0; i < 16 && isObj(cur) && typeof cur.$ref === 'string'; i++) {
    const n = defRefName(cur.$ref);
    if (n === null || !isObj(defs[n])) break;
    name = n;
    cur = defs[n];
  }
  if (!isObj(cur)) return {};
  return name !== null && !cur['x-schema-name'] ? { ...cur, 'x-schema-name': name } : cur;
}

/** Attaches `$defs` to a sub-schema taken out of its root (so its references still resolve). */
export function withDefs(s: Obj, defs: Obj): Obj {
  if (!Object.keys(defs).length || isObj(s.$defs)) return s;
  return { ...s, $defs: defs };
}

/** Drops `$defs` entries the schema no longer reaches (after shaping removed fields). */
export function pruneDefs(root: Obj): Obj {
  const defs = defsOf(root);
  if (!Object.keys(defs).length) return root;
  const reached = new Set<string>();
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!isObj(v)) return;
    const n = defRefName(v.$ref);
    if (n !== null && !reached.has(n)) {
      reached.add(n);
      visit(defs[n]);
    }
    for (const [k, x] of Object.entries(v)) if (k !== '$defs') visit(x);
  };
  visit(root);
  const { $defs: _d, ...rest } = root;
  const kept = Object.fromEntries(Object.entries(defs).filter(([k]) => reached.has(k)));
  return Object.keys(kept).length ? { ...rest, $defs: kept } : rest;
}

/** Nesting depth of a schema (objects/arrays); `#/$defs` references are followed (recursion stops). */
export function schemaDepth(schema: unknown, seen = 0, defs: Obj = defsOf(schema), stack: string[] = []): number {
  if (!isObj(schema) || seen > 32) return 0;
  const n = defRefName(schema.$ref);
  if (n !== null) return stack.includes(n) ? 0 : schemaDepth(defs[n], seen, defs, [...stack, n]);
  let max = 0;
  if (isObj(schema.properties)) for (const v of Object.values(schema.properties)) max = Math.max(max, 1 + schemaDepth(v, seen + 1, defs, stack));
  if (schema.items) max = Math.max(max, 1 + schemaDepth(schema.items, seen + 1, defs, stack));
  for (const k of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(schema[k])) for (const s of schema[k] as unknown[]) max = Math.max(max, schemaDepth(s, seen + 1, defs, stack));
  return max;
}

/** Counts leaf fields in a schema (for the `output_shaped` lint rule); `#/$defs` references are followed. */
export function countFields(schema: unknown, budget = { n: 0 }, depth = 0, defs: Obj = defsOf(schema)): number {
  if (!isObj(schema) || depth > 10 || budget.n > 1000) return budget.n;
  const n = defRefName(schema.$ref);
  if (n !== null) return countFields(defs[n], budget, depth + 1, defs);
  if (isObj(schema.properties)) {
    for (const v of Object.values(schema.properties)) {
      budget.n++;
      countFields(v, budget, depth + 1, defs);
    }
  }
  if (schema.items) countFields(schema.items, budget, depth + 1, defs);
  return budget.n;
}
