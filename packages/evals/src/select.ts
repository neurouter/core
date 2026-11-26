/**
 * Generator input selection (cost and scope of suite generation). Sending every tool schema on every
 * generator call does not scale: GitHub's 1281 tools are ~516k tokens per call. Each category call
 * gets a token budget; tools are ranked (relevance to the operator instructions, tools with mock
 * sample data, the category's read/write mix; ties interleave tool groups by importance, see `topicWeights`), and sent with full schemas until the budget is used; every other tool is listed by name only
 * (`other_tools`), so the model still knows what exists (impossible and ambiguous tasks). Small APIs
 * fit entirely and are sent as before.
 */
import type { EvalCategory } from '@neurouter/shared';
import { mulberry32, shuffle, tokens } from './rng.js';
import type { GenTool, GeneratorCategoryInput } from './types.js';

/** Default total budget for one suite generation (all category calls and the retry round). */
export const DEFAULT_MAX_GENERATOR_TOKENS = 400_000;
/** Cap for one generator call's prompt (input), whatever the total budget. */
export const MAX_CALL_PROMPT_TOKENS = 60_000;
/** Below this a call is not worth making (a task needs a few tools with schemas). */
export const MIN_CALL_PROMPT_TOKENS = 4_000;
/** Output tokens reserved per call (max_tokens of the generator call). */
export const GENERATOR_MAX_OUTPUT_TOKENS = 16_000;

/** Rough token estimate of a JSON value (≈ 4 characters per token, as the stub and our reports use). */
export function estimateTokens(v: unknown): number {
  return Math.ceil((typeof v === 'string' ? v.length : (JSON.stringify(v) ?? '').length) / 4);
}

/** A name-only entry of the tool catalog. */
export interface CatalogEntry {
  name: string;
  title?: string;
  write?: boolean;
}

export interface Selection {
  tools: GenTool[];
  otherTools: CatalogEntry[];
  samples: GeneratorCategoryInput['samples'];
  /** estimated prompt tokens of tools + catalog + samples */
  estimatedTokens: number;
}

export function groupOf(t: Pick<GenTool, 'group' | 'name'>): string {
  if (t.group) return t.group;
  const i = t.name.indexOf('_');
  return i > 0 ? t.name.slice(0, i) : t.name;
}

/** Resources most agents are asked about (topic weighting boost). */
const COMMON_RE = /(issue|pull|repo|commit|branch|release|user|customer|payment|charge|invoice|subscription|refund|product|price|order|account|message|channel|file|project|contact|ticket|team|member|event|search)/i;

/**
 * Importance of each tag/resource cluster: √(operations) × 2 when the overlay pins one of its tools ×
 * 1.5 for common resources (issues, pull requests, customers, payments, …). Suites sample topics in
 * proportion, so a large API's long tail (Codespaces secrets, top-ups) no longer crowds out its core.
 */
export function topicWeights(tools: Array<Pick<GenTool, 'group' | 'name' | 'pinned'>>): Map<string, number> {
  const ops = new Map<string, number>();
  const pinned = new Set<string>();
  for (const t of tools) {
    const g = groupOf(t);
    ops.set(g, (ops.get(g) ?? 0) + 1);
    if (t.pinned) pinned.add(g);
  }
  return new Map([...ops].map(([g, n]) => [g, Math.sqrt(n) * (pinned.has(g) ? 2 : 1) * (COMMON_RE.test(g) ? 1.5 : 1)]));
}

/** Weighted draw of a key (deterministic for `rand`). */
function draw(weights: Map<string, number>, rand: () => number): string | null {
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  let x = rand() * total;
  for (const [k, w] of weights) {
    x -= w;
    if (x <= 0) return k;
  }
  return [...weights.keys()].pop() ?? null;
}

/**
 * One topic per task: weighted sampling without replacement while topics last (so `count` tasks cover
 * `count` distinct clusters), then with replacement, never more than ⌈count / topics⌉ + 1 per topic.
 */
export function planTopics(tools: Array<Pick<GenTool, 'group' | 'name' | 'pinned'>>, count: number, seed: number): string[] {
  const weights = topicWeights(tools);
  if (!weights.size || count <= 0) return [];
  const rand = mulberry32(seed);
  const left = new Map(weights);
  const used = new Map<string, number>();
  const cap = Math.ceil(count / weights.size) + 1;
  const out: string[] = [];
  while (out.length < count) {
    if (!left.size) for (const [k, w] of weights) if ((used.get(k) ?? 0) < cap) left.set(k, w);
    const k = draw(left, rand);
    if (!k) break;
    left.delete(k);
    used.set(k, (used.get(k) ?? 0) + 1);
    out.push(k);
  }
  return out;
}

/** The topic of a task: the cluster of its first reference tool (else of its first `called` tool). */
export function topicOf(task: { referenceCalls: Array<{ tool: string }>; assertions: Array<{ type: string; tool?: string }> }, tools: Array<Pick<GenTool, 'group' | 'name'>>): string | null {
  const name = task.referenceCalls[0]?.tool ?? task.assertions.find((a) => a.type === 'called')?.tool;
  const t = name ? tools.find((x) => x.name === name) : undefined;
  return t ? groupOf(t) : null;
}

/** Resource paths (`/repos/{owner}/{repo}/issues`) whose samples a tool can use. */
function sampleResourcesOf(t: GenTool, resources: string[]): string[] {
  if (!t.path) return [];
  return resources.filter((r) => t.path === r || t.path!.startsWith(`${r}/`));
}

/**
 * Picks the tools (full schemas), the name-only catalog and the samples for one category call within
 * `budgetTokens` (estimated prompt tokens). Deterministic for a seed.
 */
export function selectGeneratorInput(all: GenTool[], opts: { category: EvalCategory; budgetTokens: number; seed: number; samples: GeneratorCategoryInput['samples']; instructions?: string | null }): Selection {
  const fullCost = estimateTokens(all) + estimateTokens(opts.samples);
  if (fullCost <= opts.budgetTokens) return { tools: all, otherTools: [], samples: opts.samples, estimatedTokens: fullCost };
  const resources = Object.keys(opts.samples);
  // every tool fits: send them all and as many samples as the rest of the budget holds (tools' resources first)
  const toolsCost = estimateTokens(all);
  if (toolsCost <= opts.budgetTokens * 0.75) {
    const linked = new Set(all.flatMap((t) => sampleResourcesOf(t, resources)));
    const order = [...resources.filter((r) => linked.has(r)), ...resources.filter((r) => !linked.has(r))];
    const samples: GeneratorCategoryInput['samples'] = {};
    let used = toolsCost;
    for (const r of order) {
      const c = estimateTokens(opts.samples[r]);
      if (used + c > opts.budgetTokens) continue;
      samples[r] = opts.samples[r]!;
      used += c;
    }
    return { tools: all, otherTools: [], samples, estimatedTokens: used };
  }

  const focus = new Set(tokens(opts.instructions ?? ''));
  const rand = mulberry32(opts.seed);
  const score = (t: GenTool): number => {
    let s = 0;
    if (focus.size) {
      const words = tokens(`${t.name} ${t.title ?? ''} ${t.description.slice(0, 300)}`);
      s += Math.min(3, words.filter((w) => focus.has(w)).length) * 2;
    }
    if (sampleResourcesOf(t, resources).length) s += 2;
    // single tasks are lookups; multi tasks chain reads into a write; impossible tasks need little detail
    if (opts.category === 'single' && !t.write) s += 1;
    if (opts.category === 'multi') s += t.write ? 0.5 : 1;
    return s;
  };
  // seeded order inside each group, groups interleaved round-robin (diversity), then a stable sort by
  // score: focused/sampled tools first, ties keep the interleaved order
  const groups = new Map<string, GenTool[]>();
  for (const t of shuffle(all, rand)) groups.set(groupOf(t), [...(groups.get(groupOf(t)) ?? []), t]);
  // groups interleaved by importance (topicWeights): a weighted draw picks the group of each next tool
  const weights = topicWeights(all);
  const live = new Map([...groups.keys()].map((g) => [g, weights.get(g) ?? 1]));
  const interleaved: GenTool[] = [];
  while (live.size) {
    const g = draw(live, rand)!;
    const ts = groups.get(g)!;
    interleaved.push(ts.shift()!);
    if (!ts.length) live.delete(g);
  }
  const ranked = interleaved.map((t, i) => ({ t, i, s: score(t) })).sort((a, b) => b.s - a.s || a.i - b.i).map((x) => x.t);

  const catalogAll: CatalogEntry[] = all.map((t) => ({ name: t.name, ...(t.title ? { title: t.title.slice(0, 80) } : {}), ...(t.write ? { write: true } : {}) }));
  // the catalog gets at most a quarter of the budget; very large APIs list a seeded share of the names
  let catalog = catalogAll;
  while (catalog.length > 0 && estimateTokens(catalog) > opts.budgetTokens / 4) catalog = catalog.filter((_, i) => i % 2 === 0);
  let used = estimateTokens(catalog);
  const picked: GenTool[] = [];
  const pickedSamples: GeneratorCategoryInput['samples'] = {};
  const sampleBudget = opts.budgetTokens / 4;
  let sampleUsed = 0;
  const maxTools = opts.category === 'impossible' ? 12 : 60;
  for (const t of ranked) {
    if (picked.length >= maxTools) break;
    const cost = estimateTokens(t);
    if (used + cost > opts.budgetTokens - sampleBudget) continue;
    picked.push(t);
    used += cost;
    for (const r of sampleResourcesOf(t, resources)) {
      if (pickedSamples[r]) continue;
      const c = estimateTokens(opts.samples[r]);
      if (sampleUsed + c > sampleBudget) continue;
      pickedSamples[r] = opts.samples[r]!;
      sampleUsed += c;
    }
  }
  const pickedNames = new Set(picked.map((t) => t.name));
  const otherTools = catalog.filter((c) => !pickedNames.has(c.name));
  return { tools: picked, otherTools, samples: pickedSamples, estimatedTokens: estimateTokens(picked) + estimateTokens(otherTools) + sampleUsed };
}
