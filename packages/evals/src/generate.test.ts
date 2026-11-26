import { describe, expect, it } from 'vitest';
import { generateSuite, normalizeAssertion } from './generate.js';
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
    expect(s.tasks[0]!.assertions.at(-1)).toEqual({ type: 'framing' });
    expect(String(llm.requests[1]!.messages[0]!.content)).toContain('duplicate prompt');
    expect(s.generator).toMatchObject({ seed: 3, promptVersion: 'gen-1' });
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
