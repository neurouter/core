import { describe, expect, it } from 'vitest';
import { generateSuite, normalizeAssertion, validateGenerated } from './generate.js';
import { estimateTokens, selectGeneratorInput } from './select.js';
import { readMarkerInput, GENERATOR_MARKER } from './prompts.js';
import type { GeneratorCategoryInput } from './types.js';
import { ScriptedLlmClient, llmResponse } from './llm/fake.js';
import { LlmKeyError } from './llm/types.js';
import type { GenTool } from './types.js';

const tools: GenTool[] = [
  { name: 'get_pet_by_id', description: 'Find pet by ID.', inputSchema: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] }, write: false },
  { name: 'list_pets', description: 'List pets.', inputSchema: { type: 'object', properties: {} }, write: false },
];
const json = (tasks: unknown[]) => llmResponse([{ type: 'text', text: JSON.stringify({ tasks }) }]);
const single = (key: string, tool = 'get_pet_by_id', prompt = `Get pet ${key}`) => ({ key, category: 'single', prompt, rubric: 'r', assertions: [{ type: 'called', tool }], reference_calls: [{ tool, arguments: { petId: 1 } }] });

describe('generateSuite', () => {
  it('one call per category with the structured-output schema; adds framing; dedupes prompts', async () => {
    const llm = new ScriptedLlmClient([
      json([single('a'), single('b', 'get_pet_by_id', 'Get pet a')]),
      json([]),
      json([{ key: 'imp', category: 'impossible', prompt: 'Send SMS', rubric: 'r', assertions: [{ type: 'unmet_need_reported_or_declined' }], reference_calls: [] }]),
    ]);
    const s = await generateSuite({ llm, model: 'claude-sonnet-5-5', server: { name: 'Petstore', slug: 'petstore' }, tools, samples: {}, counts: { single: 2, multi: 0, ambiguous: 0, impossible: 1 }, seed: 3 });
    expect(llm.requests[0]!.output_config?.format?.type).toBe('json_schema');
    expect(llm.requests[0]!.max_tokens).toBe(16000);
    expect(llm.requests[0]!.tool_choice).toBeUndefined();
    expect(s.tasks.map((t) => t.key)).toEqual(['a', 'imp']);
    expect(s.tasks[0]!.assertions).toContainEqual({ type: 'framing' });
    // budgets are derived from the reference path (1 call → the floor of 3)
    expect(s.tasks[0]!.assertions).toContainEqual({ type: 'max_calls', n: 3 });
    expect(String(llm.requests[1]!.messages[0]!.content)).toContain('duplicate prompt');
    expect(s.generator).toMatchObject({ seed: 3, promptVersion: 'gen-3', mockDataVersion: 2 });
  });

  it('regenerates once with the errors appended, then drops with a diagnostic', async () => {
    const llm = new ScriptedLlmClient([json([single('bad', 'nope')]), json([single('bad2', 'nope2')])]);
    const s = await generateSuite({ llm, model: 'm', server: { name: 'P', slug: 'p' }, tools, samples: {}, counts: { single: 1, multi: 0, ambiguous: 0, impossible: 0 } });
    expect(s.tasks).toEqual([]);
    expect(String(llm.requests[1]!.messages[0]!.content)).toContain('unknown tool nope');
    expect(s.diagnostics[0]!.message).toContain('unknown tool nope2');
  });

  it('executes reference calls and rejects tasks whose calls fail; enforces impossible rules', async () => {
    const llm = new ScriptedLlmClient([json([single('a'), single('b')]), json([]), json([{ key: 'imp', category: 'impossible', prompt: 'x', rubric: '', assertions: [{ type: 'called', tool: 'list_pets' }], reference_calls: [] }]), json([])]);
    const s = await generateSuite({
      llm,
      model: 'm',
      server: { name: 'P', slug: 'p' },
      tools,
      samples: {},
      counts: { single: 2, multi: 0, ambiguous: 0, impossible: 1 },
      executeReference: async (_calls, t) => [{ ok: t.key === 'a', error: 'not found' }],
    });
    expect(s.tasks.map((t) => t.key)).toEqual(['a']);
    expect(String(llm.requests[2]!.messages[0]!.content)).toContain('impossible');
    expect(s.diagnostics.some((d) => d.message.includes('must not have called'))).toBe(false); // second round returned nothing
  });

  it('propagates key errors', async () => {
    const llm = new ScriptedLlmClient([new LlmKeyError()]);
    await expect(generateSuite({ llm, model: 'm', server: { name: 'P', slug: 'p' }, tools, samples: {}, counts: { single: 1, multi: 0, ambiguous: 0, impossible: 0 } })).rejects.toBeInstanceOf(LlmKeyError);
  });
});

describe('normalizeAssertion', () => {
  it('rewrites the keyed form models produce into the typed DSL', () => {
    expect(normalizeAssertion({ called: { tool: 'meta_get_zen', args: {}, minTimes: 1 } })).toEqual({ type: 'called', tool: 'meta_get_zen', args: {}, minTimes: 1 });
    expect(normalizeAssertion({ max_calls: 1 })).toEqual({ type: 'max_calls', n: 1 });
    expect(normalizeAssertion({ no_writes: true })).toEqual({ type: 'no_writes' });
    expect(normalizeAssertion({ framing: 'Answer with the Zen of GitHub.' })).toEqual({ type: 'framing' });
    expect(normalizeAssertion({ answer_contains: 'octocat' })).toEqual({ type: 'answer_contains', anyOf: ['octocat'] });
    expect(normalizeAssertion({ type: 'no_writes' })).toEqual({ type: 'no_writes' });
    expect(normalizeAssertion({ bogus: 1 })).toEqual({ bogus: 1 });
    expect(normalizeAssertion({ called: { tool: 'issues_get', argsMatch: { owner: 'octocat', issue_number: 1 }, minTimes: 1 } })).toEqual({ type: 'called', tool: 'issues_get', args: { owner: 'octocat', issue_number: 1 }, minTimes: 1 });
    expect(normalizeAssertion({ type: 'called', tool: 'x', args: { a: 1 }, argsMatch: 'exact' })).toEqual({ type: 'called', tool: 'x', args: { a: 1 }, argsMatch: 'exact' });
  });
});

describe('validateGenerated', () => {
  it('maps code-mode names (<namespace>.<function>) back to tool names', async () => {
    const g = { key: 'k', category: 'multi', prompt: 'List pets, then get pet 1', rubric: 'r', assertions: [{ type: 'called', tool: 'api.list_pets' }, { type: 'framing' }], reference_calls: [{ tool: 'api.list_pets', arguments: {} }, { tool: 'get_pet_by_id', arguments: { petId: 1 } }] };
    const v = await validateGenerated(g as never, 'multi', { tools, executeReference: async (calls) => calls.map(() => ({ ok: true })) }, new Set());
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.task.assertions[0]).toEqual({ type: 'called', tool: 'list_pets' });
      expect(v.task.referenceCalls?.map((r) => r.tool)).toEqual(['list_pets', 'get_pet_by_id']);
    }
  });
});

describe('generator scope and budget (large APIs)', () => {
  // 1,200 tools × ~1.6k tokens of schema each ≈ 2M tokens if sent whole (GitHub: 1281 tools, ~516k tokens)
  const big: GenTool[] = Array.from({ length: 1200 }, (_, i) => {
    const group = ['issues', 'pulls', 'repos', 'actions', 'billing', 'teams'][i % 6]!;
    return {
      name: `${group}_op_${i}`,
      title: `Operation ${i}`,
      description: `Does ${group} thing ${i}. ${'Long description. '.repeat(20)}`,
      inputSchema: { type: 'object', properties: Object.fromEntries(Array.from({ length: 12 }, (_, k) => [`arg_${k}`, { type: 'string', description: 'x'.repeat(300) }])) },
      write: i % 3 === 0,
      key: `operationId:${group}/op-${i}`,
      group,
      path: `/repos/{owner}/{repo}/${group}/${i}`,
    };
  });
  const promptOf = (req: { messages: Array<{ content: unknown }> }) => readMarkerInput(String(req.messages[0]!.content), GENERATOR_MARKER) as GeneratorCategoryInput;

  it('sends a budgeted subset with schemas plus a names-only catalog, and reports usage', async () => {
    const ok = (t: GenTool) => ({ key: `k-${t.name}`, category: 'single', prompt: `Run ${t.name}`, rubric: '', assertions: [{ type: 'called', tool: t.name }], reference_calls: [{ tool: t.name, arguments: {} }] });
    const llm = new ScriptedLlmClient([], (req) => {
      const input = promptOf(req);
      return llmResponse([{ type: 'text', text: JSON.stringify({ tasks: input.tools.slice(0, input.count).map(ok) }) }], { input: estimateTokens(req.messages), output: 500 });
    });
    const s = await generateSuite({ llm, model: 'm', server: { name: 'Big', slug: 'big' }, tools: big, samples: {}, counts: { single: 3, multi: 0, ambiguous: 0, impossible: 0 }, maxGeneratorTokens: 200_000, instructions: 'focus on issues' });
    expect(estimateTokens(big)).toBeGreaterThan(1_000_000);
    expect(llm.requests).toHaveLength(1);
    const input = promptOf(llm.requests[0]!);
    expect(input.tools.length).toBeGreaterThan(5);
    expect(input.tools.length).toBeLessThan(big.length);
    expect(input.otherTools!.length + input.tools.length).toBeLessThanOrEqual(big.length);
    expect(input.otherTools!.length).toBeGreaterThan(100);
    expect(input.tools.filter((t) => t.group === 'issues').length).toBeGreaterThan(input.tools.length / 3); // instructions focus
    expect(estimateTokens(llm.requests[0]!.messages)).toBeLessThanOrEqual(60_000 + 2_000);
    expect(s.tasks).toHaveLength(3);
    expect(s.tasks[0]!.assertions[0]).toMatchObject({ toolKey: expect.stringMatching(/^operationId:/) });
    expect(s.generator.usage).toMatchObject({ calls: 1, outputTokens: 500, budgetTokens: 200_000, visibleTools: 1200 });
    expect(s.generator.usage.totalTokens).toBe(s.generator.usage.inputTokens + 500);
  });

  it('stops with a diagnostic when the budget is used up', async () => {
    const llm = new ScriptedLlmClient([], () => llmResponse([{ type: 'text', text: JSON.stringify({ tasks: [] }) }], { input: 40_000, output: 1_000 }));
    const s = await generateSuite({ llm, model: 'm', server: { name: 'Big', slug: 'big' }, tools: big, samples: {}, counts: { single: 2, multi: 2, ambiguous: 0, impossible: 0 }, maxGeneratorTokens: 60_000 });
    expect(s.tasks).toEqual([]);
    expect(s.generator.usage.totalTokens).toBeLessThanOrEqual(60_000 + 41_000);
    expect(s.diagnostics.map((d) => d.message).join('\n')).toMatch(/budget exhausted|returned no tasks/);
    expect(s.diagnostics.some((d) => /budget exhausted/.test(d.message))).toBe(true);
  });

  it('sends small APIs whole (no catalog)', () => {
    const sel = selectGeneratorInput(tools, { category: 'single', budgetTokens: 20_000, seed: 1, samples: { '/pet': [{ id: 1 }] } });
    expect(sel.tools).toEqual(tools);
    expect(sel.otherTools).toEqual([]);
    expect(sel.samples).toEqual({ '/pet': [{ id: 1 }] });
  });
});

describe('generation with outcome-based checks (0.2.2)', () => {
  const session = { call: async (tool: string, args: Record<string, unknown>) => ({ tool, ok: true, data: tool === 'list_pets' ? [{ id: 1, name: 'Rex' }] : { id: args.petId, name: 'Rex', status: 'available' } }) };

  it('keeps required args, binds literals to the ground truth, calibrates, drops generator budgets, reports topics', async () => {
    const g = {
      key: 'pet',
      category: 'single',
      prompt: 'What is the status of pet 1?',
      rubric: 'r',
      assertions: [{ type: 'called', tool: 'get_pet_by_id', args: { petId: 1, limit: 5 } }, { type: 'answer_contains', anyOf: ['available'] }, { type: 'max_calls', n: 1 }],
      reference_calls: [{ tool: 'get_pet_by_id', arguments: { petId: 1, limit: 5 }, required_args: ['petId'] }],
    };
    const llm = new ScriptedLlmClient([json([g])]);
    const s = await generateSuite({ llm, model: 'm', server: { name: 'P', slug: 'p' }, tools, samples: {}, counts: { single: 1, multi: 0, ambiguous: 0, impossible: 0 }, openReference: async () => session });
    const t = s.tasks[0]!;
    expect(t.referenceCalls[0]!.required).toEqual(['petId']);
    expect(t.assertions).toContainEqual({ type: 'called', tool: 'get_pet_by_id', args: { petId: 1 }, incidental: { limit: 5 } });
    expect(t.assertions).toContainEqual({ type: 'answer_contains', from: 'ref[0].data.status', anyOf: ['available'] });
    expect(t.assertions).toContainEqual({ type: 'max_calls', n: 3 });
    expect(s.generator.calibration).toMatchObject({ passed: 1, mockDataVersion: 2 });
    expect(s.generator.coverage).toEqual({ get: 1 });
    const input = readMarkerInput(String(llm.requests[0]!.messages[0]!.content), GENERATOR_MARKER) as GeneratorCategoryInput;
    expect(input.topics).toHaveLength(1);
  });

  it('rejects (and regenerates) a task whose reference fails calibration, with the reason', async () => {
    const bad = { key: 'bad', category: 'single', prompt: 'Name pet 1', rubric: '', assertions: [{ type: 'answer_contains', anyOf: ['Bella'] }], reference_calls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 }, required_args: ['petId'] }] };
    const llm = new ScriptedLlmClient([json([bad]), json([{ ...bad, key: 'bad2', prompt: 'Name the pet with id 1' }])]);
    const s = await generateSuite({ llm, model: 'm', server: { name: 'P', slug: 'p' }, tools, samples: {}, counts: { single: 1, multi: 0, ambiguous: 0, impossible: 0 }, openReference: async () => session });
    expect(s.tasks).toEqual([]);
    expect(String(llm.requests[1]!.messages[0]!.content)).toContain('calibration: expected answer value ["Bella"] is not in the reference outcome');
    expect(s.diagnostics[0]!.message).toContain('calibration');
  });

  it('rejects near-duplicates (same reference path, or near-identical wording)', async () => {
    const a = { ...single('a'), prompt: 'Get pet 1 and tell me its name' };
    const b = { ...single('b'), prompt: 'Please get pet 1 and tell me the name' };
    const v1 = await validateGenerated(a as never, 'single', { tools }, new Set());
    expect(v1.ok).toBe(true);
    const v2 = await validateGenerated(b as never, 'single', { tools }, new Set(), [(v1 as unknown as { task: never }).task]);
    expect(v2).toMatchObject({ ok: false, errors: [expect.stringContaining('near-duplicate of task a')] });
  });

  it('reads alternatives and stamps them', async () => {
    const two: GenTool[] = [...tools, { name: 'find_pet', description: 'Find pet.', inputSchema: { type: 'object', properties: { petId: { type: 'integer' } } }, write: false, key: 'operationId:findPet' }];
    const g = { ...single('alt'), reference_calls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 }, required_args: ['petId'], alternatives: ['find_pet'] }] };
    const v = await validateGenerated(g as never, 'single', { tools: two }, new Set());
    const t = (v as { task: { referenceCalls: unknown[]; assertions: unknown[] } }).task;
    expect(t.referenceCalls[0]).toMatchObject({ alternatives: [{ tool: 'find_pet', toolKey: 'operationId:findPet' }] });
    expect(t.assertions[0]).toMatchObject({ type: 'called', anyOf: [{ tool: 'find_pet', toolKey: 'operationId:findPet' }] });
  });
});
