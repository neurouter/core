import { Assertion, ASSERTION_TYPES, EvalCategory, type ReferenceCall } from '@neurouter/shared';
import { GENERATOR_MARKER, GENERATOR_PROMPT_VERSION, GENERATOR_SYSTEM, markerMessage } from './prompts.js';
import { parseJsonText, textOf, type LlmClient } from './llm/types.js';
import { stampToolKeys } from './tool-identity.js';
import type { EvalTask, GeneratedTask, GeneratorCategoryInput, GenTool } from './types.js';

export const DEFAULT_COUNTS: Record<EvalCategory, number> = { single: 8, multi: 8, ambiguous: 4, impossible: 4 };
export const QUICK_COUNTS: Record<EvalCategory, number> = { single: 4, multi: 4, ambiguous: 2, impossible: 2 };

/** JSON Schema for `output_config.format` (GeneratedTasks). Assertions stay loose here and are validated with zod. */
export const GENERATED_TASKS_SCHEMA = {
  type: 'object',
  properties: {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          category: { type: 'string', enum: EvalCategory.options },
          prompt: { type: 'string' },
          rubric: { type: 'string' },
          assertions: { type: 'array', items: { type: 'object' } },
          reference_calls: { type: 'array', items: { type: 'object', properties: { tool: { type: 'string' }, arguments: { type: 'object' } }, required: ['tool', 'arguments'] } },
          seed_state: { type: 'object' },
        },
        required: ['key', 'category', 'prompt', 'rubric', 'assertions', 'reference_calls'],
      },
    },
  },
  required: ['tasks'],
} as const;

export interface ReferenceOutcome {
  ok: boolean;
  error?: string;
}

export interface GenerateSuiteOptions {
  llm: LlmClient;
  model: string;
  server: GeneratorCategoryInput['server'];
  /** Visible tools of the build (hidden tools excluded by the caller). */
  tools: GenTool[];
  samples: GeneratorCategoryInput['samples'];
  counts?: Partial<Record<EvalCategory, number>>;
  instructions?: string | null;
  seed?: number;
  /** Runs reference calls against a fresh mock state through the real pipeline (eval principal). */
  executeReference?: (calls: ReferenceCall[], task: GeneratedTask) => Promise<ReferenceOutcome[]>;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

export interface GenerateDiagnostic {
  category: EvalCategory;
  key: string | null;
  message: string;
}

export interface GeneratedSuite {
  tasks: EvalTask[];
  diagnostics: GenerateDiagnostic[];
  generator: { model: string; promptVersion: string; seed: number; counts: Record<EvalCategory, number>; provider: string };
}

/** §15.2: one Messages call per category, deterministic validation, one regeneration round with errors appended. */
export async function generateSuite(opts: GenerateSuiteOptions): Promise<GeneratedSuite> {
  const counts = { ...DEFAULT_COUNTS, ...(opts.counts ?? {}) };
  const seed = opts.seed ?? 42;
  const tasks: EvalTask[] = [];
  const diagnostics: GenerateDiagnostic[] = [];
  const seen = new Set<string>();
  const cats = EvalCategory.options.filter((c) => counts[c] > 0);
  let done = 0;
  for (const category of cats) {
    let errors: string[] = [];
    let accepted: EvalTask[] = [];
    for (let round = 0; round < 2; round++) {
      const input: GeneratorCategoryInput = {
        category,
        count: counts[category] - accepted.length,
        server: opts.server,
        tools: opts.tools,
        samples: opts.samples,
        instructions: opts.instructions ?? null,
        seed: seed + round,
        ...(errors.length ? { previousErrors: errors } : {}),
      };
      if (input.count <= 0) break;
      let raw: GeneratedTask[];
      try {
        raw = await callGenerator(opts, input);
      } catch (err) {
        if (isKeyError(err)) throw err;
        errors = [`generation failed: ${(err as Error).message}`];
        if (round === 1) diagnostics.push({ category, key: null, message: errors[0]! });
        continue;
      }
      errors = [];
      const roundFailures: GenerateDiagnostic[] = [];
      for (const g of raw.slice(0, input.count)) {
        const v = await validateGenerated(g, category, opts, seen);
        if (v.ok) {
          accepted.push(v.task);
          seen.add(normPrompt(v.task.prompt));
        } else {
          errors.push(`${g.key ?? '?'}: ${v.errors.join('; ')}`);
          roundFailures.push({ category, key: g.key ?? null, message: v.errors.join('; ') });
        }
      }
      if (round === 1) diagnostics.push(...roundFailures);
      if (accepted.length >= counts[category] || !errors.length) break;
    }
    accepted = dedupeKeys(accepted, tasks);
    tasks.push(...accepted);
    opts.onProgress?.(++done, cats.length);
  }
  return { tasks, diagnostics, generator: { model: opts.model, promptVersion: GENERATOR_PROMPT_VERSION, seed, counts, provider: opts.llm.provider } };
}

async function callGenerator(opts: GenerateSuiteOptions, input: GeneratorCategoryInput): Promise<GeneratedTask[]> {
  const res = await opts.llm.create(
    {
      model: opts.model,
      max_tokens: 16000,
      system: GENERATOR_SYSTEM,
      messages: [
        {
          role: 'user',
          content: markerMessage(
            GENERATOR_MARKER,
            GENERATOR_PROMPT_VERSION,
            input,
            `Write ${input.count} tasks of category "${input.category}" for the ${input.server.name} API.${input.instructions ? `\nOperator instructions: ${input.instructions}` : ''}${input.previousErrors ? `\nThe previous attempt had these problems; fix them:\n- ${input.previousErrors.join('\n- ')}` : ''}`,
          ),
        },
      ],
      output_config: { effort: 'high', format: { type: 'json_schema', schema: GENERATED_TASKS_SCHEMA as unknown as Record<string, unknown> } },
    },
    opts.signal ? { signal: opts.signal } : {},
  );
  const parsed = parseJsonText(textOf(res)) as { tasks?: unknown };
  if (!Array.isArray(parsed.tasks)) throw new Error('generator returned no tasks array');
  return parsed.tasks as GeneratedTask[];
}

function isKeyError(err: unknown): boolean {
  return (err as { name?: string })?.name === 'LlmKeyError';
}

export function normPrompt(p: string): string {
  return p.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * Models often write the DSL keyed by type (`{"called":{"tool":"x"}}`, `{"max_calls":1}`, `{"no_writes":true}`,
 * `{"framing":"…"}`) instead of `{"type":"called",…}`, and put the arguments to match in `argsMatch`; rewrite those
 * forms before validation.
 */
export function normalizeAssertion(a: unknown): unknown {
  const typed = normalizeKeyed(a);
  // `called {tool,args?,argsMatch?}` is often read as "argsMatch: the arguments to match"
  if (typed && typeof typed === 'object' && (typed as Record<string, unknown>).type === 'called') {
    const c = typed as Record<string, unknown>;
    if (c.argsMatch && typeof c.argsMatch === 'object' && !Array.isArray(c.argsMatch) && c.args === undefined) {
      const { argsMatch, ...rest } = c;
      return { ...rest, args: argsMatch };
    }
  }
  return typed;
}

function normalizeKeyed(a: unknown): unknown {
  if (!a || typeof a !== 'object' || Array.isArray(a) || 'type' in a) return a;
  const entries = Object.entries(a as Record<string, unknown>);
  if (entries.length !== 1) return a;
  const [type, v] = entries[0]!;
  if (!(ASSERTION_TYPES as readonly string[]).includes(type)) return a;
  if (v && typeof v === 'object' && !Array.isArray(v)) return { type, ...(v as Record<string, unknown>) };
  if (type === 'max_calls' && typeof v === 'number') return { type, n: v };
  if (type === 'answer_matches' && typeof v === 'string') return { type, regex: v };
  if (type === 'judge' && typeof v === 'string') return { type, criterion: v };
  if (type === 'answer_contains' && (typeof v === 'string' || Array.isArray(v))) return { type, anyOf: Array.isArray(v) ? v : [v] };
  if (type === 'called' || type === 'not_called') return typeof v === 'string' ? { type, tool: v } : a;
  return { type };
}

/** Deterministic validation (§15.2 step 4). */
export async function validateGenerated(
  g: GeneratedTask,
  category: EvalCategory,
  opts: Pick<GenerateSuiteOptions, 'tools' | 'executeReference'>,
  seen: Set<string>,
): Promise<{ ok: true; task: EvalTask } | { ok: false; errors: string[] }> {
  const errors: string[] = [];
  if (!g || typeof g !== 'object') return { ok: false, errors: ['not an object'] };
  if (typeof g.prompt !== 'string' || !g.prompt.trim()) errors.push('empty prompt');
  const assertions: Assertion[] = [];
  for (const a of Array.isArray(g.assertions) ? g.assertions : []) {
    const p = Assertion.safeParse(normalizeAssertion(a));
    if (p.success) assertions.push(p.data);
    else errors.push(`invalid assertion ${JSON.stringify(a).slice(0, 120)}`);
  }
  const visible = new Set(opts.tools.map((t) => t.name));
  // models sometimes use the code-mode name (`<namespace>.<function>`); map it back to the tool name
  const byPy = new Map(opts.tools.map((t) => [t.pyName, t.name]));
  const canon = (t: string): string => {
    if (visible.has(t) || !t.includes('.')) return t;
    const tail = t.slice(t.lastIndexOf('.') + 1);
    return byPy.get(t) ?? (visible.has(tail) ? tail : t);
  };
  for (const a of assertions) if (a.type === 'called' || a.type === 'not_called') a.tool = canon(a.tool);
  const refs: ReferenceCall[] = Array.isArray(g.reference_calls) ? g.reference_calls.filter((r) => r && typeof r.tool === 'string').map((r) => ({ tool: canon(r.tool), arguments: r.arguments && typeof r.arguments === 'object' ? r.arguments : {} })) : [];
  const isKnown = (t: string) => visible.has(t) || t.startsWith('neurouter_') || t === 'search_tools' || t === 'call_tool' || t === 'run_script';
  for (const a of assertions) if ((a.type === 'called' || a.type === 'not_called') && !isKnown(a.tool)) errors.push(`unknown tool ${a.tool}`);
  for (const r of refs) if (!visible.has(r.tool)) errors.push(`unknown reference tool ${r.tool}`);
  if (category === 'impossible') {
    if (assertions.some((a) => a.type === 'called')) errors.push('impossible tasks must not have called assertions');
    if (!assertions.some((a) => a.type === 'unmet_need_reported_or_declined')) errors.push('impossible tasks need unmet_need_reported_or_declined');
  }
  if ((category === 'single' || category === 'multi') && !refs.length) errors.push('reference_calls required');
  if (typeof g.prompt === 'string' && seen.has(normPrompt(g.prompt))) errors.push('duplicate prompt');
  if (!assertions.some((a) => a.type === 'framing')) assertions.push({ type: 'framing' });
  if (!errors.length && (category === 'single' || category === 'multi') && opts.executeReference) {
    const outcomes = await opts.executeReference(refs, g);
    outcomes.forEach((o, i) => {
      if (!o.ok) errors.push(`reference call ${refs[i]?.tool ?? i} failed: ${o.error ?? 'error'}`);
    });
  }
  if (errors.length) return { ok: false, errors };
  const keyed = opts.tools.filter((t): t is GenTool & { key: string } => typeof t.key === 'string');
  const task: EvalTask = {
    key: slugKey(g.key || `${category}-${normPrompt(g.prompt).slice(0, 30)}`),
    category,
    prompt: g.prompt.trim(),
    rubric: typeof g.rubric === 'string' ? g.rubric : '',
    assertions,
    referenceCalls: refs,
    seedState: g.seed_state ?? null,
    tags: Array.isArray(g.tags) ? g.tags.map(String) : [],
    enabled: true,
  };
  return { ok: true, task: keyed.length ? stampToolKeys(task, keyed) : task };
}

function slugKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'task';
}

function dedupeKeys(tasks: EvalTask[], existing: EvalTask[]): EvalTask[] {
  const used = new Set(existing.map((t) => t.key));
  return tasks.map((t) => {
    let k = t.key;
    for (let i = 2; used.has(k); i++) k = `${t.key}-${i}`;
    used.add(k);
    return { ...t, key: k };
  });
}
