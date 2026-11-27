import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from './main.js';
import { checkSuiteLimits } from './commands/eval.js';

const ROOT = resolve(import.meta.dirname, '../../..');

async function run(args: string[]): Promise<{ code: number | undefined; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const error = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void err.push(a.join(' ')));
  process.exitCode = undefined;
  try {
    await buildProgram().exitOverride().parseAsync(['node', 'neurouter', ...args]);
  } finally {
    log.mockRestore();
    error.mockRestore();
  }
  const code = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { code, out: out.join('\n'), err: err.join('\n') };
}

afterEach(() => {
  delete process.env.NEUROUTER_EVAL_LLM;
});

describe('neurouter validate', () => {
  it('accepts the example config and reports per-server tool counts', async () => {
    const r = await run(['validate', '--config', join(ROOT, 'neurouter.example.yaml')]);
    expect(r.code).toBeUndefined();
    expect(r.out).toMatch(/petstore: 19 visible tools/);
  }, 30_000);

  it('exits 1 with file:line diagnostics on errors (literal secret, prod confirm none)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    const f = join(dir, 'neurouter.yaml');
    writeFileSync(f, `version: 1\nservers:\n  - slug: api\n    spec: { path: ${join(ROOT, 'examples/petstore/openapi.yaml')} }\n    environments:\n      - slug: prod\n        kind: prod\n        baseUrl: https://api.example.com\n        auth: { type: bearer, secret: hunter2 }\n        writes: { enabled: true, confirm: none }\n`);
    const r = await run(['validate', '--config', f]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/neurouter\.yaml:\d+:1: error: .*(Literal secrets|confirm)/);
  });

  it('prints failing lint rules; a curated example that does not run is an error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    writeFileSync(join(dir, 'o.overlay.yaml'), 'overlay: 1\ntools:\n  operationId:getOrder:\n    examples:\n      - arguments: { order_id: 12 }\n');
    const f = join(dir, 'neurouter.yaml');
    writeFileSync(f, `version: 1\nservers:\n  - slug: acme\n    name: Acme\n    spec: { path: ${join(ROOT, 'examples/acme-orders/openapi.yaml')} }\n    overlay: o.overlay.yaml\n    environments:\n      - { slug: dev, kind: dev, baseUrl: "mock:" }\n`);
    const r = await run(['validate', '--config', f]);
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/acme: lint example_runs \d+%/);
    expect(r.err).toMatch(/error: get_order: curated example \{"order_id":12\} fails: does not match the input schema: \/order_id must be string/);
    expect(r.err).toMatch(/1 curated example\(s\) do not run/);
    writeFileSync(join(dir, 'o.overlay.yaml'), 'overlay: 1\ntools:\n  operationId:getOrder:\n    examples:\n      - arguments: { order_id: order_2 }\n');
    const ok = await run(['validate', '--config', f]);
    expect(ok.code, ok.err).toBeUndefined();
    expect(ok.out).toMatch(/acme: lint has_more_without_cursor/);
  }, 30_000);

  it('--print-schema prints the JSON Schema', async () => {
    const r = await run(['validate', '--print-schema']);
    expect(JSON.parse(r.out)).toHaveProperty('properties.servers');
  });
});

describe('neurouter compile', () => {
  it('compiles petstore to 19 tools and writes petstore.pyi', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    const r = await run(['compile', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--namespace', 'petstore', '--stubs', dir, '--out', join(dir, 'tools.json')]);
    expect(r.out).toMatch(/19 tools \(19 visible/);
    expect(readFileSync(join(dir, 'petstore.pyi'), 'utf8')).toContain('def get_pet_by_id(*, pet_id: int)');
    expect(JSON.parse(readFileSync(join(dir, 'tools.json'), 'utf8')).tools).toHaveLength(19);
  });
});

describe('neurouter compile with an invalid overlay', () => {
  it.each([
    ['schema error', 'overlay: 2\n'],
    ['YAML syntax error', 'overlay: 1\ntools:\n  foo: [1\n'],
  ])('%s: exit 1, overlay diagnostics, no tools.json or stubs written', async (_name, overlay) => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    writeFileSync(join(dir, 'bad.overlay.yaml'), overlay);
    const r = await run(['compile', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--overlay', join(dir, 'bad.overlay.yaml'), '--namespace', 'petstore', '--stubs', join(dir, 'stubs'), '--out', join(dir, 'tools.json')]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/error: overlay_(invalid|yaml)/);
    expect(r.err).toMatch(/nothing was written/);
    expect(r.out).not.toMatch(/19 tools/);
    expect(existsSync(join(dir, 'tools.json'))).toBe(false);
    expect(existsSync(join(dir, 'stubs'))).toBe(false);
  });
});

describe('neurouter eval (in-process, stub provider)', () => {
  it('boots a server from --spec, generates and runs a suite, writes reports, exit 1 below --min-score', async () => {
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    process.env.NEUROUTER_EXECUTOR_MODE = 'local';
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    const r = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--generate', '--counts', '2,1,1,1', '--repeats', '1', '--modes', 'tool,code', '--min-score', '101', '--out', join(dir, 'r.json'), '--md', join(dir, 'r.md'), '--save-suite', join(dir, 's.json'), '--transcripts', join(dir, 't.json')]);
    delete process.env.NEUROUTER_EXECUTOR_MODE;
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/Headline: \d+\/100/);
    expect(r.err).toMatch(/generator usage: \d+ call\(s\), \d+ tokens .* of a 400000-token budget/);
    expect(r.out).toMatch(/Suite generation: \d+ tokens over \d+ call\(s\)/);
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as { score: { headline: number; cells: unknown[] }; run: { provider: string }; generator: { usage: { calls: number; totalTokens: number } } };
    expect(report.score.cells).toHaveLength(2);
    expect(report.generator.usage.calls).toBeGreaterThan(0);
    expect(report.generator.usage.totalTokens).toBeGreaterThan(0);
    expect(report.run.provider).toBe('stub');
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('stub provider');
    expect(existsSync(join(dir, 's.json'))).toBe(true);
    const attempts = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8')) as Array<{ mode: string; prompt: string; transcript: Array<{ kind: string }>; assertionResults: unknown[] }>;
    expect(attempts).toHaveLength(10);
    expect(attempts.every((a) => a.prompt && a.transcript[0]?.kind === 'user' && Array.isArray(a.assertionResults))).toBe(true);
    // --transcripts: untrimmed (the stored console copy keeps 4,096 chars per item)
    expect(JSON.stringify(attempts)).not.toContain('more characters trimmed');
    // the saved suite re-runs deterministically
    process.env.NEUROUTER_EXECUTOR_MODE = 'local';
    const again = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--suite', join(dir, 's.json'), '--repeats', '1', '--modes', 'tool,code', '--out', join(dir, 'r2.json')]);
    delete process.env.NEUROUTER_EXECUTOR_MODE;
    expect(again.code).toBeUndefined();
    expect((JSON.parse(readFileSync(join(dir, 'r2.json'), 'utf8')) as { score: { headline: number } }).score.headline).toBe(report.score.headline);
  }, 120_000);

  it('--contract 1|2 pins the eval server\'s contract, the report records it, categories come first; no framing component on contract 2 (B2)', async () => {
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    process.env.NEUROUTER_EXECUTOR_MODE = 'local';
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    try {
      const gen = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--generate', '--counts', '2,0,0,1', '--calibrate-only', '--save-suite', join(dir, 's.json')]);
      expect(gen.code).toBeUndefined();
      type Rep = { run: { contract: number }; categories: Array<{ category: string }>; score: { cells: Array<{ components: Array<{ key: string }> }> } };
      const byContract: Record<string, Rep> = {};
      for (const c of ['1', '2']) {
        const r = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--suite', join(dir, 's.json'), '--repeats', '1', '--modes', 'tool', '--contract', c, '--out', join(dir, `r${c}.json`)]);
        expect(r.err).toContain(`agent contract ${c} (--contract)`);
        expect(r.out.split('\n')[0]).toMatch(/^model\s+mode\s+category\s+success/);
        expect(r.out).toContain(`agent contract ${c}`);
        byContract[c] = JSON.parse(readFileSync(join(dir, `r${c}.json`), 'utf8')) as Rep;
        expect(byContract[c]!.run.contract).toBe(Number(c));
      }
      expect(byContract['2']!.categories.map((x) => x.category)).toEqual(['single', 'impossible']);
      // the score the eval report prints: framing is n/a on contract 2 (weights renormalize), measured on contract 1
      expect(byContract['2']!.score.cells[0]!.components.map((x) => x.key)).not.toContain('framing');
      expect(byContract['1']!.score.cells[0]!.components.map((x) => x.key)).toContain('framing');
      await expect(run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--suite', join(dir, 's.json'), '--contract', '3'])).rejects.toThrow('--contract must be 1 or 2');
    } finally {
      delete process.env.NEUROUTER_EXECUTOR_MODE;
    }
  }, 120_000);

  it('reports judge usage under the judge model, not the agent model (H1: the deterministic Gemini judge was filed under gpt-6-luna)', async () => {
    // the A/B evidence: agent gpt-6-luna (OpenAI), judge gemini-3.5-flash-lite (chosen because a Gemini key exists);
    // here the stub plays both, the agent is the stub model and the Gemini key selects the Gemini judge model
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    process.env.NEUROUTER_EXECUTOR_MODE = 'local';
    process.env.GEMINI_API_KEY = 'test-key-never-called';
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    try {
      const gen = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--generate', '--counts', '1,0,2,0', '--calibrate-only', '--save-suite', join(dir, 's.json')]);
      expect(gen.code).toBeUndefined();
      const r = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--suite', join(dir, 's.json'), '--repeats', '1', '--modes', 'tool', '--out', join(dir, 'r.json'), '--md', join(dir, 'r.md')]);
      expect(r.code).toBeUndefined();
      const rep = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as { run: { models: string[]; judgeModel?: string }; judgeUsage: Record<string, { calls: number }> };
      expect(Object.keys(rep.judgeUsage)).toEqual(['gemini-3.5-flash-lite']);
      expect(rep.judgeUsage['gemini-3.5-flash-lite']!.calls).toBeGreaterThan(0);
      expect(rep.run.models).not.toContain('gemini-3.5-flash-lite');
      expect(rep.run.judgeModel).toBe('gemini-3.5-flash-lite');
      const md = readFileSync(join(dir, 'r.md'), 'utf8');
      expect(md).toMatch(/Judge usage: gemini-3\.5-flash-lite: \d+ calls/);
      expect(md).not.toMatch(/Judge usage: stub/);
    } finally {
      delete process.env.NEUROUTER_EXECUTOR_MODE;
      delete process.env.GEMINI_API_KEY;
    }
  }, 120_000);

  it('--generate exits 2 without running when the generator produces no tasks', async () => {
    process.env.NEUROUTER_EVAL_LLM = 'stub';
    const dir = mkdtempSync(join(tmpdir(), 'nr-cli-'));
    const r = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--generate', '--counts', '0,0,0,0', '--repeats', '1', '--modes', 'tool', '--out', join(dir, 'r.json'), '--save-suite', join(dir, 's.json')]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('the generator produced no valid tasks');
    expect(r.err).not.toContain('running');
    expect(existsSync(join(dir, 'r.json'))).toBe(false);
    expect(existsSync(join(dir, 's.json'))).toBe(false);
  }, 60_000);
});

describe('suite limits (0.3.3)', () => {
  it('accepts known limits and rejects typos and out-of-range values', () => {
    const t = (limits?: unknown) => ({ key: 't', category: 'single' as const, prompt: '', rubric: '', assertions: [], referenceCalls: [], tags: [], enabled: true, ...(limits ? { limits: limits as never } : {}) });
    expect(() => checkSuiteLimits({ limits: { maxToolCalls: 150, maxTurns: 40 }, tasks: [t({ wallMs: 600_000 })] })).not.toThrow();
    expect(() => checkSuiteLimits({ limits: { maxToolCall: 150 } as never, tasks: [] })).toThrow(/suite\.limits/);
    expect(() => checkSuiteLimits({ tasks: [t({ maxTurns: 0 })] })).toThrow(/task t\.limits: maxTurns/);
  });
});
