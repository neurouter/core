import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const ROOT = resolve(import.meta.dirname, '../../..');
const action = parse(readFileSync(join(ROOT, 'actions/eval/action.yml'), 'utf8')) as {
  inputs: Record<string, { required?: boolean; default?: string }>;
  runs: { steps: Array<{ id?: string; run?: string }> };
};
const script = action.runs.steps.find((s) => s.id === 'eval')!.run!;

/** Runs the action's eval step with bash and a fake `npx` that records its arguments. */
function runStep(env: Record<string, string>): { code: number; npx: string[]; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'nr-action-'));
  const bin = join(dir, 'bin');
  execFileSync('mkdir', ['-p', bin]);
  writeFileSync(join(bin, 'npx'), `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${dir}/npx-args"\n`);
  chmodSync(join(bin, 'npx'), 0o755);
  const base = { NR_SPEC: '', NR_OVERLAY: '', NR_SUITE: '', NR_CONFIG: '', NR_SERVER: '', NR_MODELS: 'gpt-6-luna', NR_MODES: 'tool,code', NR_REPEATS: '3', NR_MIN_SCORE: '0', NR_VERSION: '', NR_ACTION_REF: '', NR_ACTION_PATH: join(ROOT, 'actions/eval') };
  let code = 0;
  let out = '';
  try {
    out = execFileSync('bash', ['-c', script], { env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: dir, GITHUB_OUTPUT: join(dir, 'out'), GITHUB_STEP_SUMMARY: join(dir, 'summary'), ...base, ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    code = (err as { status: number }).status;
    out = String((err as { stdout: string }).stdout);
  }
  let npx: string[] = [];
  try {
    npx = readFileSync(join(dir, 'npx-args'), 'utf8').trim().split('\n');
  } catch {
    npx = [];
  }
  return { code, npx, out };
}

describe('GitHub eval action (actions/eval/action.yml)', () => {
  const cliVersion = (JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')) as { version: string }).version;

  it('spec is optional; neurouter-version defaults to empty (resolved at run time)', () => {
    expect(action.inputs.spec!.required).toBe(false);
    expect(action.inputs['neurouter-version']!.default).toBe('');
    expect(script).not.toContain('${{'); // inputs reach the script as env vars only (no shell injection)
  });

  it('config + server without spec runs eval --config --server', () => {
    const r = runStep({ NR_CONFIG: 'neurouter.yaml', NR_SERVER: 'orders' });
    expect(r.code).toBe(0);
    expect(r.npx.slice(0, 7)).toEqual(['-y', `neurouter@${cliVersion}`, 'eval', '--config', 'neurouter.yaml', '--server', 'orders']);
    expect(r.npx).not.toContain('--spec');
  });

  it('fails clearly without spec or config', () => {
    expect(runStep({}).code).toBe(2);
    expect(runStep({ NR_CONFIG: 'neurouter.yaml' }).code).toBe(2);
  });

  it('the CLI version follows the action tag, else the package version; an explicit input wins', () => {
    expect(runStep({ NR_SPEC: 'openapi.yaml', NR_ACTION_REF: 'v0.4.2' }).npx[1]).toBe('neurouter@0.4.2');
    expect(runStep({ NR_SPEC: 'openapi.yaml', NR_ACTION_REF: '1.2.3-rc.1' }).npx[1]).toBe('neurouter@1.2.3-rc.1');
    expect(runStep({ NR_SPEC: 'openapi.yaml', NR_ACTION_REF: 'main' }).npx[1]).toBe(`neurouter@${cliVersion}`);
    expect(runStep({ NR_SPEC: 'openapi.yaml', NR_ACTION_REF: 'v0.4.2', NR_VERSION: '0.3.0' }).npx[1]).toBe('neurouter@0.3.0');
    expect(runStep({ NR_SPEC: 'openapi.yaml', NR_SUITE: 'suite.json' }).npx).toEqual(expect.arrayContaining(['--spec', 'openapi.yaml', '--suite', 'suite.json']));
  });
});
