import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from './main.js';

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
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as { score: { headline: number; cells: unknown[] }; run: { provider: string } };
    expect(report.score.cells).toHaveLength(2);
    expect(report.run.provider).toBe('stub');
    expect(readFileSync(join(dir, 'r.md'), 'utf8')).toContain('stub provider');
    expect(existsSync(join(dir, 's.json'))).toBe(true);
    const attempts = JSON.parse(readFileSync(join(dir, 't.json'), 'utf8')) as Array<{ mode: string; prompt: string; transcript: Array<{ kind: string }>; assertionResults: unknown[] }>;
    expect(attempts).toHaveLength(10);
    expect(attempts.every((a) => a.prompt && a.transcript[0]?.kind === 'user' && Array.isArray(a.assertionResults))).toBe(true);
    // the saved suite re-runs deterministically
    process.env.NEUROUTER_EXECUTOR_MODE = 'local';
    const again = await run(['eval', '--spec', join(ROOT, 'examples/petstore/openapi.yaml'), '--suite', join(dir, 's.json'), '--repeats', '1', '--modes', 'tool,code', '--out', join(dir, 'r2.json')]);
    delete process.env.NEUROUTER_EXECUTOR_MODE;
    expect(again.code).toBeUndefined();
    expect((JSON.parse(readFileSync(join(dir, 'r2.json'), 'utf8')) as { score: { headline: number } }).score.headline).toBe(report.score.headline);
  }, 120_000);
});
