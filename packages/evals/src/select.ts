/**
 * Generator input selection (cost and scope of suite generation). Sending every tool schema on every
 * generator call does not scale: GitHub's 1281 tools are ~516k tokens per call. Each category call
 * gets a token budget; tools are ranked (relevance to the operator instructions, tools with mock
 * sample data, the category's read/write mix; ties interleave tool groups in a seeded order), and sent with full schemas until the budget is used; every other tool is listed by name only
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

function groupOf(t: GenTool): string {
  if (t.group) return t.group;
  const i = t.name.indexOf('_');
  return i > 0 ? t.name.slice(0, i) : t.name;
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
  const interleaved: GenTool[] = [];
  for (let round = 0, more = true; more; round++) {
    more = false;
    for (const ts of groups.values()) {
      const t = ts[round];
      if (t) {
        interleaved.push(t);
        more = true;
      }
    }
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
