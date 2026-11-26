import { describe, expect, it } from 'vitest';
import { clusterFailures, opsToOverlayYaml, predictedDelta, selectVerifyTasks, suggest, type SuggestTool } from './suggest.js';
import { ScriptedLlmClient, llmResponse } from './llm/fake.js';
import { call, result, task } from './test/fixtures.js';

const tools: SuggestTool[] = [
  { name: 'get_pet_by_id', key: 'operationId:getPetById', description: 'Find pet by ID.', inputSchema: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] }, hidden: false, tags: [], write: false, sourceRef: { method: 'GET', path: '/pet/{petId}' } },
  { name: 'list_pets', key: 'operationId:findPets', description: 'List pets.', inputSchema: { type: 'object', properties: {} }, hidden: false, tags: [], write: false, sourceRef: { method: 'GET', path: '/pet' } },
  { name: 'send_newsletter', key: 'operationId:send', description: 'Send newsletter emails.', inputSchema: { type: 'object', properties: {} }, hidden: true, tags: [], write: true },
];
const tasks = [
  task({ key: 'a', prompt: 'Get pet 1', assertions: [{ type: 'called', tool: 'get_pet_by_id' }], referenceCalls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 } }] }),
  task({ key: 'b', prompt: 'Get pet 2', assertions: [{ type: 'called', tool: 'get_pet_by_id' }], referenceCalls: [{ tool: 'get_pet_by_id', arguments: { petId: 2 } }] }),
  task({ key: 'c', prompt: 'Email the newsletter' }),
  task({ key: 'd', prompt: 'ok' }),
];
const fails = [
  result({ taskKey: 'a', passed: false, failureCause: 'wrong_tool', primaryTool: 'get_pet_by_id', calls: [call('list_pets')] }),
  result({ taskKey: 'a', attempt: 2, passed: false, failureCause: 'wrong_tool', primaryTool: 'get_pet_by_id', calls: [call('list_pets')] }),
  result({ taskKey: 'b', passed: false, failureCause: 'bad_arguments', primaryTool: 'get_pet_by_id', calls: [call('get_pet_by_id', { petId: 'two' })] }),
  result({ taskKey: 'c', passed: false, failureCause: 'missing_capability', primaryTool: null, calls: [call('neurouter_report_unmet_need', { intent: 'send newsletter' })] }),
  result({ taskKey: 'd', passed: false, failureCause: 'no_framing' }),
];

describe('suggest', () => {
  it('clusters by (cause, primary tool), skipping non-actionable causes', () => {
    const c = clusterFailures(fails);
    expect(c.map((x) => `${x.cause}|${x.tool}`)).toEqual(['wrong_tool|get_pet_by_id', 'bad_arguments|get_pet_by_id', 'missing_capability|null']);
    expect(c[0]!.results).toHaveLength(2);
  });

  it('proposes describe/example/unhide patches, validates them and predicts deltas', async () => {
    const validated: string[] = [];
    const out = await suggest({
      results: fails,
      tasks,
      tools,
      validatePatch: async (y) => {
        validated.push(y);
        return { ok: !y.includes('INVALID'), diagnostics: [] };
      },
      findHiddenTool: async (intent) => (intent.includes('newsletter') ? 'send_newsletter' : null),
    });
    expect(out.map((s) => s.kind).sort()).toEqual(['describe', 'example', 'hide']);
    const d = out.find((s) => s.kind === 'describe')!;
    expect(d.tools).toEqual(['get_pet_by_id', 'list_pets']);
    expect(d.overlayPatch).toContain('"operationId:getPetById":');
    expect(d.overlayPatch).toContain('description:');
    expect(JSON.parse(d.specPatch!)[0]).toMatchObject({ op: 'add', path: '/paths/~1pet~1{petId}/get/description' });
    expect(d.predictedDelta).toBe(predictedDelta(1, 4));
    const ex = out.find((s) => s.kind === 'example')!;
    expect(ex.overlayPatch).toContain('petId: 2');
    expect(ex.overlayOps.some((o) => o.op === 'set' && o.field === 'args')).toBe(true);
    const h = out.find((s) => s.kind === 'hide')!;
    expect(h.overlayPatch).toContain('hidden: false');
    expect(validated).toHaveLength(3);
  });

  it('drops patches that fail validation', async () => {
    const out = await suggest({ results: fails, tasks, tools, validatePatch: async () => ({ ok: false, diagnostics: ['x'] }) });
    expect(out).toEqual([]);
  });

  it('uses LLM text when available', async () => {
    const llm = new ScriptedLlmClient([], () => llmResponse([{ type: 'text', text: JSON.stringify({ descriptions: { get_pet_by_id: 'Get one pet by its numeric id. Use list_pets to browse.' }, rationale: 'LLM said so' }) }]));
    const out = await suggest({ results: fails.slice(0, 2), tasks, tools, llm, model: 'm', validatePatch: async () => ({ ok: true, diagnostics: [] }) });
    expect(out[0]!.rationale).toBe('LLM said so');
    expect(out[0]!.overlayPatch).toContain('Get one pet by its numeric id');
  });

  it('toolset too big → hide by default + pins', async () => {
    const many = ['x', 'y', 'z'].map((t, i) => result({ taskKey: `t${i}`, passed: false, failureCause: 'wrong_tool', primaryTool: t, calls: [call('list_pets')] }));
    const out = await suggest({
      results: many,
      tasks: [task({ key: 't0', referenceCalls: [{ tool: 'get_pet_by_id', arguments: {} }] })],
      tools,
      lint: { rules: [{ rule: 'toolset_size', weight: 15, score: 0, passed: false, detail: '' }] },
      validatePatch: async () => ({ ok: true, diagnostics: [] }),
    });
    const h = out.find((s) => s.cause === 'toolset_size')!;
    expect(h.overlayPatch).toMatch(/defaults:\n {2}hidden: true/);
    expect(h.overlayPatch).toContain('pinned: true');
  });

  it('selectVerifyTasks is deterministic and includes ~20% of passing tasks', () => {
    const passing = Array.from({ length: 10 }, (_, i) => `p${i}`);
    const a = selectVerifyTasks(['a'], passing, 0.2, 7);
    expect(a).toHaveLength(3);
    expect(a[0]).toBe('a');
    expect(selectVerifyTasks(['a'], passing, 0.2, 7)).toEqual(a);
  });

  it('renders overlay YAML', () => {
    expect(opsToOverlayYaml([{ op: 'set', selector: 'GET /pets', field: 'hidden', value: false }])).toBe('overlay: 1\ntools:\n  "GET /pets":\n    hidden: false\n');
  });
});
