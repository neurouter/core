import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalExecutor, type RunRequest } from '@neurouter/executor';
import { iterGeneratorsInNext, wrapScript } from './wrap.js';

describe('wrapScript', () => {
  it('wraps the body in a function and keeps explicit returns', () => {
    const w = wrapScript('x = 1\nreturn x + 1');
    expect(w.code).toBe('def __neurouter_main__():\n    x = 1\n    return x + 1\n__neurouter_main__()\n');
    expect(w.returnInjected).toBe(false);
    expect(w).toMatchObject({ lineOffset: 1, colOffset: 4 });
  });

  it('turns a trailing bare expression into a return', () => {
    expect(wrapScript('x = 2\nx * 3').code).toContain('    return x * 3\n');
    expect(wrapScript('x = 2; x * 3').code).toContain('    x = 2; return x * 3\n');
    expect(wrapScript('github.list(\n  owner="a",\n)').code).toContain('    return github.list(\n      owner="a",\n    )');
    expect(wrapScript('f = lambda x: x\nf(1)').returnInjected).toBe(true);
  });

  it('does not inject return after assignments or blocks', () => {
    for (const src of ['x = 1', 'x += 1', 'x: int = 1', 'for i in range(3):\n    print(i)', 'if x:\n    y\n', 'def f():\n    return 1']) {
      expect(wrapScript(src).returnInjected).toBe(false);
    }
  });

  it('keeps multi-line string contents unchanged', () => {
    const w = wrapScript('s = """line1\n  line2\nline3"""\nreturn s');
    expect(w.code).toContain('    s = """line1\n  line2\nline3"""\n    return s');
  });

  it('handles empty and comment-only scripts', () => {
    expect(wrapScript('# nothing').code).toBe('def __neurouter_main__():\n    # nothing\n    return None\n__neurouter_main__()\n');
  });

  it('maps wrapped lines back to user lines', () => {
    const w = wrapScript('a = 1\nb = 2\nc = 3');
    expect(w.mapLine(2)).toBe(1);
    expect(w.mapLine(4)).toBe(3);
    expect(w.mapLine(99)).toBe(3);
    expect(w.mapLine(1)).toBe(1);
  });
});

describe('wrapScript + real Monty (LocalExecutor)', () => {
  let ex: LocalExecutor;
  beforeAll(async () => {
    ex = await LocalExecutor.create({ poolMax: 1, prewarm: 1 });
  });
  afterAll(async () => {
    await ex.close();
  });
  const run = (src: string) => {
    const w = wrapScript(src);
    const req: RunRequest = {
      runId: 'r',
      capability: 'rc',
      code: w.code,
      lineOffset: w.lineOffset,
      colOffset: w.colOffset,
      modules: {},
      inputs: {},
      limits: { cpuTimeSec: 5, wallTimeSec: 10, maxMemoryMb: 64, maxToolCalls: 10, maxConcurrentCalls: 2, maxResultBytes: 100_000 },
      osPolicy: { datetime: '2026-11-26T00:00:00Z', seed: 1 },
    };
    return ex.run(req, { call: async () => ({ ok: true, value: null }) }, new AbortController().signal);
  };

  it('returns the value of a top-level return or trailing expression', async () => {
    expect(await run('x = 20\nreturn x + 1')).toMatchObject({ status: 'ok', value: 21 });
    expect(await run('x = [1, 2]\nsum(x)')).toMatchObject({ status: 'ok', value: 3 });
    expect(await run('s = """a\n  b"""\ns')).toMatchObject({ status: 'ok', value: 'a\n  b' });
  });

  it('reports runtime errors at the user line and column', async () => {
    const r = await run('a = 1\nb = {}\nreturn b["missing"]');
    expect(r.status).toBe('script_error');
    expect(r.error).toMatchObject({ type: 'KeyError', line: 3 });
    expect(r.error?.traceback).toMatch(/script\.py", line 3/);
  });
});

describe('next() on generator expressions (Monty evaluates them to lists)', () => {
  it('wraps the first argument of next(genexpr) in iter(), and nothing else', () => {
    expect(iterGeneratorsInNext('a = next(x for x in xs if x > 1)')).toBe('a = next(iter(x for x in xs if x > 1))');
    expect(iterGeneratorsInNext('a = next((x for x in xs), None)')).toBe('a = next(iter((x for x in xs)), None)');
    expect(iterGeneratorsInNext('a = next(it)\nb = next(it, 0)\nc = obj.next(x for x in y)\nd = next([x for x in y])')).toBe('a = next(it)\nb = next(it, 0)\nc = obj.next(x for x in y)\nd = next([x for x in y])');
    expect(iterGeneratorsInNext('s = "next(x for x in y)"')).toBe('s = "next(x for x in y)"');
  });
});
