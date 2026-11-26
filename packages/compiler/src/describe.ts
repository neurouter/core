/**
 * Contract-2 description standard (contract-v2 §4.5, P5) and checked examples.
 *
 * - `checkExamples`: one copy-ready example per tool (overlay → spec → synthesized from defaults, enums and the
 *   mock's seeded ids), validated against the input schema and executed against a throwaway mock; the response
 *   is shaped and checked against the tool's (shaped) output schema (lint `example_runs`, `envelope_conformance`).
 * - `describeTool`: the description agents see in contract 2: effect first (destructive: "Irreversible."), the
 *   related tools it is confused with, an argument summary, the example, and Pages/Fields and dry-run/confirm lines.
 */
import { Ajv2020, type ValidateFunction } from 'ajv/dist/2020.js';
import type { JsonSchema, ToolDef } from '@neurouter/shared';
import { handleMockRequest } from './mock/handler.js';
import type { MockModel, OpenApiMockModel } from './mock/model.js';
import { defaultScopeValue, MemoryMockStateStore } from './mock/store.js';
import { destructiveVerb, isVerb } from './naming.js';
import { shapeResponse, wrapStructured } from './shape.js';
import { isObj, type Obj } from './util.js';

export interface CheckedExample {
  arguments: Record<string, unknown>;
  source: 'overlay' | 'spec' | 'synthesized';
  /** true: validated and answered 2xx by the mock; false: failed (see `problem`); null: not executable (GraphQL, composite) */
  runs: boolean | null;
  /** the mock's (shaped) answer matches the tool's output schema (null when it did not run or there is no schema) */
  conforms: boolean | null;
  problem?: string;
  /** an overlay/spec example that failed (the description then shows a later candidate): lint reports it */
  curatedProblem?: string;
}

const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: false, allowUnionTypes: true, validateFormats: false });
const compiled = new WeakMap<object, ValidateFunction>();
/** Compiled validators by schema text too: recompiling the same spec (re-imports, tests) reuses them. */
const byText = new Map<string, ValidateFunction>();
function validator(schema: JsonSchema): ValidateFunction | null {
  let v = compiled.get(schema);
  if (v) return v;
  const text = JSON.stringify(schema);
  v = byText.get(text);
  if (!v) {
    try {
      v = ajv.compile(JSON.parse(text) as Obj);
    } catch {
      return null;
    }
    if (byText.size >= 2000) {
      byText.clear();
      ajv.removeSchema();
    }
    byText.set(text, v);
  }
  compiled.set(schema, v);
  return v;
}

/** Problems of example arguments against the tool's input schema (`/limit must be <= 100`), empty when valid. */
export function exampleProblems(t: ToolDef, args: Record<string, unknown>): string[] {
  const v = validator(t.inputSchema);
  if (!v || v(args)) return [];
  return (v.errors ?? []).slice(0, 5).map((e) => `${e.instancePath || '/'} ${e.message ?? 'invalid'}${e.params && 'allowedValues' in e.params ? ` (${(e.params.allowedValues as unknown[]).join(', ')})` : ''}`);
}

function props(t: ToolDef): Record<string, JsonSchema> {
  return isObj(t.inputSchema.properties) ? (t.inputSchema.properties as Record<string, JsonSchema>) : {};
}
function required(t: ToolDef): string[] {
  return Array.isArray(t.inputSchema.required) ? (t.inputSchema.required as string[]) : [];
}

/** A schema's default, first enum value or first example (no invented values). */
function sample(p: JsonSchema | undefined): unknown {
  if (!p) return undefined;
  if (p.default !== undefined) return p.default;
  if (Array.isArray(p.enum) && p.enum.length) return p.enum[0];
  if (Array.isArray(p.examples) && p.examples.length) return p.examples[0];
  if (p.example !== undefined) return p.example;
  return undefined;
}

/** The mock's first seeded id of the resource an argument names (`customerId` / `customer_id` → `customer_1`). */
function idByName(name: string, model: MockModel | null): unknown {
  if (model?.kind !== 'openapi') return undefined;
  const byField = Object.values(model.resources).find((x) => x.idField === name && x.idField !== 'id');
  if (byField) return byField.idType === 'integer' ? 1 : `${byField.name}_1`;
  const m = /^(.+?)_?(?:id|Id|ID)$/.exec(name);
  if (!m) return undefined;
  const want = m[1]!.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase().replace(/[^a-z0-9]/g, '');
  const r = Object.values(model.resources).find((x) => x.name.toLowerCase().replace(/[^a-z0-9]/g, '') === want);
  return r ? (r.idType === 'integer' ? 1 : `${r.name}_1`) : undefined;
}

/** A minimal valid value: required properties of objects, one item for arrays with minItems, else a filler. */
function minimal(name: string, p: JsonSchema | undefined, defs: Obj, model: MockModel | null, depth = 0): unknown {
  if (!p || depth > 4) return undefined;
  if (typeof p.$ref === 'string') {
    const d = /^#\/\$defs\/(.+)$/.exec(p.$ref)?.[1];
    return d && isObj(defs[d]) ? minimal(name, defs[d] as JsonSchema, defs, model, depth + 1) : undefined;
  }
  const v = sample(p) ?? idByName(name, model);
  if (v !== undefined) return v;
  const t = Array.isArray(p.type) ? (p.type as string[]).find((x) => x !== 'null') : p.type;
  if (t === 'object' || (!t && isObj(p.properties))) {
    const out: Obj = {};
    const ps = isObj(p.properties) ? (p.properties as Record<string, JsonSchema>) : {};
    for (const r of Array.isArray(p.required) ? (p.required as string[]) : []) {
      const x = minimal(r, ps[r], defs, model, depth + 1);
      if (x === undefined) return undefined;
      out[r] = x;
    }
    return out;
  }
  if (t === 'array') {
    if (!(typeof p.minItems === 'number' && p.minItems > 0)) return [];
    const x = minimal(name.replace(/s$/, ''), p.items as JsonSchema | undefined, defs, model, depth + 1);
    return x === undefined ? undefined : [x];
  }
  return filler(name, p);
}

/** A plausible value for a required argument with nothing to copy (strings, numbers, booleans only). */
function filler(name: string, p: JsonSchema | undefined): unknown {
  const t = Array.isArray(p?.type) ? (p!.type as string[]).find((x) => x !== 'null') : p?.type;
  if (t === 'integer' || t === 'number') return typeof p?.minimum === 'number' ? p.minimum : 1;
  if (t === 'boolean') return true;
  if (t === 'string' || t === undefined) {
    if (p?.format === 'email' || /email/i.test(name)) return 'ada@example.com';
    if (p?.format === 'date-time') return '2026-01-15T12:00:00Z';
    if (p?.format === 'date') return '2026-01-15';
    if (p?.format === 'uri' || /url$/i.test(name)) return 'https://example.com';
    return /name|title/i.test(name) ? 'Example' : 'example';
  }
  return undefined;
}

/** The mock operation of an HTTP tool. */
function mockOp(t: ToolDef, model: OpenApiMockModel) {
  if (t.binding.type !== 'http') return null;
  const b = t.binding;
  return model.operations.find((o) => o.method === b.method && o.pathTemplate === b.pathTemplate) ?? null;
}

/** The agent-visible argument of a spec argument (overlay renames). */
function agentArg(t: ToolDef, specArg: string): string {
  return Object.entries(t.args?.renamed ?? {}).find(([, orig]) => orig === specArg)?.[0] ?? specArg;
}

/**
 * Required arguments from defaults/enums/examples; path ids and scopes from the mock's seeded data (ids are
 * `<resource>_1` or `1`, the same in every mock namespace); other required strings/numbers get a plain filler.
 */
export function synthesizeExample(t: ToolDef, model: MockModel | null): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  const p = props(t);
  const op = model?.kind === 'openapi' ? mockOp(t, model) : null;
  const resource = op?.resource && model?.kind === 'openapi' ? model.resources[op.resource] : undefined;
  const defs = isObj(t.inputSchema.$defs) ? (t.inputSchema.$defs as Obj) : {};
  for (const r of required(t)) {
    let v = sample(p[r]);
    if (v === undefined && op) {
      const param = t.binding.type === 'http' ? t.binding.params.find((x) => agentArg(t, x.arg) === r && x.in === 'path') : undefined;
      if (param && resource && param.name === op.idParam) v = resource.idType === 'integer' ? 1 : `${resource.name}_1`;
      else if (param && resource && op.scopeParams.includes(param.name)) v = resource.defaultScope[param.name] ?? defaultScopeValue(param.name, resource);
      else if (param && model?.kind === 'openapi' && Object.values(model.resources).some((x) => x.scopeParams.includes(param.name))) {
        // an action endpoint (`PUT …/merge`) under a scoped resource: the scope's default value
        const sr = Object.values(model.resources).find((x) => x.scopeParams.includes(param.name))!;
        v = sr.defaultScope[param.name] ?? defaultScopeValue(param.name, sr);
      } else if (param && model?.kind === 'openapi') {
        // an id of a parent resource (`/orders/{orderId}/refunds`): the resource whose item path ends with it
        const parent = Object.values(model.resources).find((x) => model.operations.some((o) => o.resource === x.key && o.idParam === param.name));
        if (parent) v = parent.idType === 'integer' ? 1 : `${parent.name}_1`;
      }
    }
    // scope values from the mock are strings; an integer parameter (`issue_number`) gets the first seeded number
    const ty = Array.isArray(p[r]?.type) ? (p[r]!.type as string[]).find((x) => x !== 'null') : p[r]?.type;
    if ((ty === 'integer' || ty === 'number') && typeof v === 'string') v = Number.isFinite(Number(v)) ? Number(v) : 1;
    if (v === undefined) v = minimal(r, p[r], defs, model);
    if (v === undefined) return null;
    out[r] = v;
  }
  // a read with nothing required: a small page, so the example is a realistic first call
  if (!t.risk.write && !Object.keys(out).length) {
    const size = ['limit', 'per_page', 'page_size', 'pageSize'].find((k) => p[k] && (p[k]!.type === 'integer' || p[k]!.type === 'number'));
    if (size) out[size] = Math.min(5, typeof p[size]!.maximum === 'number' ? (p[size]!.maximum as number) : 5);
  }
  return out;
}

/** Agent args → spec args (renames reversed, hidden args and defaults added), as the request builder does. */
function specArgs(t: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const a = t.args;
  const withDefaults: Record<string, unknown> = { ...args };
  for (const [k, v] of Object.entries(a?.defaults ?? {})) if (withDefaults[k] === undefined) withDefaults[k] = v;
  if (!a) return withDefaults;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(withDefaults)) out[a.renamed?.[k] ?? k] = v;
  for (const [k, v] of Object.entries(a.hidden ?? {})) if (out[k] === undefined && v !== undefined) out[k] = v;
  return out;
}

const prim = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

/** The mock request of an HTTP tool call (path, query, JSON body). */
function mockRequest(t: ToolDef, args: Record<string, unknown>): { method: string; path: string; query: Record<string, string | string[]>; body?: unknown } | null {
  if (t.binding.type !== 'http') return null;
  const b = t.binding;
  const a = specArgs(t, args);
  let path = b.pathTemplate;
  const query: Record<string, string | string[]> = {};
  const consumed = new Set<string>();
  for (const p of b.params) {
    consumed.add(p.arg);
    const v = a[p.arg];
    if (v === undefined || v === null) continue;
    if (p.in === 'path') path = path.split(`{${p.name}}`).join(encodeURIComponent(prim(v)));
    else if (p.in === 'query') query[p.name] = Array.isArray(v) ? v.map(prim) : prim(v);
  }
  let body: unknown;
  if (b.body?.spread) {
    const obj: Obj = {};
    for (const [k, v] of Object.entries(a)) if (!consumed.has(k) && (!b.body.properties || b.body.properties.includes(k)) && v !== undefined) obj[k] = v;
    body = obj;
  } else if (b.body?.arg) body = a[b.body.arg];
  return { method: b.method, path, query, ...(body !== undefined ? { body } : {}) };
}

/** Runs one example against a throwaway mock store; returns the status and the (shaped) body. */
async function runOnMock(t: ToolDef, args: Record<string, unknown>, model: OpenApiMockModel, store: MemoryMockStateStore): Promise<{ status: number; body: unknown }> {
  const req = mockRequest(t, args);
  if (!req) return { status: 0, body: null };
  const res = await handleMockRequest(model, store, 'lint', { method: req.method, path: req.path, query: req.query, body: req.body, headers: { 'x-neurouter-mock-paging': 'tokens' } });
  return { status: res.status, body: res.body };
}

/**
 * Checks one example per visible tool: the first overlay/spec example that validates and runs, else a synthesized
 * one. Writes run too (on a throwaway in-memory mock world, never on the environment's mock).
 */
export async function checkExamples(tools: ToolDef[], model: MockModel | null): Promise<Map<string, CheckedExample>> {
  const out = new Map<string, CheckedExample>();
  const store = new MemoryMockStateStore();
  const openapi = model?.kind === 'openapi' ? model : null;
  for (const t of tools) {
    if (t.hidden) continue;
    const candidates: Array<{ arguments: Record<string, unknown>; source: CheckedExample['source'] }> = t.examples.filter((e) => isObj(e.arguments)).map((e) => ({ arguments: e.arguments, source: e.source === 'spec' ? 'spec' : 'overlay' }));
    const synth = synthesizeExample(t, model);
    if (synth && !candidates.some((c) => JSON.stringify(c.arguments) === JSON.stringify(synth))) candidates.push({ arguments: synth, source: 'synthesized' });
    let first: CheckedExample | null = null;
    let curatedProblem: string | undefined;
    for (const c of candidates) {
      const problems = exampleProblems(t, c.arguments);
      let ex: CheckedExample;
      if (problems.length) ex = { ...c, runs: false, conforms: null, problem: `does not match the input schema: ${problems.join('; ')}` };
      else if (t.kind === 'composite' || t.binding.type !== 'http' || !openapi) ex = { ...c, runs: null, conforms: null };
      else {
        const r = await runOnMock(t, c.arguments, openapi, store);
        if (r.status < 200 || r.status >= 300) {
          const detail = isObj(r.body) && typeof r.body.detail === 'string' ? `: ${r.body.detail.slice(0, 120)}` : '';
          ex = { ...c, runs: false, conforms: null, problem: `the mock answered ${r.status}${detail}` };
        } else {
          const value = shapeResponse(r.body ?? null, t.shaping, { limits: false }).value;
          // a list's schema is the wrapped form clients see as structuredContent ({items: [...]})
          const shaped = isObj(t.outputSchema) && typeof t.outputSchema['x-neurouter-wrapped'] === 'string' ? wrapStructured(value) : value;
          const v = t.outputSchema ? validator(t.outputSchema) : null;
          const conforms = v ? v(shaped) : null;
          ex = { ...c, runs: true, conforms, ...(conforms === false ? { problem: `the response does not match the output schema: ${(v!.errors ?? []).slice(0, 2).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')}` } : {}) };
        }
      }
      first ??= ex;
      if (ex.runs !== false) {
        out.set(t.name, curatedProblem ? { ...ex, curatedProblem } : ex);
        break;
      }
      if (c.source !== 'synthesized' && !curatedProblem) curatedProblem = `${JSON.stringify(c.arguments).slice(0, 120)} fails: ${ex.problem ?? 'error'}`;
    }
    if (!out.has(t.name) && first) out.set(t.name, first);
  }
  return out;
}

// ---------------------------------------------------------------- descriptions

/** The first sentences of a description's first paragraph, up to `max` chars (at least the first sentence). */
export function leadSentences(text: string, max = 200): string {
  const paras = text.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  // a compiled description starts with the operation summary ("Get an order"), then the spec's description: the
  // summary is a title, the effect is in the next paragraph
  const titleLike = (p: string) => p.length < 60 && !/[.!?]$/.test(p);
  const para = paras.length > 1 && titleLike(paras[0]!) ? paras[1]! : (paras[0] ?? '');
  // a sentence ends at . ! ? followed by space and a capital (not inside `[...]`, `e.g. x`, `v1.2`)
  const sentences = para.split(/(?<=[.!?])\s+(?=[A-Z`"(])/).map((s) => s.trim()).filter(Boolean);
  let out = sentences[0] ?? '';
  for (const s of sentences.slice(1)) {
    if (out.length + 1 + s.length > max) break;
    out = `${out} ${s}`;
  }
  return out.length <= 300 ? out : `${out.slice(0, 299)}…`;
}

function noun(t: ToolDef): string {
  if (t.binding.type === 'http') {
    const parts = t.binding.pathTemplate.split('/').filter(Boolean);
    let i = -1;
    for (let k = parts.length - 1; k >= 0; k--) if (parts[k]!.startsWith('{')) {
      i = k;
      break;
    }
    // `/orders/{id}/refunds` is about refunds; `/orders/{id}/cancel` (a verb) about the order
    const tail = parts[parts.length - 1] ?? '';
    const action = isVerb(tail.replace(/[^A-Za-z]/g, '')) && !/s$/.test(tail);
    const n = i >= 0 && i < parts.length - 1 && !action ? tail : i > 0 ? parts[i - 1]! : ([...parts].reverse().find((s) => !s.startsWith('{')) ?? t.name);
    const w = n.replace(/[-_]/g, ' ');
    return /ies$/.test(w) ? `${w.slice(0, -3)}y` : /(ss|us)$/.test(w) ? w : w.replace(/s$/, '');
  }
  return t.name.split('_').pop() ?? t.name;
}

/** What a sibling tool is for, in a few words (`get_order` → "one order by id"). */
function purposeOf(t: ToolDef): string {
  if (t.binding.type !== 'http') return (t.title || t.name).toLowerCase();
  const m = t.binding.method;
  const item = /\}$/.test(t.binding.pathTemplate);
  const n = noun(t);
  if (m === 'GET') return item ? `one ${n} by id` : `find ${n}s`;
  const a = /^[aeiou]/i.test(n) ? 'an' : 'a';
  if (m === 'POST' && !item) return `create ${a} ${n}`;
  if (m === 'DELETE') return `delete ${a} ${n}`;
  if (m === 'PATCH' || m === 'PUT') return `change ${a} ${n}`;
  return (t.title || t.name).toLowerCase();
}

/**
 * Tools an agent confuses with this one: the same resource's collection/item reads and writes (`get_order` ↔
 * `list_orders`), at most 2, reads first for reads and the read of the target for writes.
 */
export function relatedTools(t: ToolDef, tools: ToolDef[]): ToolDef[] {
  if (t.binding.type !== 'http') return [];
  const path = t.binding.pathTemplate;
  const collection = path.replace(/\/\{[^}]+\}$/, '');
  const base = t.risk.write ? path.replace(/\/[a-z_-]+$/i, '') : path;
  const near = tools.filter((x) => {
    if (x === t || x.hidden || x.binding.type !== 'http' || x.kind === 'composite') return false;
    const p = x.binding.pathTemplate;
    return p === collection || p === `${collection}/{${/\{([^}]+)\}$/.exec(path)?.[1] ?? ''}}` || p.replace(/\/\{[^}]+\}$/, '') === collection || p === base;
  });
  const rank = (x: ToolDef) => (x.risk.write ? 1 : 0) + (x.binding.type === 'http' && x.binding.method === 'GET' && /\}$/.test(x.binding.pathTemplate) === /\}$/.test(path) ? 0.5 : 0);
  return near.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name)).slice(0, 2);
}

export interface DescribeOptions {
  example?: Record<string, unknown> | null;
  /** list tools: the injected paging argument names and the largest page size */
  paging?: { cursor: string; limit: string | null; limitMax?: number | null } | null;
  /** the `fields` argument name and the default field set (overlay include) */
  fields?: { name: string; defaults?: string[] } | null;
  /** write tools: the injected `dry_run` / `confirm` names; confirm tokens apply outside prod */
  dryRun?: string | null;
  confirm?: string | null;
}

/** The contract-2 description of an API tool (contract-v2 §4.5). Composite tools keep their own. */
export function describeTool(t: ToolDef, tools: ToolDef[], o: DescribeOptions = {}): string {
  if (t.kind === 'composite') return t.description;
  const lines: string[] = [];
  let lead = leadSentences(t.description) || t.title || t.name;
  if (!/[.!?]$/.test(lead)) lead += '.';
  if (t.risk.write) lead += t.risk.destructive ? ' Irreversible.' : ' Writes data.';
  lines.push(lead);
  const rel = relatedTools(t, tools);
  if (rel.length) lines.push(`Related: ${rel.map((x) => `${x.name} (${purposeOf(x)})`).join(', ')}.`);
  const p = props(t);
  const req = new Set(required(t));
  const own = new Set([o.paging?.cursor, o.paging?.limit, o.fields?.name, o.dryRun, o.confirm].filter(Boolean));
  const names = Object.keys(p).filter((k) => !own.has(k));
  if (names.length) {
    const r = names.filter((k) => req.has(k));
    const opt = names.filter((k) => !req.has(k));
    const optText = opt.length > 6 ? `${opt.slice(0, 6).join(', ')}, … (${opt.length - 6} more)` : opt.join(', ');
    lines.push(`Args: ${[r.length ? `${r.join(', ')} (required)` : '', opt.length ? `${optText}${r.length ? '' : ' (all optional)'}` : ''].filter(Boolean).join('; ')}.`);
  }
  if (o.example) lines.push(`Example: ${t.name}(${JSON.stringify(o.example)})`);
  const extra: string[] = [];
  if (o.paging) extra.push(`Pages: ${o.paging.cursor}=page.next_cursor${o.paging.limit ? `, ${o.paging.limit} ≤ ${o.paging.limitMax ?? 100}` : ''}.`);
  // lists only (contract-v2 §4.5 pairs it with Pages); the `fields` argument's schema names the default set anyway
  if (o.fields && o.paging) extra.push(`Fields: ${o.fields.name}=${JSON.stringify((o.fields.defaults?.length ? o.fields.defaults : topFields(t)).slice(0, 3))}.`);
  if (extra.length) lines.push(extra.join(' '));
  if (t.risk.write && o.dryRun) lines.push(`Dry run: ${o.dryRun}=true returns the plan${t.risk.destructive && o.confirm ? `; then call with ${o.confirm} from error.next` : ''}.`);
  return lines.join('\n');
}

function topFields(t: ToolDef): string[] {
  const o = t.outputSchema;
  if (!isObj(o)) return [];
  const wrapped = typeof o['x-neurouter-wrapped'] === 'string' && isObj(o.properties) ? ((o.properties as Obj)[o['x-neurouter-wrapped'] as string] as Obj) : o;
  const s = isObj(wrapped) && wrapped.type === 'array' && isObj(wrapped.items) ? (wrapped.items as Obj) : wrapped;
  if (isObj(s) && isObj(s.properties)) {
    const arr = Object.entries(s.properties).find(([, v]) => isObj(v) && v.type === 'array');
    const item = arr && Object.keys(s.properties).length <= 4 && isObj((arr[1] as Obj).items) ? ((arr[1] as Obj).items as Obj) : s;
    return isObj(item.properties) ? Object.keys(item.properties) : [];
  }
  return [];
}

// ---------------------------------------------------------------- lint helpers

/** A first sentence that states the effect: verb first (`Cancels`, `List`), 20–200 chars. */
export function firstSentenceProblem(t: ToolDef): string | null {
  const s = leadSentences(t.description, 0);
  const word = (s.split(/\s+/)[0] ?? '').replace(/[^A-Za-z]/g, '');
  if (s.length < 10) return `first sentence is too short (${s.length} chars): say what the tool does`;
  if (s.length > 200) return `first sentence is ${s.length} chars (aim for ≤ 200)`;
  if (!isVerb(word)) return `first sentence should start with what it does (a verb), not "${word}"`;
  return null;
}

/** Destructive writes must be marked, and their first sentence must name the effect (or say it cannot be undone). */
export function destructiveProblem(t: ToolDef): string | null {
  if (!t.risk.write) return null;
  const isDelete = t.binding.type === 'http' && t.binding.method === 'DELETE';
  const verb = destructiveVerb(t.name, t.title, t.description.split('\n')[0]);
  if ((isDelete || verb) && !t.risk.destructive && !t.overlayApplied.length) return `${isDelete ? 'DELETE' : `"${verb}"`} write is not marked destructive (set risk.destructive in the overlay)`;
  if (!t.risk.destructive) return null;
  const lead = leadSentences(t.description, 0);
  if (!destructiveVerb(lead) && !/\b(irreversibl|permanent|cannot be undone|can't be undone)/i.test(t.description)) return 'destructive, but the first sentence does not name what is destroyed (e.g. "Deletes the label …", "Cancels the order …")';
  return null;
}

const SIZE = new Set(['limit', 'per_page', 'page_size', 'pagesize', 'max_results', 'maxresults', 'count', 'size', 'first', 'top']);
const POSITION = new Set(['cursor', 'page_token', 'pagetoken', 'after', 'before', 'next_token', 'nexttoken', 'continuation', 'continuation_token', 'starting_after', 'ending_before', 'marker', 'page', 'offset', 'skip', 'start', 'next', 'next_cursor']);

/**
 * A list that pages upstream (a page-size parameter) but has no way to ask for the next page (no cursor, page or
 * offset parameter, no Link header, no next token in the response): `has_more` can be true without a cursor.
 */
export function hasMoreWithoutCursor(t: ToolDef): boolean {
  if (t.binding.type !== 'http' || t.risk.write) return false;
  const q = t.binding.params.filter((p) => p.in === 'query').map((p) => p.name.toLowerCase());
  if (!q.some((n) => SIZE.has(n))) return false;
  if (q.some((n) => POSITION.has(n))) return false;
  if (t.binding.pagination?.style === 'link' || t.binding.pagination?.nextPath) return false;
  return true;
}

/** Argument descriptions that list allowed values in prose: missing from the schema (fail) or repeated (noise). */
export function proseEnums(t: ToolDef): Array<{ arg: string; values: string[]; inSchema: boolean }> {
  const out: Array<{ arg: string; values: string[]; inSchema: boolean }> = [];
  const all = Object.entries(props(t));
  const enumOf = (s: JsonSchema): unknown[] | null => (Array.isArray(s.enum) ? s.enum : isObj(s.items) && Array.isArray((s.items as Obj).enum) ? ((s.items as Obj).enum as unknown[]) : null);
  for (const [k, s] of all) {
    const d = typeof s.description === 'string' ? s.description.trim() : '';
    const ty = Array.isArray(s.type) ? s.type : [s.type];
    if (!d || ty.includes('boolean') || ty.includes('integer') || ty.includes('number')) continue;
    const values = enumInProse(d);
    if (values.length < 2) continue;
    // values of another argument's enum describe that argument (`required when event is COMMENT`)
    const other = all.filter(([o]) => o !== k).flatMap(([, x]) => enumOf(x) ?? []);
    if (values.some((v) => other.includes(v))) continue;
    out.push({ arg: k, values, inSchema: enumOf(s) !== null });
  }
  return out;
}

/** `one of: a, b, c`, `` `a`, `b` or `c` ``, `"a" | "b"`, or a whole description `open, closed or all`. */
export function enumInProse(d: string): string[] {
  // a contiguous run of quoted values: `a`, `b` or `c`
  const q = '[`"\']([A-Za-z0-9_-]{1,30})[`"\']';
  const run = new RegExp(`${q}(?:\\s*(?:,\\s*or|,|\\bor\\b|\\|)\\s*${q})+`).exec(d);
  if (run) return [...new Set([...run[0].matchAll(new RegExp(q, 'g'))].map((m) => m[1]!))];
  const oneOf = /\b(?:one of|either|possible values(?: are)?|allowed values(?: are)?|can be)\s*:?\s*([A-Za-z0-9_-]+(?:\s*(?:,|\bor\b|\|)\s*[A-Za-z0-9_-]+)+)/i.exec(d);
  if (oneOf) return oneOf[1]!.split(/\s*(?:,|\bor\b|\|)\s*/).filter(Boolean);
  const whole = /^([a-z0-9_-]+(?:, [a-z0-9_-]+)*,? or [a-z0-9_-]+)\.?$/.exec(d);
  if (whole) return whole[1]!.split(/,\s*|\s+or\s+/).filter(Boolean);
  return [];
}
