/** Seeded fake values from JSON Schemas (backend spec §16 seeding heuristics). */
import { Faker, base, en } from '@faker-js/faker';
import type { JsonSchema } from '@neurouter/shared';
import { isObj, type Obj } from '../util.js';

export const MOCK_REF_DATE = new Date('2026-01-15T12:00:00.000Z');
/** Items seeded per collection, with integer ids 1..SEED_ITEMS. */
export const SEED_ITEMS = 20;

/**
 * A reference to another entity (`petId`, `owner_id`), not the item's own `id`. Integer references
 * point at a seeded id (1..SEED_ITEMS) and ignore spec examples, so following one resolves: the
 * petstore example `Order.petId: 198772` made every agent that looked up order 1's pet get a 404.
 */
function isRefName(name: string): boolean {
  return name !== 'id' && (/[a-z0-9]Id$/.test(name) || /_id$/i.test(name));
}

export function seededFaker(seed: number): Faker {
  const f = new Faker({ locale: [en, base] });
  f.seed(seed);
  return f;
}

/** 32-bit FNV-1a, for deriving seeds from strings. */
export function hashSeed(...parts: Array<string | number>): number {
  let h = 0x811c9dc5;
  for (const ch of parts.join('|')) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

export interface GenCtx {
  faker: Faker;
  defs: Obj;
  depth: number;
  /** sequential index of the item being generated (1-based) */
  index: number;
}

/** Below this depth objects are generated compactly (required fields only, empty optional lists). */
const COMPACT_DEPTH = 4;
/** Hard stop for recursive schemas (only required fields are followed past COMPACT_DEPTH). */
const MAX_DEPTH = 12;

/* ------------------------------------------------------------------ format checks (ajv-formats "full" equivalents) */

const DATE_RE = /^(\d\d\d\d)-(\d\d)-(\d\d)$/;
const TIME_RE = /^(\d\d):(\d\d):(\d\d(?:\.\d+)?)(z|[+-]\d\d(?::?\d\d)?)?$/i;
const FORMAT_CHECKS: Record<string, (v: string) => boolean> = {
  date: (v) => validDate(v),
  time: (v) => TIME_RE.test(v),
  'date-time': (v) => {
    const parts = v.split(/t|\s/i);
    return parts.length === 2 && validDate(parts[0]!) && TIME_RE.test(parts[1]!) && /(z|[+-]\d\d(?::?\d\d)?)$/i.test(parts[1]!);
  },
  duration: (v) => /^P(?!$)((\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+S)?)?|(\d+W)?)$/.test(v),
  uri: (v) => /^[a-z][a-z0-9+.-]*:[^\s"<>\\^`{|}]*$/i.test(v),
  url: (v) => /^(?:https?|ftp):\/\/[^\s/$.?#].[^\s]*$/i.test(v),
  'uri-reference': (v) => !/[\s"<>\\^`{|}]/.test(v),
  iri: (v) => /^[a-z][a-z0-9+.-]*:\S*$/i.test(v),
  email: (v) => /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(v),
  hostname: (v) => /^(?=.{1,253}\.?$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[-0-9a-z]{0,61}[0-9a-z])?)*\.?$/i.test(v),
  ipv4: (v) => /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/.test(v),
  ipv6: (v) => /^[0-9a-f:]+$/i.test(v) && v.includes(':'),
  uuid: (v) => /^(?:urn:uuid:)?[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(v),
  byte: (v) => /^(?:[a-z0-9+/]{4})*(?:[a-z0-9+/]{2}==|[a-z0-9+/]{3}=)?$/i.test(v),
  regex: (v) => {
    try {
      new RegExp(v, 'u');
      return true;
    } catch {
      return false;
    }
  },
};

function validDate(v: string): boolean {
  const m = DATE_RE.exec(v);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= days[mo - 1]!;
}

function patternOf(schema: JsonSchema): RegExp | null {
  if (typeof schema.pattern !== 'string') return null;
  try {
    return new RegExp(schema.pattern, 'u');
  } catch {
    return null;
  }
}

/** Whether a string satisfies the schema's format, length and pattern. */
export function stringFits(schema: JsonSchema, v: string): boolean {
  const len = [...v].length;
  if (typeof schema.minLength === 'number' && len < schema.minLength) return false;
  if (typeof schema.maxLength === 'number' && len > schema.maxLength) return false;
  const check = typeof schema.format === 'string' ? FORMAT_CHECKS[schema.format] : undefined;
  if (check && !check(v)) return false;
  const re = patternOf(schema);
  return !re || re.test(v);
}

function numberFits(schema: JsonSchema, v: number, integer: boolean): boolean {
  if (!Number.isFinite(v) || (integer && !Number.isInteger(v))) return false;
  if (typeof schema.minimum === 'number' && v < schema.minimum) return false;
  if (typeof schema.maximum === 'number' && v > schema.maximum) return false;
  if (typeof schema.exclusiveMinimum === 'number' && v <= schema.exclusiveMinimum) return false;
  if (typeof schema.exclusiveMaximum === 'number' && v >= schema.exclusiveMaximum) return false;
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0 && Math.abs(v / schema.multipleOf - Math.round(v / schema.multipleOf)) > 1e-9) return false;
  return true;
}

function typesOf(schema: JsonSchema): string[] {
  if (Array.isArray(schema.type)) return schema.type as string[];
  return typeof schema.type === 'string' ? [schema.type] : [];
}

/**
 * Whether a spec example can be used as a mock value: it must satisfy the schema's own type, enum
 * and format constraints (GitHub quotes some examples: `"\"2007-10-29T02:42:39.000-07:00\""` is no date-time).
 */
export function exampleFits(schema: JsonSchema, v: unknown): boolean {
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(v))) return false;
  if (schema.const !== undefined && JSON.stringify(schema.const) !== JSON.stringify(v)) return false;
  const types = typesOf(schema);
  const actual = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? (Number.isInteger(v) ? 'integer' : 'number') : typeof v;
  if (types.length && !types.includes(actual) && !(actual === 'integer' && types.includes('number'))) return false;
  if (typeof v === 'string') return stringFits(schema, v);
  if (typeof v === 'number') return numberFits(schema, v, actual === 'integer' && types.includes('integer') && !types.includes('number'));
  // objects/arrays: the generator builds them (an example may lack required fields)
  return actual !== 'object' && actual !== 'array';
}

/* ------------------------------------------------------------------ values */

function formatValue(format: string, f: Faker): string | null {
  const recent = () => f.date.recent({ days: 120, refDate: MOCK_REF_DATE });
  switch (format) {
    case 'date-time':
      return recent().toISOString();
    case 'date':
      return recent().toISOString().slice(0, 10);
    case 'time':
      return recent().toISOString().slice(11, 19) + 'Z';
    case 'duration':
      return `PT${f.number.int({ min: 1, max: 48 })}H`;
    case 'email':
    case 'idn-email':
      return f.internet.email().toLowerCase();
    case 'uri':
    case 'url':
    case 'iri':
    case 'uri-reference':
    case 'iri-reference':
      return f.internet.url();
    case 'uri-template':
      return `${f.internet.url()}{/id}`;
    case 'hostname':
    case 'idn-hostname':
      return f.internet.domainName();
    case 'uuid':
      return f.string.uuid();
    case 'ipv4':
      return f.internet.ipv4();
    case 'ipv6':
      return f.internet.ipv6();
    case 'byte':
      return Buffer.from(f.lorem.words(3)).toString('base64');
    case 'json-pointer':
      return `/${f.lorem.word()}`;
    case 'regex':
      return '^[a-z]+$';
  }
  return null;
}

function heuristicString(name: string, schema: JsonSchema, ctx: GenCtx): string {
  const f = ctx.faker;
  const n = name.toLowerCase();
  if (/(^|_)(created|updated|closed|merged|pushed|due|started|ended)_?(at|on|date)$/.test(n) || /At$/.test(name)) return f.date.recent({ days: 120, refDate: MOCK_REF_DATE }).toISOString();
  if (n === 'email' || n.endsWith('_email')) return f.internet.email().toLowerCase();
  if (n === 'login' || n === 'username' || n.endsWith('_login')) return f.internet.username().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (n.endsWith('url') || n.endsWith('_uri') || n === 'href') return f.internet.url();
  if (n === 'name' || n.endsWith('_name') || n === 'fullname') return n.includes('first') ? f.person.firstName() : n.includes('last') ? f.person.lastName() : f.word.words({ count: { min: 1, max: 3 } });
  if (n === 'title' || n === 'subject' || n === 'summary') return f.lorem.sentence({ min: 3, max: 8 }).replace(/\.$/, '');
  if (n === 'description' || n === 'body' || n === 'text' || n === 'message' || n === 'content' || n === 'comment') return f.lorem.paragraph({ min: 1, max: 2 });
  if (n === 'state' || n === 'status') return f.helpers.arrayElement(['open', 'closed']);
  if (n === 'phone') return f.phone.number();
  if (n === 'color') return f.color.rgb({ prefix: '' });
  if (n === 'sha') return f.git.commitSha();
  if (typeof schema.pattern === 'string' || schema.minLength !== undefined || schema.maxLength !== undefined) return lengthString(schema, ctx);
  return f.lorem.word();
}

/** A string of the schema's length (long strings capped at 24 characters, never below minLength). */
function lengthString(schema: JsonSchema, ctx: GenCtx): string {
  const min = Math.max(0, Number(schema.minLength ?? 1));
  const max = Math.max(min, Number(schema.maxLength ?? 12));
  return ctx.faker.string.alphanumeric({ length: { min, max: Math.max(min, Math.min(max, 24)) } });
}

/**
 * A string that satisfies the schema whenever that is feasible: format first, then the name
 * heuristics, then the pattern (faker's `fromRegExp`), then a plain string of a valid length.
 */
function stringFor(name: string, schema: JsonSchema, ctx: GenCtx): string {
  const f = ctx.faker;
  const candidates: Array<() => string | null> = [
    () => (typeof schema.format === 'string' ? formatValue(schema.format, f) : null),
    () => heuristicString(name, schema, ctx),
    () => (typeof schema.pattern === 'string' && patternOf(schema) ? fromPattern(schema.pattern, ctx) : null),
    () => lengthString(schema, ctx),
  ];
  let last = '';
  for (const c of candidates) {
    const v = c();
    if (v === null) continue;
    if (stringFits(schema, v)) return v;
    // too long: a prefix may still fit (no pattern, or the pattern accepts it)
    if (typeof schema.maxLength === 'number' && [...v].length > schema.maxLength) {
      const cut = [...v].slice(0, schema.maxLength).join('');
      if (stringFits(schema, cut)) return cut;
    }
    last = v;
  }
  return last;
}

function fromPattern(pattern: string, ctx: GenCtx): string | null {
  // faker understands a subset of regex syntax; anchors are implied
  const body = pattern.replace(/^\^/, '').replace(/\$$/, '');
  try {
    return ctx.faker.helpers.fromRegExp(body);
  } catch {
    return null;
  }
}

function numberFor(name: string, schema: JsonSchema, ctx: GenCtx, integer: boolean): number {
  const f = ctx.faker;
  const n = name.toLowerCase();
  const intRef = integer && isRefName(name);
  if (intRef && numberFits(schema, 1, true)) {
    const v = f.number.int({ min: 1, max: SEED_ITEMS });
    if (numberFits(schema, v, true)) return v;
  }
  if (integer && (n === 'id' || n === 'number')) {
    const v = ctx.index * 1000 + f.number.int({ min: 1, max: 999 });
    if (numberFits(schema, v, true)) return v;
  }
  const lo = typeof schema.exclusiveMinimum === 'number' ? schema.exclusiveMinimum + (integer ? 1 : 0.01) : Number(schema.minimum ?? 0);
  let hi = typeof schema.exclusiveMaximum === 'number' ? schema.exclusiveMaximum - (integer ? 1 : 0.01) : Number(schema.maximum ?? Math.max(lo + (integer ? 100 : 1000), integer ? 100 : 1000));
  if (schema.format === 'int32') hi = Math.min(hi, 2_147_483_647);
  const min = Math.min(lo, hi);
  const max = Math.max(lo, hi);
  const step = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : null;
  if (step) {
    const first = Math.ceil(min / step);
    const last = Math.floor(max / step);
    const k = last >= first ? f.number.int({ min: first, max: last }) : first;
    return Number((k * step).toPrecision(12));
  }
  if (integer) return f.number.int({ min: Math.ceil(min), max: Math.max(Math.ceil(min), Math.floor(max)) });
  const v = Math.round(f.number.float({ min, max }) * 100) / 100;
  return numberFits(schema, v, false) ? v : min;
}

/** A branch that is (or only wraps) an omitted-component placeholder. */
function omittedBranch(b: unknown, ctx: GenCtx, depth = 0): boolean {
  if (!isObj(b) || depth > 4) return false;
  if (typeof b['x-neurouter-omitted'] === 'string') return true;
  if (typeof b.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(b.$ref);
    return omittedBranch(m ? ctx.defs[m[1]!] : undefined, ctx, depth + 1);
  }
  for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(b[k]) && (b[k] as unknown[]).length && (b[k] as unknown[]).every((x) => omittedBranch(x, ctx, depth + 1))) return true;
  return false;
}

function minimalValue(raw: JsonSchema, ctx: GenCtx): unknown {
  let schema = raw;
  for (let i = 0; i < 8 && typeof schema.$ref === 'string'; i++) {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m ? ctx.defs[m[1]!] : undefined;
    if (!isObj(target)) return null;
    schema = target as JsonSchema;
  }
  for (const k of ['anyOf', 'oneOf'] as const) {
    const branches = Array.isArray(schema[k]) ? (schema[k] as JsonSchema[]) : [];
    if (branches.some((b) => isObj(b) && b.type === 'null')) return null;
    if (branches.length) return minimalValue(branches[0]!, ctx);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) return minimalValue(schema.allOf[0] as JsonSchema, ctx);
  const types = typesOf(schema);
  if (types.includes('null')) return null;
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  switch (types[0] ?? (schema.properties ? 'object' : schema.items ? 'array' : 'string')) {
    case 'object':
      return {};
    case 'array':
      return [];
    case 'integer':
    case 'number':
      return numberFor('', schema, ctx, types[0] === 'integer');
    case 'boolean':
      return false;
    default:
      return stringFor('', schema, ctx);
  }
}

/** Generates a value for the schema (valid against it where feasible). `name` is the property name (drives heuristics). */
export function generateValue(schema: unknown, name: string, ctx: GenCtx): unknown {
  const f = ctx.faker;
  if (!isObj(schema)) return null;
  if (typeof schema.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m ? ctx.defs[m[1]!] : undefined;
    if (!isObj(target)) return null;
    if (ctx.depth > MAX_DEPTH) return minimalValue(target, ctx);
    return generateValue(target, name, { ...ctx, depth: ctx.depth + 1 });
  }
  if (schema.const !== undefined) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length) return f.helpers.arrayElement(schema.enum as unknown[]);
  const types = typesOf(schema);
  const intRef = isRefName(name) && types.includes('integer');
  if (Array.isArray(schema.examples) && schema.examples.length && ctx.index <= 1 && !['id', 'number'].includes(name) && !intRef && exampleFits(schema, schema.examples[0])) return schema.examples[0];
  for (const k of ['oneOf', 'anyOf'] as const) {
    const branches = Array.isArray(schema[k]) ? (schema[k] as unknown[]) : [];
    if (!branches.length) continue;
    // a non-null branch, so a nullable object still gets its fields; but null rather than a part
    // whose schema was left out of a large output schema (its fields are unknown here)
    const isNull = (b: unknown) => isObj(b) && b.type === 'null';
    const pick = branches.find((b) => !isNull(b) && !omittedBranch(b, ctx)) ?? branches.find(isNull) ?? branches[0];
    return generateValue(pick, name, ctx);
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = (schema.allOf as unknown[]).map((p) => generateValue(p, name, ctx));
    if (parts.every((p) => isObj(p))) return Object.assign({}, ...(parts as Obj[]));
    return parts[0];
  }
  // a component left out of a large output schema: a value of its declared kind
  if (typeof schema['x-neurouter-omitted'] === 'string') {
    const t = schema['x-neurouter-omitted-type'];
    return t === 'object' ? {} : t === 'array' ? [] : t === 'integer' || t === 'number' ? 0 : t === 'boolean' ? false : stringFor(name, {}, ctx);
  }
  let type: string | undefined = types.find((t) => t !== 'null') ?? (types.length ? 'null' : undefined);
  if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'string':
      return stringFor(name, schema, ctx);
    case 'integer':
      return numberFor(name, schema, ctx, true);
    case 'number':
      return numberFor(name, schema, ctx, false);
    case 'boolean':
      return f.datatype.boolean();
    case 'null':
      return null;
    case 'array': {
      const minItems = Math.max(0, Number(schema.minItems ?? 0));
      const maxItems = schema.maxItems !== undefined ? Number(schema.maxItems) : Infinity;
      const count = ctx.depth > COMPACT_DEPTH ? minItems : Math.min(maxItems, Math.max(minItems, f.number.int({ min: 1, max: 3 })));
      if (ctx.depth > MAX_DEPTH && count === 0) return [];
      const out: unknown[] = [];
      const seen = new Set<string>();
      for (let i = 0; out.length < count && i < count * 4; i++) {
        const v = generateValue(schema.items, singularName(name), { ...ctx, depth: ctx.depth + 1 });
        const key = JSON.stringify(v);
        if (schema.uniqueItems === true && seen.has(key)) continue;
        seen.add(key);
        out.push(v);
      }
      return out;
    }
    case 'object': {
      if (!isObj(schema.properties)) return {};
      const out: Obj = {};
      const required = new Set((schema.required as string[] | undefined) ?? []);
      const compact = ctx.depth > COMPACT_DEPTH;
      for (const [k, v] of Object.entries(schema.properties)) {
        // keep objects compact below the top level: required + a few optional fields
        if (!required.has(k) && (compact || (ctx.depth >= 2 && Object.keys(out).length >= 6))) continue;
        out[k] = ctx.depth > MAX_DEPTH ? minimalValue(isObj(v) ? (v as JsonSchema) : {}, ctx) : generateValue(v, k, { ...ctx, depth: ctx.depth + 1 });
      }
      return out;
    }
  }
  return null;
}

function singularName(n: string): string {
  return n.endsWith('s') ? n.slice(0, -1) : n;
}
