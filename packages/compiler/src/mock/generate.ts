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

function stringFor(name: string, schema: JsonSchema, ctx: GenCtx): string {
  const f = ctx.faker;
  const n = name.toLowerCase();
  switch (schema.format) {
    case 'date-time':
      return f.date.recent({ days: 120, refDate: MOCK_REF_DATE }).toISOString();
    case 'date':
      return f.date.recent({ days: 120, refDate: MOCK_REF_DATE }).toISOString().slice(0, 10);
    case 'email':
      return f.internet.email().toLowerCase();
    case 'uri':
    case 'url':
      return f.internet.url();
    case 'uuid':
      return f.string.uuid();
    case 'ipv4':
      return f.internet.ipv4();
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
  if (typeof schema.pattern === 'string' || schema.minLength !== undefined || schema.maxLength !== undefined) {
    const min = Number(schema.minLength ?? 1);
    const max = Math.max(min, Number(schema.maxLength ?? 12));
    // cap long strings at 24 characters, but never below minLength (faker throws when max < min)
    return f.string.alphanumeric({ length: { min, max: Math.max(min, Math.min(max, 24)) } });
  }
  return f.lorem.word();
}

/** Generates a value for the schema. `name` is the property name (drives heuristics). */
export function generateValue(schema: unknown, name: string, ctx: GenCtx): unknown {
  const f = ctx.faker;
  if (!isObj(schema)) return null;
  if (typeof schema.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const target = m ? ctx.defs[m[1]!] : undefined;
    if (!isObj(target) || ctx.depth > 4) return null;
    return generateValue(target, name, { ...ctx, depth: ctx.depth + 1 });
  }
  if (schema.const !== undefined) return schema.const;
  const intRef = isRefName(name) && (schema.type === 'integer' || (Array.isArray(schema.type) && schema.type.includes('integer')));
  if (Array.isArray(schema.examples) && schema.examples.length && ctx.index <= 1 && !['id', 'number'].includes(name) && !intRef) return schema.examples[0];
  if (Array.isArray(schema.enum) && schema.enum.length) return f.helpers.arrayElement(schema.enum as unknown[]);
  for (const k of ['oneOf', 'anyOf'] as const) if (Array.isArray(schema[k]) && schema[k].length) return generateValue((schema[k] as unknown[])[0], name, ctx);
  if (Array.isArray(schema.allOf) && schema.allOf.length) return generateValue(schema.allOf[0], name, ctx);
  let type = schema.type;
  if (Array.isArray(type)) type = (type as string[]).find((t) => t !== 'null') ?? 'null';
  if (!type) type = schema.properties ? 'object' : schema.items ? 'array' : 'string';
  switch (type) {
    case 'string':
      return stringFor(name, schema, ctx);
    case 'integer': {
      const n = name.toLowerCase();
      if (intRef) return f.number.int({ min: 1, max: SEED_ITEMS });
      if (n === 'id' || n === 'number') return ctx.index * 1000 + f.number.int({ min: 1, max: 999 });
      const min = Number(schema.minimum ?? 0);
      const max = Number(schema.maximum ?? Math.max(min + 100, 100));
      return f.number.int({ min, max });
    }
    case 'number': {
      const min = Number(schema.minimum ?? 0);
      const max = Number(schema.maximum ?? Math.max(min + 1000, 1000));
      return Math.round(f.number.float({ min, max }) * 100) / 100;
    }
    case 'boolean':
      return f.datatype.boolean();
    case 'null':
      return null;
    case 'array': {
      if (ctx.depth > 4) return [];
      const count = Math.min(Number(schema.maxItems ?? 3), Math.max(Number(schema.minItems ?? 1), f.number.int({ min: 1, max: 3 })));
      return Array.from({ length: count }, () => generateValue(schema.items, singularName(name), { ...ctx, depth: ctx.depth + 1 }));
    }
    case 'object': {
      if (ctx.depth > 4 || !isObj(schema.properties)) return {};
      const out: Obj = {};
      const required = new Set((schema.required as string[] | undefined) ?? []);
      for (const [k, v] of Object.entries(schema.properties)) {
        // keep objects compact below the top level: required + a few optional fields
        if (ctx.depth >= 2 && !required.has(k) && Object.keys(out).length >= 6) continue;
        out[k] = generateValue(v, k, { ...ctx, depth: ctx.depth + 1 });
      }
      return out;
    }
  }
  return null;
}

function singularName(n: string): string {
  return n.endsWith('s') ? n.slice(0, -1) : n;
}
