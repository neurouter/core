import { describe, expect, it } from 'vitest';
import { generateSuite } from '../generate.js';
import { buildReport, renderMarkdown, renderTable } from '../report.js';
import { runSuite } from '../run.js';
import { scoreRun } from '../score.js';
import { fakePetstore } from '../test/fixtures.js';
import type { GenTool } from '../types.js';
import { argsFor, parseKv, STUB_MODEL, StubLlmClient, stubGenerate } from './stub.js';

const tools: GenTool[] = [
  { name: 'list_pets', description: 'List pets in the store.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } }, write: false },
  { name: 'get_pet_by_id', description: 'Find a pet by its ID.', inputSchema: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] }, write: false },
  { name: 'add_pet', description: 'Add a new pet to the store.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] }, write: true },
];
const samples = { pets: [{ id: 1, name: 'Rex', status: 'available' }] };

describe('stub provider', () => {
  it('generator is deterministic and uses sample values', () => {
    const input = { category: 'single' as const, count: 3, server: { name: 'Petstore', slug: 'petstore' }, tools, samples, seed: 42 };
    const a = stubGenerate(input);
    expect(stubGenerate(input)).toEqual(a);
    expect(a).toHaveLength(2 < tools.length ? 3 : 2);
    expect(argsFor(tools[1]!, samples)).toEqual({ petId: 1 });
    const imp = stubGenerate({ ...input, category: 'impossible', count: 2 });
    expect(imp.every((t) => t.assertions.some((x) => x.type === 'unmet_need_reported_or_declined'))).toBe(true);
  });

  it('parses key=value pairs', () => {
    expect(parseKv('Find it (use petId=1, name="Rex Jr", ok=true)')).toEqual({ petId: 1, name: 'Rex Jr', ok: true });
  });

  it('end to end: generate + run (tool and code mode) + score + report, deterministically', async () => {
    const run = async () => {
      const llm = new StubLlmClient();
      const suite = await generateSuite({ llm, model: STUB_MODEL, server: { name: 'Petstore', slug: 'petstore' }, tools, samples, counts: { single: 2, multi: 2, ambiguous: 1, impossible: 1 }, seed: 1 });
      const results = await runSuite({ llm, tasks: suite.tasks, models: [STUB_MODEL], modes: ['tool', 'code'], repeats: 1, concurrency: 1, openSession: async (ctx) => {
          const mcp = fakePetstore({ mode: ctx.mode });
          // the server supplies the audit view, which includes calls made inside run_script
          return { mcp, collectCalls: async () => mcp.calls.map((c) => ({ tool: c.name, arguments: c.args, status: 'ok', decision: 'allowed', via: 'eval', write: c.name === 'add_pet' })) };
        },
      });
      const score = scoreRun({ tasks: suite.tasks, results, models: [STUB_MODEL], modes: ['tool', 'code'], lintScore: 70 });
      return { suite, results, score };
    };
    const a = await run();
    const b = await run();
    expect(a.suite.tasks.map((t) => t.key)).toEqual(b.suite.tasks.map((t) => t.key));
    expect(a.score.headline).toBe(b.score.headline);
    // the second multi task differs from the first only in wording: rejected as a near-duplicate (twice)
    expect(a.suite.tasks.map((t) => t.category)).toEqual(['single', 'single', 'multi', 'ambiguous', 'impossible']);
    expect(a.suite.diagnostics.some((d) => d.category === 'multi' && d.message.includes('duplicate'))).toBe(true);
    expect(a.suite.generator.coverage).toBeTruthy();
    const byMode = (m: string) => a.results.filter((r) => r.mode === m);
    expect(byMode('tool').filter((r) => r.passed).length).toBeGreaterThanOrEqual(4);
    expect(byMode('code').filter((r) => r.category === 'single' && r.passed).length).toBe(2);
    expect(a.results.every((r) => r.servedByModel === STUB_MODEL)).toBe(true);
    expect(a.score.headline).toBeGreaterThan(50);
    expect(a.score.cells).toHaveLength(2);
    const rep = buildReport({
      server: { slug: 'petstore', name: 'Petstore' },
      run: { id: null, models: [STUB_MODEL], modes: ['tool', 'code'], repeats: 1, environment: 'mock', buildHash: null, provider: 'stub', startedAt: 'x', endedAt: 'y' },
      score: a.score,
      suggestions: [],
      results: a.results,
      prompts: Object.fromEntries(a.suite.tasks.map((t) => [t.key, { category: t.category, prompt: t.prompt }])),
    });
    expect(renderMarkdown(rep)).toContain(`**${a.score.headline}/100**`);
    expect(renderMarkdown(rep)).toContain('stub provider');
    expect(renderTable(rep)).toContain('Headline:');
  });
});
