import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import { ENVELOPE_ERROR_CODES } from './types.js';

const addFormats = addFormatsImport as unknown as (ajv: Ajv2020) => Ajv2020;

type Schema = Record<string, unknown>;

const CALL: Schema = { type: 'object', properties: { tool: { type: 'string', minLength: 1 }, args: { type: 'object' } }, required: ['tool', 'args'], additionalProperties: false };
const nullable = (s: Schema): Schema => ({ anyOf: [{ type: 'null' }, s] });

/**
 * The full envelope schema (`envelope.schema.json`, contract-v2 §2): what every contract-2 `structuredContent`
 * must satisfy, budgets aside. Used by the renderer (self-check) and the tests; not advertised (too large to
 * repeat per tool; `ADVERTISED_ENVELOPE_SCHEMA` is).
 */
export const ENVELOPE_SCHEMA: Schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://neurouter.dev/schemas/envelope-v2.json',
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    data: {},
    page: nullable({
      type: 'object',
      properties: { count: { type: 'integer', minimum: 0 }, total: { type: ['integer', 'null'], minimum: 0 }, has_more: { type: 'boolean' }, next_cursor: { type: ['string', 'null'] }, scope: { type: 'object' } },
      required: ['count', 'total', 'has_more', 'next_cursor'],
      additionalProperties: false,
    }),
    truncated: nullable({
      type: 'object',
      properties: { items_omitted: { type: 'integer', minimum: 0 }, fields: { type: 'array', items: { type: 'string' } }, omitted_bytes: { type: 'integer', minimum: 0 }, next: CALL },
      required: ['omitted_bytes', 'next'],
      additionalProperties: false,
    }),
    error: nullable({
      type: 'object',
      properties: {
        code: { enum: [...ENVELOPE_ERROR_CODES] },
        message: { type: 'string', minLength: 1, maxLength: 200 },
        fields: {
          type: 'array',
          items: { type: 'object', properties: { field: { type: 'string' }, received: {}, allowed: { anyOf: [{ type: 'array' }, { type: 'string' }] }, problem: { type: 'string' } }, required: ['field', 'problem'], additionalProperties: false },
        },
        retry: { enum: ['no', 'after_fix', 'after_wait', 'yes'] },
        retry_after_ms: { type: 'integer', minimum: 0 },
        next: { type: 'array', items: CALL },
        closest: { type: 'array', items: { type: 'string' }, maxItems: 5 },
        upstream: { type: 'object', properties: { status: { type: 'integer' }, detail: { type: 'string', maxLength: 300 } }, required: ['status', 'detail'], additionalProperties: false },
        error_id: { type: 'string' },
        line: { type: 'integer' },
      },
      required: ['code', 'message', 'retry', 'next'],
      additionalProperties: false,
    }),
    state: {
      type: 'object',
      properties: {
        env: { type: 'string' },
        writes: { enum: ['off', 'on', 'confirm'] },
        task: { type: 'string', pattern: '^t_[0-9A-Za-z]{4,8}$' },
        call: { type: 'integer', minimum: 1 },
        streak: { type: 'integer', minimum: 2 },
        left: { type: 'object', properties: { calls: { type: 'integer' }, seconds: { type: 'number' } }, additionalProperties: false },
        wrote: { type: 'string' },
        script_calls: { type: 'integer', minimum: 0 },
        flags: { type: 'array', items: { enum: ['instruction_like_text', 'prod', 'dry_run', 'schema_mismatch'] } },
        flag_paths: { type: 'array', items: { type: 'string' }, maxItems: 3 },
      },
      required: ['task', 'call'],
      additionalProperties: false,
    },
    hint: { type: 'string', maxLength: 200 },
    logs: { type: 'string', maxLength: 2000 },
  },
  required: ['ok', 'data', 'page', 'truncated', 'error', 'state'],
  additionalProperties: false,
  // error iff !ok
  if: { properties: { ok: { const: true } } },
  then: { properties: { error: { type: 'null' } } },
  else: { properties: { error: { type: 'object' } } },
};

/** The `outputSchema` advertised in tools/list (`exposure.outputSchema: envelope`): the envelope's keys with an open `data` (~0.3 KB). */
export const ADVERTISED_ENVELOPE_SCHEMA: Schema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    data: {},
    page: { type: ['object', 'null'] },
    truncated: { type: ['object', 'null'] },
    error: { type: ['object', 'null'] },
    state: { type: 'object' },
    hint: { type: 'string' },
  },
  required: ['ok', 'data', 'page', 'truncated', 'error', 'state'],
};

/**
 * `exposure.outputSchema: typed`: the envelope with `data` = the tool's shaped success schema (its `$defs`
 * hoisted to the root so `#/$defs/…` references resolve). `data` is checked only on success and unless the
 * server flagged `state.flags: ["schema_mismatch"]` (a response the server found not to match is sent
 * unvalidated rather than rejected by the client: contract-v2 §2.5 "A response MUST NEVER fail client-side
 * validation").
 */
export function typedEnvelopeSchema(output: Schema): Schema {
  const { $defs, $schema: _s, $id: _i, ...data } = output;
  return {
    ...ADVERTISED_ENVELOPE_SCHEMA,
    ...($defs && typeof $defs === 'object' ? { $defs } : {}),
    if: { properties: { ok: { const: true }, state: { properties: { flags: { not: { contains: { const: 'schema_mismatch' } } } } } }, required: ['ok'] },
    then: { properties: { data } },
  };
}

let ajv: Ajv2020 | null = null;
function compiler(): Ajv2020 {
  if (!ajv) {
    ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, allowUnionTypes: true });
    addFormats(ajv);
  }
  return ajv;
}

let envelopeValidator: ValidateFunction | null = null;

/** Validates a value against the full envelope schema; returns the first errors (empty = valid). */
export function envelopeErrors(v: unknown): string[] {
  envelopeValidator ??= compiler().compile(ENVELOPE_SCHEMA);
  if (envelopeValidator(v)) return [];
  return (envelopeValidator.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
}

const typedCache = new Map<string, ValidateFunction | Error>();

/** Validates an envelope against a tool's typed envelope schema (compiled once per definition hash). */
export function typedErrors(key: string, output: Schema, v: unknown): string[] {
  let fn = typedCache.get(key);
  if (!fn) {
    try {
      fn = compiler().compile(typedEnvelopeSchema(output));
    } catch (err) {
      fn = new Error(`output schema cannot be compiled: ${(err as Error).message.slice(0, 200)}`);
    }
    if (typedCache.size > 2000) typedCache.clear();
    typedCache.set(key, fn);
  }
  if (fn instanceof Error) return [fn.message];
  if (fn(v)) return [];
  return (fn.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '(root)'} ${e.message ?? 'is invalid'}`);
}
