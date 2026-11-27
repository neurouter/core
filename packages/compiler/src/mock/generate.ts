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

/**
 * Mock data versions. 1: the 0.2.1 heuristics (lorem names and titles, 0..100 amounts, random
 * timestamps), kept byte-for-byte so suites frozen on 0.2.1 (whose prompts name generated values)
 * still find them. 2 (default, 0.2.2): realistic values by field semantics (person and repository
 * names, labels, product names, ISO currencies, minor-unit amounts, English titles and descriptions)
 * and timestamps that decrease with the item index, so insertion order is newest first.
 */
export type MockDataVersion = 1 | 2;
export const MOCK_DATA_VERSION: MockDataVersion = 2;

/**
 * The data version of a mock namespace: `dv1` as a `:`-separated segment of its name
 * (`eval:<run>:dv1:<attempt>`, `gen:<key>:dv1:ref-…`) selects version 1; anything else is the current version.
 */
export function mockDataVersionOf(namespace: string): MockDataVersion {
  return /(^|[:/])dv1(:|$)/.test(namespace) ? 1 : MOCK_DATA_VERSION;
}

/** A namespace name carrying a data version (`dv1` segment after the prefix's first two segments). */
export function withMockDataVersion(name: string, dv: MockDataVersion): string {
  if (dv === MOCK_DATA_VERSION || mockDataVersionOf(name) === dv) return name;
  const parts = name.split(':');
  return parts.length >= 3 ? [...parts.slice(0, 2), `dv${dv}`, ...parts.slice(2)].join(':') : `${name}:dv${dv}`;
}

/**
 * Mock scale (long-workflow evals): how many items a scaled namespace seeds per collection. `items` is the
 * default for every collection (default `SEED_ITEMS`); `resources` overrides it per resource name (`issue`,
 * `refund`; `-` and `.` read as `_`), as an exact count or a `[min, max]` range drawn per collection
 * (deterministic per seed and scope), so nested collections can vary in size (some pull requests without
 * reviews). A scaled namespace also seeds each scope of a nested collection separately (the issues of two
 * repositories differ) and caps page sizes at 100, as the real APIs do.
 */
export interface MockScale {
  items?: number;
  resources?: Record<string, number | [number, number]>;
}

/** Largest count a scale may ask for (the store's collection limit). */
export const MOCK_SCALE_MAX = 1000;
/** Page-size cap of a scaled namespace (GitHub `per_page`, Stripe `limit`: 100). */
export const MOCK_SCALE_PAGE_MAX = 100;

const SCALE_SEG_RE = /(^|[:/])ms(\d+)((?:-[A-Za-z0-9_]+-\d+(?:to\d+)?)*)(?=:|$)/;
const scaleName = (n: string) => n.replace(/[^A-Za-z0-9_]/g, '_').toLowerCase();
const clampCount = (n: number) => Math.max(0, Math.min(MOCK_SCALE_MAX, Math.floor(n)));

/** Validates and normalizes a scale (`null` when it asks for nothing). Throws on malformed input. */
export function normalizeMockScale(input: unknown): MockScale | null {
  if (input === undefined || input === null) return null;
  if (typeof input === 'number') input = { items: input };
  if (!isObj(input)) throw new Error('mockScale must be a number or {items, resources}');
  const out: MockScale = {};
  const count = (v: unknown, what: string) => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MOCK_SCALE_MAX) throw new Error(`mockScale ${what} must be an integer 0..${MOCK_SCALE_MAX}`);
    return v;
  };
  if (input.items !== undefined) out.items = count(input.items, 'items');
  if (input.resources !== undefined) {
    if (!isObj(input.resources)) throw new Error('mockScale.resources must be an object');
    const res: Record<string, number | [number, number]> = {};
    for (const [k, v] of Object.entries(input.resources)) {
      if (Array.isArray(v)) {
        const [lo, hi] = [count(v[0], `resources.${k}[0]`), count(v[1], `resources.${k}[1]`)];
        if (v.length !== 2 || lo > hi) throw new Error(`mockScale resources.${k} must be [min, max]`);
        res[scaleName(k)] = lo === hi ? lo : [lo, hi];
      } else res[scaleName(k)] = count(v, `resources.${k}`);
    }
    if (Object.keys(res).length) out.resources = res;
  }
  return out.items === undefined && !out.resources ? null : out;
}

/** The namespace segment of a scale: `ms200`, `ms20-issue-150-review-0to2`. */
export function mockScaleSegment(scale: MockScale): string {
  const res = Object.entries(scale.resources ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `-${k}-${Array.isArray(v) ? `${v[0]}to${v[1]}` : v}`);
  return `ms${scale.items ?? SEED_ITEMS}${res.join('')}`;
}

/** The scale a namespace name carries (`ms…` segment), or `null` (the default: `SEED_ITEMS` per collection). */
export function mockScaleOf(namespace: string): MockScale | null {
  const m = SCALE_SEG_RE.exec(namespace);
  if (!m) return null;
  const resources: Record<string, number | [number, number]> = {};
  const parts = (m[3] ?? '').split('-').slice(1);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const r = /^(\d+)(?:to(\d+))?$/.exec(parts[i + 1]!)!;
    resources[parts[i]!] = r[2] !== undefined ? [clampCount(Number(r[1])), clampCount(Number(r[2]))] : clampCount(Number(r[1]));
  }
  return { items: clampCount(Number(m[2])), ...(Object.keys(resources).length ? { resources } : {}) };
}

/** A namespace name carrying a scale (`ms…` segment after the prefix's first two segments, like the data version). */
export function withMockScale(name: string, scale: MockScale | null | undefined): string {
  if (!scale) return name;
  const seg = mockScaleSegment(scale);
  const parts = name.split(':');
  return parts.length >= 3 ? [...parts.slice(0, 2), seg, ...parts.slice(2)].join(':') : `${name}:${seg}`;
}

/** Items a collection of `resource` seeds under `scale` (`seed`: the collection's seed, picks a count within a range). */
export function scaledCount(scale: MockScale | null | undefined, resourceName: string, seed: number): number {
  if (!scale) return SEED_ITEMS;
  const v = scale.resources?.[scaleName(resourceName)];
  if (Array.isArray(v)) return v[0] + (hashSeed(seed, 'count') % (v[1] - v[0] + 1));
  return v ?? scale.items ?? SEED_ITEMS;
}

export interface GenCtx {
  faker: Faker;
  defs: Obj;
  depth: number;
  /** sequential index of the item being generated (1-based) */
  index: number;
  /** data version (default MOCK_DATA_VERSION) */
  dv?: MockDataVersion;
  /** the resource the item belongs to (`repo`, `customer`, …): drives name heuristics in version 2 */
  resource?: string;
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

const sentence = (p: string) => (/[.!?]$/.test(p) ? p : `${p}.`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const PERSON_RES = /^(user|customer|owner|member|person|contact|employee|author|collaborator|cardholder|individual|assignee|reviewer|maintainer|admin|subscriber|recipient|beneficiary|person_)/;
const SLUG_RES = /^(repo|repository|project|package|app|codespace|environment|branch|workflow|bucket|service|topic|deployment|runner|artifact|cache|pipeline|module|site|domain|plugin|extension)/;
const ORG_RES = /^(org|organization|team|company|business|enterprise|account|merchant|vendor|supplier)/;
const PRODUCT_RES = /^(product|plan|price|coupon|item|sku|promotion|discount|subscription|offer|tier)/;
const LABELS = ['bug', 'enhancement', 'documentation', 'question', 'good first issue', 'help wanted', 'wontfix', 'duplicate', 'security', 'performance', 'dependencies', 'needs triage'];
const CURRENCIES = ['usd', 'eur', 'gbp', 'usd', 'cad', 'aud', 'jpy', 'chf', 'sek', 'usd'];

/** Version-2 string heuristics by field semantics; null = no opinion (fall through to version 1). */
function realisticString(name: string, schema: JsonSchema, ctx: GenCtx): string | null {
  const f = ctx.faker;
  // camelCase as snake_case (`postalCode` → `postal_code`)
  const n = name.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const res = (ctx.resource ?? '').toLowerCase();
  if (n === 'currency' || n.endsWith('_currency') || schema.format === 'currency') {
    const c = f.helpers.arrayElement(CURRENCIES);
    return typeof schema.pattern === 'string' && /A-Z/.test(schema.pattern) ? c.toUpperCase() : c;
  }
  if (n === 'login' || n === 'username' || n === 'handle' || n.endsWith('_login') || n.endsWith('_username'))
    return f.internet.username({ firstName: f.person.firstName(), lastName: f.person.lastName() }).toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (n === 'full_name' && SLUG_RES.test(res)) return `${f.internet.domainWord()}/${f.word.adjective()}-${f.word.noun()}`.toLowerCase();
  if (n === 'name' || n === 'display_name' || n === 'full_name' || n === 'nickname' || (n === 'title' && PERSON_RES.test(res))) {
    if (n === 'full_name' || PERSON_RES.test(res)) return f.person.fullName();
    if (res === 'label' || res.endsWith('_label')) return f.helpers.arrayElement(LABELS);
    if (SLUG_RES.test(res)) return `${f.word.adjective()}-${f.word.noun()}`.toLowerCase();
    if (PRODUCT_RES.test(res)) return f.commerce.productName();
    if (ORG_RES.test(res)) return f.company.name();
    if (/secret|variable|key$|token|credential/.test(res)) return `${f.word.noun()}_${f.word.noun()}`.toUpperCase().replace(/[^A-Z_]/g, '');
    if (/template|gitignore|license|language/.test(res)) return cap(f.helpers.arrayElement(['node', 'python', 'go', 'java', 'ruby', 'rust', 'swift', 'kotlin', 'haskell', 'elixir']));
    return `${cap(f.word.adjective())} ${f.word.noun()}`;
  }
  if (n === 'title' || n === 'subject' || n === 'summary' || n === 'headline') return `${cap(f.hacker.verb())} the ${f.hacker.adjective()} ${f.hacker.noun()}`;
  if (n === 'description' || n === 'body' || n === 'text' || n === 'message' || n === 'content' || n === 'comment' || n === 'notes' || n === 'bio')
    return `${sentence(f.hacker.phrase())}${f.datatype.boolean() ? ` ${sentence(f.hacker.phrase())}` : ''}`;
  if (n.endsWith('url') || n.endsWith('_uri') || n === 'href' || n === 'website' || n === 'homepage') return `https://www.${f.internet.domainWord()}.com/${f.word.noun()}`;
  if (n === 'country' || n.endsWith('_country')) return f.location.countryCode();
  if (n === 'city') return f.location.city();
  if (n === 'postal_code' || n === 'zip' || n === 'zip_code' || n === 'postcode') return f.location.zipCode();
  if (n === 'line1' || n === 'address_line1' || n === 'street' || n === 'address') return f.location.streetAddress();
  if (n === 'line2' || n === 'address_line2') return `Suite ${f.number.int({ min: 100, max: 999 })}`;
  if (n === 'state' && /address/.test(res)) return f.location.state({ abbreviated: true });
  if (n === 'sku') return `SKU-${f.string.alphanumeric({ length: 6, casing: 'upper' })}`;
  if (n === 'note' || n === 'notes' || n === 'memo' || n === 'statement_descriptor') return sentence(f.hacker.phrase());
  if (n === 'company') return f.company.name();
  return null;
}

function heuristicString(name: string, schema: JsonSchema, ctx: GenCtx): string {
  const f = ctx.faker;
  const n = name.toLowerCase();
  if ((ctx.dv ?? MOCK_DATA_VERSION) !== 1) {
    if (/(^|_)(created|updated|closed|merged|pushed|due|started|ended)_?(at|on|date)$/.test(n) || /At$/.test(name)) return recentByIndex(ctx).toISOString();
    const v = realisticString(name, schema, ctx);
    if (v !== null) return v;
  }
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
  // version 2: an English word, not lorem ipsum
  return (ctx.dv ?? MOCK_DATA_VERSION) !== 1 ? f.word.noun() : f.lorem.word();
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
  const v2 = (ctx.dv ?? MOCK_DATA_VERSION) !== 1;
  const candidates: Array<() => string | null> = [
    () => (v2 && (schema.format === 'date-time' || schema.format === 'date') ? (schema.format === 'date' ? recentByIndex(ctx).toISOString().slice(0, 10) : recentByIndex(ctx).toISOString()) : null),
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

/** Version 2: timestamps that decrease with the item index (item 1 is the newest), within the last ~120 days. */
function recentByIndex(ctx: GenCtx): Date {
  const hours = ctx.index * 6 + ctx.faker.number.int({ min: 0, max: 5 });
  return new Date(MOCK_REF_DATE.getTime() - hours * 3_600_000 - ctx.faker.number.int({ min: 0, max: 3_599_999 }));
}

const MONEY_RE = /(^|_)(amount|price|total|subtotal|balance|fee|cost|unit_amount|amount_due|amount_paid|amount_remaining|tax)(_|$)/;
const EPOCH_RE = /^(created|updated|expires_at|arrival_date|available_on|date|period_start|period_end|canceled_at|ended_at|start_date|due_date|paid_at|finalized_at)$/;

function numberFor(name: string, schema: JsonSchema, ctx: GenCtx, integer: boolean): number {
  const f = ctx.faker;
  const n = name.toLowerCase();
  if ((ctx.dv ?? MOCK_DATA_VERSION) !== 1 && !isRefName(name)) {
    // amounts: whole currency units in minor units (5.00 .. 2,000.00), or plain amounts for decimals
    if (MONEY_RE.test(n)) {
      const v = integer ? f.number.int({ min: 10, max: 4000 }) * 50 : Math.round(f.number.float({ min: 5, max: 2000 }) * 100) / 100;
      if (numberFits(schema, v, integer)) return v;
    }
    // unix timestamps (Stripe `created`): newest first, like ISO timestamps
    if (integer && (EPOCH_RE.test(n) || schema.format === 'unix-time')) {
      const v = Math.floor(recentByIndex(ctx).getTime() / 1000);
      if (numberFits(schema, v, true)) return v;
    }
  }
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
      // a nested object is named by its property (`owner` of a repo is a person, not a repo)
      const resource = ctx.depth > 0 && name && name !== 'result' && name !== 'body' ? singularName(name) : ctx.resource;
      for (const [k, v] of Object.entries(schema.properties)) {
        // keep objects compact below the top level: required + a few optional fields
        if (!required.has(k) && (compact || (ctx.depth >= 2 && Object.keys(out).length >= 6))) continue;
        out[k] = ctx.depth > MAX_DEPTH ? minimalValue(isObj(v) ? (v as JsonSchema) : {}, ctx) : generateValue(v, k, { ...ctx, depth: ctx.depth + 1, ...(resource !== undefined ? { resource } : {}) });
      }
      return out;
    }
  }
  return null;
}

function singularName(n: string): string {
  return n.endsWith('s') ? n.slice(0, -1) : n;
}
