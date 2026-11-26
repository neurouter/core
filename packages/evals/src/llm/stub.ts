import type { Assertion } from '@neurouter/shared';
import { GENERATOR_MARKER, JUDGE_MARKER, SUGGEST_MARKER, readMarkerInput } from '../prompts.js';
import { firstSentence, mulberry32, shuffle, tokens } from '../rng.js';
import type { GeneratedTask, GeneratorCategoryInput, GenTool } from '../types.js';
import { llmResponse } from './fake.js';
import type { LlmClient, LlmMessageParam, LlmRequest, LlmResponse, LlmTool, LlmToolUseBlock } from './types.js';

/**
 * Deterministic stub provider (no API key): plays the generator, the agent and the judge with
 * fixed heuristics so `neurouter eval` and the demo produce a readiness score offline. Responses
 * report `model: "stub"`; the stub is only used when selected explicitly (`provider: 'stub'`).
 */
export const STUB_MODEL = 'stub';
/** Model label stored on eval runs played by the stub, so stored results never name a real model. */
export const STUB_RUN_MODEL = 'stub (simulated, not a real model)';

export class StubLlmClient implements LlmClient {
  readonly provider = 'stub' as const;

  async create(req: LlmRequest): Promise<LlmResponse> {
    const first = messageText(req.messages[0]);
    const gen = readMarkerInput(first, GENERATOR_MARKER) as GeneratorCategoryInput | null;
    if (gen) return this.reply(req, [{ type: 'text', text: JSON.stringify({ tasks: stubGenerate(gen) }) }]);
    const judge = readMarkerInput(first, JUDGE_MARKER) as StubJudgeInput | null;
    if (judge) return this.reply(req, [{ type: 'text', text: JSON.stringify(stubJudge(judge)) }]);
    if (first.includes(SUGGEST_MARKER)) return this.reply(req, [{ type: 'text', text: '{}' }]);
    return this.reply(req, stubAgentStep(req));
  }

  private reply(req: LlmRequest, content: LlmResponse['content']): LlmResponse {
    const input = Math.ceil(JSON.stringify(req.messages).length / 4) + Math.ceil(JSON.stringify(req.tools ?? []).length / 4);
    const output = Math.ceil(JSON.stringify(content).length / 4);
    return llmResponse(content, { model: STUB_MODEL, input, output });
  }
}

function messageText(m: LlmMessageParam | undefined): string {
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return m.content.map((b) => (b.type === 'text' ? String((b as { text: string }).text) : '')).join('\n');
}

/* ------------------------------------------------------------------ generator */

const IMPOSSIBLE_INTENTS = [
  'Send an SMS to the account owner telling them the report is ready',
  'Book a flight to Berlin for next Tuesday',
  'Translate the documentation into French and publish it on the website',
  'Order printer paper for the office',
  'Schedule a video call with the marketing team',
  'Convert last month invoices into a PDF and fax it',
  'Reset my laptop password',
  'Play some relaxing music',
];

/** Phrasing variants so a small toolset still yields distinct prompts (the generator dedupes prompts). */
const VARIANTS = ['', ' and summarize the result', ' and tell me the key fields', ' and report back briefly'];
const variant = (i: number, size: number) => VARIANTS[Math.floor(i / Math.max(1, size)) % VARIANTS.length]!;

export function stubGenerate(input: GeneratorCategoryInput): GeneratedTask[] {
  const rand = mulberry32(input.seed + input.category.length * 7919);
  const tools = input.tools.filter((t) => !t.name.startsWith('neurouter_'));
  const reads = tools.filter((t) => !t.write);
  const out: GeneratedTask[] = [];
  const framing: Assertion = { type: 'framing' };
  const n = input.count;
  if (input.category === 'single') {
    const pool = shuffle(reads.length ? reads : tools, rand);
    for (let i = 0; i < n && pool.length; i++) {
      const t = pool[i % pool.length]!;
      const args = argsFor(t, input.samples);
      out.push({
        key: `single-${t.name}-${i + 1}`,
        category: 'single',
        prompt: `${imperative(t)}${argText(args)}${variant(i, pool.length)}`,
        rubric: `The agent calls ${t.name} with the given values and reports the result.`,
        assertions: [{ type: 'called', tool: t.name, ...(Object.keys(args).length ? { args, argsMatch: 'subset' as const } : {}) }, framing],
        reference_calls: [{ tool: t.name, arguments: args }],
      });
    }
  } else if (input.category === 'multi') {
    const lists = reads.filter((t) => /list|find|search|all|query/.test(t.name) || requiredOf(t).length === 0);
    const gets = reads.filter((t) => requiredOf(t).length > 0 && !lists.includes(t));
    const pairs: Array<[GenTool, GenTool]> = [];
    for (const l of lists) for (const g of gets) pairs.push([l, g]);
    if (!pairs.length) for (let i = 0; i + 1 < reads.length; i++) pairs.push([reads[i]!, reads[i + 1]!]);
    const pool = shuffle(pairs, rand);
    for (let i = 0; i < n && pool.length; i++) {
      const [a, b] = pool[i % pool.length]!;
      const aa = argsFor(a, input.samples);
      const ba = argsFor(b, input.samples);
      out.push({
        key: `multi-${a.name}-${b.name}-${i + 1}`,
        category: 'multi',
        prompt: `First ${lowerFirst(imperative(a))}${argText(aa)}, then ${lowerFirst(imperative(b))}${argText(ba)}${variant(i, pool.length)}.`,
        rubric: `The agent calls ${a.name} and then ${b.name} and summarizes both results.`,
        assertions: [{ type: 'called', tool: a.name }, { type: 'called', tool: b.name, ...(Object.keys(ba).length ? { args: ba, argsMatch: 'subset' as const } : {}) }, framing],
        reference_calls: [
          { tool: a.name, arguments: aa },
          { tool: b.name, arguments: ba },
        ],
      });
    }
  } else if (input.category === 'ambiguous') {
    const pool = shuffle(reads.length ? reads : tools, rand);
    for (let i = 0; i < n && pool.length; i++) {
      const t = pool[i % pool.length]!;
      const noun = tokens(t.name).filter((w) => !['get', 'list', 'find', 'by', 'id', 'search'].includes(w))[0] ?? 'records';
      out.push({
        key: `ambiguous-${t.name}-${i + 1}`,
        category: 'ambiguous',
        prompt: `Can you check on the ${noun} for me${variant(i, pool.length)}?`,
        rubric: 'The request is underspecified. The agent asks a clarifying question, or makes a reasonable choice and states it.',
        assertions: [{ type: 'no_writes' }, { type: 'judge', criterion: 'Asks a clarifying question or makes a reasonable, stated choice.' }, framing],
        reference_calls: [],
      });
    }
  } else {
    const vocab = new Set(tools.flatMap((t) => tokens(`${t.name} ${t.description}`)));
    const intents = shuffle(
      IMPOSSIBLE_INTENTS.filter((s) => !tokens(s).some((w) => vocab.has(w))),
      rand,
    );
    const pool = intents.length ? intents : shuffle(IMPOSSIBLE_INTENTS, rand);
    for (let i = 0; i < n; i++) {
      const intent = pool[i % pool.length]!;
      out.push({
        key: `impossible-${i + 1}`,
        category: 'impossible',
        prompt: `${intent}${variant(i, pool.length)}.`,
        rubric: 'No tool can do this. The agent says so and reports an unmet need; it must not write.',
        assertions: [{ type: 'unmet_need_reported_or_declined' }, { type: 'no_writes' }, framing],
        reference_calls: [],
      });
    }
  }
  return out;
}

function lowerFirst(s: string): string {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

function imperative(t: GenTool): string {
  const s = firstSentence(t.description || t.title || t.name.replace(/_/g, ' ')).replace(/[.!?]+$/, '');
  return s || t.name.replace(/_/g, ' ');
}

function argText(args: Record<string, unknown>): string {
  const parts = Object.entries(args).map(([k, v]) => `${k}=${typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v)}`);
  return parts.length ? ` (use ${parts.join(', ')})` : '';
}

function requiredOf(t: { inputSchema: Record<string, unknown> }): string[] {
  const r = t.inputSchema.required;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string') : [];
}

function propsOf(t: { inputSchema: Record<string, unknown> }): Record<string, Record<string, unknown>> {
  const p = t.inputSchema.properties;
  return p && typeof p === 'object' ? (p as Record<string, Record<string, unknown>>) : {};
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Required arguments for a tool: known-good examples first, then values from mock samples, then type defaults. */
export function argsFor(t: GenTool, samples: GeneratorCategoryInput['samples']): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = propsOf(t);
  for (const name of requiredOf(t)) {
    if (t.exampleArguments && name in t.exampleArguments) {
      out[name] = t.exampleArguments[name];
      continue;
    }
    out[name] = sampleValue(name, props[name] ?? {}, samples) ?? typeDefault(props[name] ?? {});
  }
  return out;
}

function sampleValue(arg: string, schema: Record<string, unknown>, samples: GeneratorCategoryInput['samples']): unknown {
  const a = norm(arg);
  const resources = Object.entries(samples);
  for (const [, ents] of resources) for (const e of ents) for (const [k, v] of Object.entries(e)) if (norm(k) === a && isScalar(v) && typeMatches(v, schema)) return v;
  // petId / pet_id → pets[0].id
  const m = /^(.*?)(id|number|key|slug|name)$/.exec(a);
  if (m && m[1]) {
    const prefix = m[1];
    for (const [res, ents] of resources) {
      const r = norm(res).replace(/s$/, '');
      if (r === prefix || r.endsWith(prefix) || prefix.endsWith(r)) {
        const e = ents[0];
        const v = e?.[m[2]!] ?? e?.id;
        if (isScalar(v)) return v;
      }
    }
  }
  return undefined;
}

function isScalar(v: unknown): v is string | number | boolean {
  return typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

function typeMatches(v: unknown, schema: Record<string, unknown>): boolean {
  const t = schema.type;
  if (t === 'integer') return Number.isInteger(v);
  if (t === 'number') return typeof v === 'number';
  if (t === 'string') return typeof v === 'string';
  if (t === 'boolean') return typeof v === 'boolean';
  return true;
}

function typeDefault(schema: Record<string, unknown>): unknown {
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  switch (schema.type) {
    case 'integer':
    case 'number':
      return 1;
    case 'boolean':
      return true;
    case 'array':
      return [];
    case 'object':
      return {};
    default:
      return 'demo';
  }
}

/* ------------------------------------------------------------------ judge */

export interface StubJudgeInput {
  criteria: string[];
  rubric: string;
  finalAnswer: string;
  calls: Array<{ tool: string; status: string }>;
}

export function stubJudge(input: StubJudgeInput): { score: number; verdict: 'pass' | 'fail'; reasons: string[] } {
  const answered = input.finalAnswer.trim().length > 0;
  const acted = input.calls.some((c) => c.status === 'ok');
  const asked = input.finalAnswer.includes('?');
  if (answered && (acted || asked)) return { score: 0.8, verdict: 'pass', reasons: [asked ? 'asks for clarification' : 'made a choice and answered'] };
  return { score: 0.2, verdict: 'fail', reasons: [answered ? 'no supporting tool call' : 'no final answer'] };
}

/* ------------------------------------------------------------------ agent */

const META = new Set(['search_tools', 'call_tool', 'run_script', 'neurouter_read_result']);
const isOps = (n: string) => n.startsWith('neurouter_');

interface History {
  issued: LlmToolUseBlock[];
  results: Map<string, { text: string; isError: boolean }>;
}

function history(messages: LlmMessageParam[]): History {
  const issued: LlmToolUseBlock[] = [];
  const results = new Map<string, { text: string; isError: boolean }>();
  for (const m of messages) {
    if (typeof m.content === 'string') continue;
    for (const b of m.content) {
      if (b.type === 'tool_use') issued.push(b as LlmToolUseBlock);
      if (b.type === 'tool_result') {
        const r = b as { tool_use_id: string; content: unknown; is_error?: boolean };
        const text = typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map((c: { text?: string }) => c.text ?? '').join('') : '';
        results.set(r.tool_use_id, { text, isError: !!r.is_error });
      }
    }
  }
  return { issued, results };
}

interface Candidate {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  pyName?: string;
}

function score(clause: string, c: Candidate): number {
  const q = new Set(tokens(clause));
  let s = 0;
  for (const w of new Set(tokens(c.name))) if (q.has(w)) s += 2;
  for (const w of new Set(tokens(firstSentence(c.description)))) if (q.has(w)) s += 1;
  return s;
}

function best(clause: string, cands: Candidate[]): Candidate | null {
  let top: Candidate | null = null;
  let topScore = 0;
  for (const c of cands) {
    const s = score(clause, c);
    if (s > topScore) {
      top = c;
      topScore = s;
    }
  }
  return topScore >= 2 ? top : null;
}

/** `key=value` pairs written by the stub generator (JSON values) or by people (bare words). */
export function parseKv(text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const re = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?|true|false|null|\[[^\]]*\]|[^\s,;)]+)/g;
  for (const m of text.matchAll(re)) {
    const raw = m[2]!;
    try {
      out[m[1]!] = JSON.parse(raw);
    } catch {
      out[m[1]!] = raw;
    }
  }
  return out;
}

function argsForClause(clause: string, prompt: string, c: Candidate): Record<string, unknown> {
  const props = propsOf(c);
  const kv = { ...parseKv(prompt), ...parseKv(clause) };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(kv)) if (k in props) out[k] = v;
  for (const r of requiredOf(c)) if (!(r in out)) out[r] = typeDefault(props[r] ?? {});
  return out;
}

function clauses(prompt: string): string[] {
  return prompt
    .split(/,?\s*\bthen\b\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

function pyLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLiteral).join(', ')}]`;
  return `{${Object.entries(v as Record<string, unknown>)
    .map(([k, x]) => `${JSON.stringify(k)}: ${pyLiteral(x)}`)
    .join(', ')}}`;
}

let toolUseCounter = 0;
function use(name: string, input: Record<string, unknown>): LlmToolUseBlock {
  return { type: 'tool_use', id: `toolu_stub_${(++toolUseCounter).toString(36)}`, name, input };
}

function parseSearch(text: string): Candidate[] {
  try {
    const j = JSON.parse(text) as { tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown>; pyName?: string; pySignature?: string }> };
    return (j.tools ?? []).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema ?? { type: 'object', properties: {} }, ...(t.pyName ? { pyName: t.pyName } : {}) }));
  } catch {
    // Python-format results (code mode): `def fn(*, a: str, b: int | None = None) -> T` + docstring
    const out: Candidate[] = [];
    const re = /^def (\w+)\(([^)]*)\)[^\n]*\n(?:\s+"{3}([^\n]*))?/gm;
    for (const m of text.matchAll(re)) {
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const part of m[2]!.split(',').map((x) => x.trim()).filter((x) => x && x !== '*')) {
        const pm = /^(\w+)\s*:\s*([^=]+?)(\s*=\s*.+)?$/.exec(part);
        if (!pm) continue;
        const ty = pm[2]!.trim();
        const arg = pm[1]!.replace(/_$/, '');
        properties[arg] = { type: /^int\b/.test(ty) ? 'integer' : /^float\b/.test(ty) ? 'number' : /^bool\b/.test(ty) ? 'boolean' : /^list\[/.test(ty) ? 'array' : 'string' };
        if (!pm[3]) required.push(arg);
      }
      out.push({ name: m[1]!, description: (m[3] ?? '').replace(/"{3}$/, ''), inputSchema: { type: 'object', properties, required } });
    }
    return out;
  }
}

function namespaceFrom(req: LlmRequest, cands: Candidate[]): string {
  for (const c of cands) if (c.pyName?.includes('.')) return c.pyName.split('.')[0]!;
  const sys = typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n');
  const texts = [sys, ...(req.tools ?? []).map((t) => t.description ?? '')].join('\n');
  const declared = /calls tools as ([a-z_][a-z0-9_]*)\.<fn>/.exec(sys);
  if (declared) return declared[1]!;
  for (const m of texts.matchAll(/\b([a-z_][a-z0-9_]*)\.[a-z_][a-z0-9_]*\(/g)) if (m[1] !== 'ops') return m[1]!;
  return 'api';
}

export function stubAgentStep(req: LlmRequest): LlmResponse['content'] {
  const tools = req.tools ?? [];
  const has = (n: string) => tools.some((t) => t.name === n);
  const prompt = messageText(req.messages[0]);
  const h = history(req.messages);
  const issuedNames = new Set(h.issued.map((b) => b.name));
  const api: Candidate[] = tools.filter((t: LlmTool) => !META.has(t.name) && !isOps(t.name)).map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.input_schema }));
  const codeMode = has('run_script') && api.length === 0;
  const parts = clauses(prompt);

  if (has('neurouter_begin_task') && !issuedNames.has('neurouter_begin_task')) return [use('neurouter_begin_task', { goal: prompt.slice(0, 500) })];

  const searchResults = h.issued.filter((b) => b.name === 'search_tools').flatMap((b) => parseSearch(h.results.get(b.id)?.text ?? ''));
  const pool = [...api, ...searchResults.filter((c) => !api.some((a) => a.name === c.name))];
  const picks = parts.map((c) => ({ clause: c, tool: best(c, pool) }));
  const needsSearch = has('search_tools') && !issuedNames.has('search_tools') && (codeMode || picks.some((p) => !p.tool));
  const apiIssued = h.issued.some((b) => !isOps(b.name) && b.name !== 'search_tools');

  if (needsSearch) return parts.map((c) => use('search_tools', { query: c.slice(0, 500), ...(codeMode ? { format: 'python' } : {}) }));

  const chosen = picks.filter((p): p is { clause: string; tool: Candidate } => p.tool !== null);
  const impossible = chosen.length === 0;
  if (impossible) {
    if (has('neurouter_report_unmet_need') && !issuedNames.has('neurouter_report_unmet_need')) return [use('neurouter_report_unmet_need', { intent: prompt.slice(0, 500), attempted: [...issuedNames].filter((n) => !isOps(n)) })];
  } else if (!apiIssued) {
    if (codeMode) {
      const ns = namespaceFrom(req, chosen.map((p) => p.tool));
      const lines = chosen.map((p, i) => {
        const fn = p.tool.pyName ?? `${ns}.${p.tool.name}`;
        const args = argsForClause(p.clause, prompt, p.tool);
        return `r${i + 1} = ${fn}(${Object.entries(args)
          .map(([k, v]) => `${k}=${pyLiteral(v)}`)
          .join(', ')})`;
      });
      const code = `${lines.join('\n')}\nreturn {${chosen.map((_, i) => `"r${i + 1}": r${i + 1}`).join(', ')}}`;
      return [use('run_script', { code, mode: 'execute' })];
    }
    return chosen.map((p) => {
      const args = argsForClause(p.clause, prompt, p.tool);
      const direct = api.some((a) => a.name === p.tool.name);
      return direct ? use(p.tool.name, args) : use('call_tool', { name: p.tool.name, arguments: args });
    });
  }

  const apiResults = h.issued.filter((b) => !isOps(b.name) && b.name !== 'search_tools').map((b) => ({ name: b.name, ...(h.results.get(b.id) ?? { text: '', isError: true }) }));
  const failed = apiResults.some((r) => r.isError);
  if (has('neurouter_end_task') && !issuedNames.has('neurouter_end_task')) {
    const outcome = impossible ? 'failure' : failed ? (apiResults.every((r) => r.isError) ? 'failure' : 'partial') : 'success';
    return [use('neurouter_end_task', { outcome, notes: impossible ? 'not supported by the available tools' : `${apiResults.length} call(s)` })];
  }
  if (impossible) return [{ type: 'text', text: "I can't do that: none of the available tools supports it, so I reported it as an unmet need." }];
  const summary = apiResults.map((r) => `${r.name}${r.isError ? ' failed' : ''}: ${r.text.slice(0, 400)}`).join('\n');
  return [{ type: 'text', text: `Done.\n${summary}` }];
}
