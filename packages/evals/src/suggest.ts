import { READINESS_WEIGHTS, type FailureCause, type LintReport, type SuggestionKind } from '@neurouter/shared';
import { SUGGEST_MARKER, SUGGEST_PROMPT_VERSION, SUGGEST_SYSTEM, markerMessage } from './prompts.js';
import { parseJsonText, textOf, type LlmClient } from './llm/types.js';
import { firstSentence, mulberry32, shuffle, tokens } from './rng.js';
import { apiCalls, UNMET_NEED_TOOL } from './check.js';
import { toYaml } from './yaml-emit.js';
import type { EvalTask, TaskRunResult } from './types.js';

/** A tool of the evaluated build, as the suggester needs it. */
export interface SuggestTool {
  name: string;
  /** Overlay selector key (`operationId:x`, `"GET /p"`, `graphql:Query.f`). */
  key: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  hidden: boolean;
  tags: string[];
  write: boolean;
  /** For spec patches (OpenAPI tools). */
  sourceRef?: { method?: string; path?: string; operationId?: string } | null;
  pyName?: string;
}

/** Structured form of a patch (console `OverlayPatchOp`s). */
export type SuggestOp =
  | { op: 'set'; selector: string; field: 'name' | 'title' | 'description' | 'hidden' | 'pinned' | 'tags' | 'risk' | 'args' | 'response' | 'examples'; value: unknown }
  | { op: 'set_default'; field: 'hidden'; value: boolean }
  | { op: 'set_composite'; name: string; value: Record<string, unknown> };

export interface Suggestion {
  cause: FailureCause | 'toolset_size';
  kind: SuggestionKind;
  tools: string[];
  affectedTaskKeys: string[];
  /** Overlay YAML fragment (`overlay: 1` + `tools`/`defaults`/`composites`). */
  overlayPatch: string;
  overlayOps: SuggestOp[];
  /** RFC 6902 JSON Patch against the original spec (describe/example only), JSON text. */
  specPatch: string | null;
  rationale: string;
  predictedDelta: number;
}

export interface SuggestOptions {
  results: TaskRunResult[];
  tasks: EvalTask[];
  tools: SuggestTool[];
  /** Validates "published overlay + patch" by compiling it; invalid patches are dropped. */
  validatePatch: (overlayPatchYaml: string, ops: SuggestOp[]) => Promise<{ ok: boolean; diagnostics: string[] }>;
  llm?: LlmClient | null;
  model?: string;
  lint?: Pick<LintReport, 'rules'> | null;
  /** Search over hidden tools for an unmet-need intent (missing_capability → unhide). */
  findHiddenTool?: (intent: string) => Promise<string | null>;
  signal?: AbortSignal;
}

export interface Cluster {
  cause: FailureCause;
  tool: string | null;
  results: TaskRunResult[];
  taskKeys: string[];
}

/** Causes a tool fix can address. Not `wrong_answer` (B2): the agent used the tools right and mis-added; no description fixes that. */
const ACTIONABLE: FailureCause[] = ['wrong_tool', 'bad_arguments', 'missing_capability', 'over_budget', 'gave_up'];

/** Step 1: failed attempts clustered by (failure cause, primary tool). Largest clusters first. */
export function clusterFailures(results: TaskRunResult[]): Cluster[] {
  const map = new Map<string, Cluster>();
  for (const r of results) {
    if (r.passed || !r.failureCause || !ACTIONABLE.includes(r.failureCause)) continue;
    const k = `${r.failureCause}|${r.primaryTool ?? ''}`;
    const c = map.get(k) ?? { cause: r.failureCause, tool: r.primaryTool, results: [], taskKeys: [] };
    c.results.push(r);
    if (!c.taskKeys.includes(r.taskKey)) c.taskKeys.push(r.taskKey);
    map.set(k, c);
  }
  return [...map.values()].sort((a, b) => b.taskKeys.length - a.taskKeys.length || b.results.length - a.results.length);
}

/** Step 4: upper-bound score gain if every affected task passes. */
export function predictedDelta(affected: number, totalTasks: number): number {
  return totalTasks ? Math.round((100 * READINESS_WEIGHTS.success * affected) / totalTasks) : 0;
}

/** Verify set: affected tasks plus a seeded 20% sample of passing tasks (regression guard). */
export function selectVerifyTasks(affected: string[], passing: string[], ratio = 0.2, seed = 1): string[] {
  const rest = passing.filter((k) => !affected.includes(k));
  const n = Math.ceil(rest.length * ratio);
  return [...affected, ...shuffle(rest, mulberry32(seed)).slice(0, n)];
}

export async function suggest(opts: SuggestOptions): Promise<Suggestion[]> {
  const total = opts.tasks.filter((t) => t.enabled !== false).length;
  const byName = new Map(opts.tools.map((t) => [t.name, t]));
  const tasks = new Map(opts.tasks.map((t) => [t.key, t]));
  const out: Suggestion[] = [];
  const clusters = clusterFailures(opts.results);

  // toolset too big: lint toolset_size failing and wrong_tool across many tools → hide by default + pins
  const toolsetFailing = opts.lint?.rules.some((r) => r.rule === 'toolset_size' && !r.passed) ?? false;
  const wrongTools = new Set(clusters.filter((c) => c.cause === 'wrong_tool').map((c) => c.tool));
  if (toolsetFailing && wrongTools.size >= 3) {
    const used = new Set(opts.tasks.flatMap((t) => [...t.referenceCalls.map((r) => r.tool), ...t.assertions.flatMap((a) => (a.type === 'called' ? [a.tool] : []))]));
    const keep = [...used].map((n) => byName.get(n)).filter((t): t is SuggestTool => !!t);
    const ops: SuggestOp[] = [{ op: 'set_default', field: 'hidden', value: true }, ...keep.flatMap((t) => [{ op: 'set' as const, selector: t.key, field: 'hidden' as const, value: false }, { op: 'set' as const, selector: t.key, field: 'pinned' as const, value: true }])];
    const affected = [...new Set(clusters.filter((c) => c.cause === 'wrong_tool').flatMap((c) => c.taskKeys))];
    out.push(make('toolset_size', 'hide', keep.map((t) => t.name), affected, ops, null, `The toolset is too large for reliable selection (${opts.tools.filter((t) => !t.hidden).length} visible tools) and agents picked wrong tools on ${affected.length} tasks. Hide everything by default and pin the ${keep.length} tools the tasks need.`, total));
  }

  for (const c of clusters) {
    const tool = c.tool ? byName.get(c.tool) : undefined;
    const prompts = c.taskKeys.map((k) => tasks.get(k)?.prompt ?? '').filter(Boolean);
    const llmText = opts.llm ? await askLlm(opts, c, tool, prompts).catch(() => null) : null;
    let s: Suggestion | null = null;
    switch (c.cause) {
      case 'wrong_tool': {
        if (!tool) break;
        const confused = mostCommon(c.results.flatMap((r) => apiCalls(r.calls).map((x) => x.tool).filter((n) => n !== tool.name)));
        const other = confused ? byName.get(confused) : undefined;
        if (llmText?.rename && llmText.rename.from === tool.name && /^[a-z][a-z0-9_]{0,63}$/.test(llmText.rename.to)) {
          s = make('wrong_tool', 'rename', [tool.name], c.taskKeys, [{ op: 'set', selector: tool.key, field: 'name', value: llmText.rename.to }], null, llmText.rationale ?? `Agents confused ${tool.name} with ${confused}; a clearer name separates them.`, total);
          break;
        }
        const desc = llmText?.descriptions?.[tool.name] ?? contrastDescription(tool, other, prompts[0]);
        const ops: SuggestOp[] = [{ op: 'set', selector: tool.key, field: 'description', value: desc }];
        const spec: object[] = specDescribe(tool, desc);
        if (other) {
          const od = llmText?.descriptions?.[other.name] ?? contrastDescription(other, tool, null);
          ops.push({ op: 'set', selector: other.key, field: 'description', value: od });
          spec.push(...specDescribe(other, od));
        }
        s = make('wrong_tool', 'describe', [tool.name, ...(other ? [other.name] : [])], c.taskKeys, ops, spec, llmText?.rationale ?? `Agents called ${confused ?? 'other tools'} instead of ${tool.name} on ${c.taskKeys.length} task(s). The descriptions now say when to use each.`, total);
        break;
      }
      case 'bad_arguments': {
        if (!tool) break;
        const ref = c.taskKeys.map((k) => tasks.get(k)?.referenceCalls.find((r) => r.tool === tool.name)).find(Boolean);
        const props = (tool.inputSchema.properties ?? {}) as Record<string, Record<string, unknown>>;
        const bad = new Set<string>();
        for (const r of c.results)
          for (const call of apiCalls(r.calls).filter((x) => x.tool === tool.name))
            for (const [k, v] of Object.entries(ref?.arguments ?? {})) if (JSON.stringify(call.arguments[k]) !== JSON.stringify(v)) bad.add(k);
        const describe: Record<string, string> = {};
        for (const k of bad.size ? bad : new Set(Object.keys(props).filter((k) => !props[k]?.description))) {
          const llmArg = llmText?.argDescriptions?.[tool.name]?.[k];
          const ex = ref?.arguments[k];
          describe[k] = llmArg ?? `${describeType(props[k])}${ex !== undefined ? `, e.g. ${JSON.stringify(ex)}` : ''}.`;
        }
        const ops: SuggestOp[] = [];
        if (Object.keys(describe).length) ops.push({ op: 'set', selector: tool.key, field: 'args', value: { describe } });
        if (ref) ops.push({ op: 'set', selector: tool.key, field: 'examples', value: [{ title: firstSentence(prompts[0] ?? tool.name).slice(0, 80), arguments: ref.arguments }] });
        if (!ops.length) break;
        const kind: SuggestionKind = ref && !Object.keys(describe).length ? 'example' : ref ? 'example' : 'describe';
        s = make('bad_arguments', kind, [tool.name], c.taskKeys, ops, specExamples(tool, ref?.arguments ?? null), llmText?.rationale ?? `Agents passed wrong arguments to ${tool.name}${bad.size ? ` (${[...bad].join(', ')})` : ''}. Argument descriptions and a worked example show the expected values.`, total);
        break;
      }
      case 'missing_capability': {
        const intents = c.results.flatMap((r) => r.calls.filter((x) => x.tool === UNMET_NEED_TOOL).map((x) => String(x.arguments.intent ?? ''))).filter(Boolean);
        const intent = intents[0] ?? prompts[0] ?? '';
        const hidden = opts.findHiddenTool && intent ? await opts.findHiddenTool(intent) : null;
        const ht = hidden ? byName.get(hidden) : undefined;
        if (ht) {
          s = make('missing_capability', 'hide', [ht.name], c.taskKeys, [{ op: 'set', selector: ht.key, field: 'hidden', value: false }], null, `Agents reported "${intent.slice(0, 120)}" as unmet, but the hidden tool ${ht.name} does it. Unhide it.`, total);
          break;
        }
        const t = tasks.get(c.taskKeys[0] ?? '');
        const refs = t?.referenceCalls ?? [];
        if (!refs.length) break;
        const name = `do_${tokens(intent).slice(0, 3).join('_') || 'task'}`.slice(0, 40);
        const script = refs.map((r, i) => `r${i + 1} = ${byName.get(r.tool)?.pyName ?? r.tool}(${Object.keys(r.arguments).map((k) => `${k}=${k}`).join(', ')})`).join('\n') + `\nreturn {${refs.map((_, i) => `"r${i + 1}": r${i + 1}`).join(', ')}}`;
        const argNames = [...new Set(refs.flatMap((r) => Object.keys(r.arguments)))];
        const value = { title: intent.slice(0, 80) || name, description: `${intent.slice(0, 200)} (composite sketch; review before publishing).`, inputSchema: { type: 'object', properties: Object.fromEntries(argNames.map((a) => [a, { type: 'string' }])), required: argNames }, write: refs.some((r) => byName.get(r.tool)?.write), script };
        s = make('missing_capability', 'composite', refs.map((r) => r.tool), c.taskKeys, [{ op: 'set_composite', name, value }], null, `No single tool covers "${intent.slice(0, 120)}". A composite tool built from ${refs.map((r) => r.tool).join(', ')} is sketched for review.`, total);
        break;
      }
      case 'over_budget': {
        if (!tool) break;
        s = make('over_budget', 'response_shape', [tool.name], c.taskKeys, [{ op: 'set', selector: tool.key, field: 'response', value: { maxItems: 20, maxBytes: 8192 } }], null, `Attempts ran out of budget around ${tool.name}; capping its response keeps results small.`, total);
        break;
      }
      case 'gave_up': {
        if (!tool) break;
        const desc = llmText?.descriptions?.[tool.name] ?? contrastDescription(tool, undefined, prompts[0]);
        s = make('gave_up', 'describe', [tool.name], c.taskKeys, [{ op: 'set', selector: tool.key, field: 'description', value: desc }], specDescribe(tool, desc), llmText?.rationale ?? `Agents gave up on tasks that need ${tool.name}; a more explicit description helps them find it.`, total);
        break;
      }
      default:
        break;
    }
    if (s && !out.some((o) => o.overlayPatch === s!.overlayPatch)) out.push(s);
  }

  const valid: Suggestion[] = [];
  for (const s of out) {
    const v = await opts.validatePatch(s.overlayPatch, s.overlayOps).catch((e: Error) => ({ ok: false, diagnostics: [e.message] }));
    if (v.ok) valid.push(s);
  }
  return valid.sort((a, b) => b.predictedDelta - a.predictedDelta);
}

function make(cause: Suggestion['cause'], kind: SuggestionKind, tools: string[], affected: string[], ops: SuggestOp[], spec: object[] | null, rationale: string, total: number): Suggestion {
  return { cause, kind, tools, affectedTaskKeys: affected, overlayPatch: opsToOverlayYaml(ops), overlayOps: ops, specPatch: spec && spec.length ? JSON.stringify(spec, null, 2) : null, rationale, predictedDelta: predictedDelta(affected.length, total) };
}

/** Renders ops as an overlay fragment in the Neurouter overlay format. */
export function opsToOverlayYaml(ops: SuggestOp[]): string {
  const doc: { overlay: 1; defaults?: Record<string, unknown>; tools?: Record<string, Record<string, unknown>>; composites?: Record<string, unknown> } = { overlay: 1 };
  for (const o of ops) {
    if (o.op === 'set_default') (doc.defaults ??= {})[o.field] = o.value;
    else if (o.op === 'set_composite') (doc.composites ??= {})[o.name] = o.value;
    else {
      const t = ((doc.tools ??= {})[o.selector] ??= {});
      if (o.field === 'args' && t.args && typeof t.args === 'object') t.args = { ...(t.args as object), ...(o.value as object) };
      else t[o.field] = o.value;
    }
  }
  return `${toYaml(doc)}\n`;
}

function mostCommon(xs: string[]): string | null {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [k, v] of m) if (v > n) [best, n] = [k, v];
  return best;
}

function contrastDescription(tool: SuggestTool, other: SuggestTool | undefined, examplePrompt: string | null | undefined): string {
  const base = firstSentence(tool.description || tool.title || tool.name.replace(/_/g, ' ')).replace(/[.!?]*$/, '.');
  const verbFirst = /^[A-Z][a-z]+s?\b/.test(base) ? base : `Use to ${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  const parts = [verbFirst];
  if (examplePrompt) parts.push(`Use this for requests like: "${firstSentence(examplePrompt).slice(0, 140)}".`);
  if (other) parts.push(`For ${firstSentence(other.description || other.name).replace(/[.!?]*$/, '').toLowerCase()}, use ${other.name} instead.`);
  return parts.join(' ').slice(0, 1024);
}

function describeType(schema: Record<string, unknown> | undefined): string {
  if (!schema) return 'Value';
  if (Array.isArray(schema.enum)) return `One of ${schema.enum.map((x) => JSON.stringify(x)).join(', ')}`;
  return `A ${String(schema.type ?? 'value')}${schema.format ? ` (${String(schema.format)})` : ''}`;
}

const ptr = (s: string) => s.replace(/~/g, '~0').replace(/\//g, '~1');
function specDescribe(tool: SuggestTool, desc: string): object[] {
  const ref = tool.sourceRef;
  if (!ref?.path || !ref.method) return [];
  return [{ op: 'add', path: `/paths/${ptr(ref.path)}/${ref.method.toLowerCase()}/description`, value: desc }];
}
function specExamples(tool: SuggestTool, args: Record<string, unknown> | null): object[] | null {
  const ref = tool.sourceRef;
  if (!ref?.path || !ref.method || !args) return null;
  return [{ op: 'add', path: `/paths/${ptr(ref.path)}/${ref.method.toLowerCase()}/x-neurouter-examples`, value: [{ arguments: args }] }];
}

interface LlmSuggestText {
  descriptions?: Record<string, string>;
  argDescriptions?: Record<string, Record<string, string>>;
  rename?: { from: string; to: string } | null;
  rationale?: string;
}

const SUGGEST_SCHEMA = {
  type: 'object',
  properties: {
    descriptions: { type: 'object', additionalProperties: { type: 'string' } },
    argDescriptions: { type: 'object', additionalProperties: { type: 'object', additionalProperties: { type: 'string' } } },
    rename: { type: ['object', 'null'], properties: { from: { type: 'string' }, to: { type: 'string' } } },
    rationale: { type: 'string' },
  },
} as const;

async function askLlm(opts: SuggestOptions, c: Cluster, tool: SuggestTool | undefined, prompts: string[]): Promise<LlmSuggestText | null> {
  if (!opts.llm || !opts.model || (c.cause !== 'wrong_tool' && c.cause !== 'bad_arguments' && c.cause !== 'gave_up')) return null;
  const involved = new Set<string>([...(tool ? [tool.name] : []), ...c.results.flatMap((r) => apiCalls(r.calls).map((x) => x.tool))]);
  const tools = opts.tools.filter((t) => involved.has(t.name)).slice(0, 6).map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const failures = c.results.slice(0, 5).map((r) => ({ task: r.taskKey, called: apiCalls(r.calls).map((x) => ({ tool: x.tool, args: x.arguments, status: x.status })) }));
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 4000,
      system: SUGGEST_SYSTEM,
      messages: [{ role: 'user', content: markerMessage(SUGGEST_MARKER, SUGGEST_PROMPT_VERSION, { cause: c.cause, expectedTool: tool?.name ?? null, tools, prompts: prompts.slice(0, 5), failures }, 'Propose better tool and argument descriptions so agents succeed on these tasks.') }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SUGGEST_SCHEMA as unknown as Record<string, unknown> } },
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  const j = parseJsonText(textOf(res)) as LlmSuggestText;
  const clean = (m?: Record<string, string>) => (m ? Object.fromEntries(Object.entries(m).filter(([, v]) => typeof v === 'string' && v.trim().length >= 10).map(([k, v]) => [k, v.slice(0, 1024)])) : undefined);
  const descriptions = clean(j.descriptions);
  return { ...(descriptions && Object.keys(descriptions).length ? { descriptions } : {}), ...(j.argDescriptions ? { argDescriptions: j.argDescriptions } : {}), ...(j.rename ? { rename: j.rename } : {}), ...(typeof j.rationale === 'string' ? { rationale: j.rationale } : {}) };
}
