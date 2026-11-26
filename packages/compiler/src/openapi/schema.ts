/**
 * OAS 3.1 schema → JSON Schema 2020-12 for tool inputs/outputs. Resolves local `$ref`s with an
 * inline depth limit; recursive (or too deep) references become `{"$ref":"#/$defs/<Name>"}` and
 * the referenced schemas are attached under `$defs` (backend spec §8.2 step 4).
 */
import { isObj, type Obj } from '../util.js';

const KEEP = new Set([
  'type', 'properties', 'items', 'prefixItems', 'required', 'enum', 'const', 'default', 'format', 'pattern', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties',
  'maxProperties', 'description', 'title', 'oneOf', 'anyOf', 'allOf', 'not', 'additionalProperties', 'examples', 'deprecated', 'readOnly',
  'writeOnly', 'contentMediaType', 'contentEncoding', 'patternProperties',
]);

export const INLINE_DEPTH = 8;

export interface ConvertOptions {
  /** drop `readOnly` properties (inputs) or `writeOnly` properties (outputs) */
  drop?: 'readOnly' | 'writeOnly';
}

export class SchemaResolver {
  private readonly componentSchemas: Obj;
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

  /**
   * Converts a schema. Returns the schema plus `$defs` needed by recursive references (attach them to
   * the root you return to the agent).
   */
  convert(schema: unknown, opts: ConvertOptions = {}): { schema: Obj; defs: Obj } {
    const defs: Obj = {};
    const pending: string[] = [];
    const out = this.walk(schema, 0, [], opts, defs, pending);
    // materialize $defs (they may reference further defs)
    while (pending.length) {
      const name = pending.shift()!;
      if (defs[name] !== undefined && defs[name] !== null) continue;
      defs[name] = this.walk(this.componentSchemas[name], 0, [name], opts, defs, pending);
    }
    return { schema: out, defs };
  }

  private walk(raw: unknown, depth: number, stack: string[], opts: ConvertOptions, defs: Obj, pending: string[]): Obj {
    if (raw === true || raw === undefined) return {};
    if (raw === false) return { not: {} };
    if (!isObj(raw)) return {};
    if (typeof raw.$ref === 'string') {
      const name = SchemaResolver.refName(raw.$ref);
      if (name !== null) {
        if (stack.includes(name) || depth >= INLINE_DEPTH) {
          if (!(name in defs)) {
            defs[name] = null; // placeholder
            pending.push(name);
          }
          return { $ref: `#/$defs/${name}` };
        }
        const target = this.componentSchemas[name];
        const res = this.walk(target, depth + 1, [...stack, name], opts, defs, pending);
        if (!res.title && /^[A-Za-z][A-Za-z0-9_]*$/.test(name)) return { ...res, 'x-schema-name': name };
        return res;
      }
      const target = this.pointer(raw.$ref);
      return target === undefined ? {} : this.walk(target, depth + 1, stack, opts, defs, pending);
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
            const walked = this.walk(pv, depth + 1, stack, opts, defs, pending);
            if (opts.drop && walked[opts.drop] === true) {
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
          out[k] = this.walk(v, depth + 1, stack, opts, defs, pending);
          break;
        case 'additionalProperties':
          out[k] = typeof v === 'boolean' ? v : this.walk(v, depth + 1, stack, opts, defs, pending);
          break;
        case 'patternProperties':
          if (isObj(v)) out[k] = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, this.walk(pv, depth + 1, stack, opts, defs, pending)]));
          break;
        case 'prefixItems':
        case 'oneOf':
        case 'anyOf':
        case 'allOf':
          if (Array.isArray(v)) out[k] = v.map((x) => this.walk(x, depth + 1, stack, opts, defs, pending));
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
}

/** Nesting depth of a schema (objects/arrays). */
export function schemaDepth(schema: unknown, seen = 0): number {
  if (!isObj(schema) || seen > 32) return 0;
  let max = 0;
  if (isObj(schema.properties)) for (const v of Object.values(schema.properties)) max = Math.max(max, 1 + schemaDepth(v, seen + 1));
  if (schema.items) max = Math.max(max, 1 + schemaDepth(schema.items, seen + 1));
  for (const k of ['oneOf', 'anyOf', 'allOf']) if (Array.isArray(schema[k])) for (const s of schema[k] as unknown[]) max = Math.max(max, schemaDepth(s, seen + 1));
  return max;
}

/** Counts leaf fields in a schema (for the `output_shaped` lint rule). */
export function countFields(schema: unknown, budget = { n: 0 }, depth = 0): number {
  if (!isObj(schema) || depth > 10 || budget.n > 1000) return budget.n;
  if (isObj(schema.properties)) {
    for (const v of Object.values(schema.properties)) {
      budget.n++;
      countFields(v, budget, depth + 1);
    }
  }
  if (schema.items) countFields(schema.items, budget, depth + 1);
  return budget.n;
}
