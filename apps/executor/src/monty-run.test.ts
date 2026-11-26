import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalExecutor } from './local-executor.js';
import { fakeHost, montyWorkerPids, request, STALE_SCRIPT } from './test/helpers.js';

const signal = () => new AbortController().signal;

describe('MontyRunner (real @pydantic/monty)', () => {
  let ex: LocalExecutor;
  beforeAll(async () => {
    ex = await LocalExecutor.create({ poolMax: 3, prewarm: 1 });
  });
  afterAll(async () => {
    await ex.close();
  });

  it('runs a multi-call script in one run: host calls get keyword arguments', async () => {
    const host = fakeHost();
    const r = await ex.run(request(STALE_SCRIPT), host, signal());
    expect(r.status).toBe('ok');
    expect(r.value).toEqual({ checked: 30, labelled: [1, 2] });
    expect(host.calls[0]).toEqual({ fn: 'github.list_issues', kwargs: { owner: 'octo', repo: 'demo', state: 'open', limit: 30 } });
    expect(host.calls.filter((c) => c.fn === 'github.add_labels').map((c) => c.kwargs)).toEqual([
      { owner: 'octo', repo: 'demo', issue_number: 1, labels: ['stale'] },
      { owner: 'octo', repo: 'demo', issue_number: 2, labels: ['stale'] },
    ]);
    expect(r.stats.toolCalls).toBe(3);
    expect(r.valueBytes).toBeGreaterThan(0);
  });

  it('ops.parallel returns results in input order with per-item errors', async () => {
    const host = fakeHost();
    const r = await ex.run(request('return ops.parallel([("github.get_issue", {"owner": "o", "repo": "r", "issue_number": n}) for n in range(1, 6)])'), host, signal());
    expect(r.status).toBe('ok');
    const items = r.value as Array<{ ok: boolean; value?: { number: number }; error?: { code: string; error_id: string } }>;
    expect(items.map((i) => (i.ok ? i.value!.number : i.error!.code))).toEqual([1, 2, 'upstream_not_found', 4, 5]);
    expect(items[2]!.error!.error_id).toBe('err_abc');
  });

  it('ops.parallel honours the concurrency cap', async () => {
    let inflight = 0;
    let peak = 0;
    const host = fakeHost(async () => {
      inflight++;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 20));
      inflight--;
      return { ok: true, value: 1 };
    });
    const req = request('return len(ops.parallel([("github.get_issue", {"owner": "o", "repo": "r", "issue_number": n}) for n in range(10)]))');
    req.limits.maxConcurrentCalls = 3;
    const r = await ex.run(req, host, signal());
    expect(r.value).toBe(10);
    expect(peak).toBe(3);
  });

  it('catches a wrong argument name in the type check before any host call', async () => {
    const host = fakeHost();
    const r = await ex.run(request('x = 1\nreturn github.list_issues(owner="o", repository="r")'), host, signal());
    expect(r.status).toBe('type_error');
    expect(r.error?.line).toBe(2);
    expect(r.error?.message).toMatch(/repository|repo/);
    expect(host.calls).toHaveLength(0);
  });

  it('reports syntax errors with the user line', async () => {
    const r = await ex.run(request('x = 1\ny = (2 +\n'), fakeHost(), signal());
    expect(r.status).toBe('syntax_error');
    expect(r.error?.line).toBeGreaterThanOrEqual(2);
  });

  it('rejects positional arguments to host functions at run time', async () => {
    const host = fakeHost();
    const r = await ex.run(request('try:\n    github.get_issue("o", "r", 1)\nexcept TypeError as e:\n    return str(e)', { typeCheck: false }), host, signal());
    expect(r.status).toBe('ok');
    expect(String(r.value)).toMatch(/keyword arguments/);
    expect(host.calls).toHaveLength(0);
  });

  it('raises host errors as RuntimeError with the error id (catchable)', async () => {
    const r = await ex.run(request('try:\n    github.get_issue(owner="o", repo="r", issue_number=3)\nexcept RuntimeError as e:\n    return str(e)'), fakeHost(), signal());
    expect(r.value).toBe('upstream_not_found: Issue 3 not found (error_id=err_abc)');
    const r2 = await ex.run(request('github.get_issue(owner="o", repo="r", issue_number=3)'), fakeHost(), signal());
    expect(r2.status).toBe('script_error');
    expect(r2.error?.type).toBe('RuntimeError');
    expect(r2.error?.line).toBe(1);
  });

  it('stops `while True: pass` at the execution time limit', async () => {
    const req = request('while True:\n    pass');
    req.limits.cpuTimeSec = 1;
    const t0 = Date.now();
    const r = await ex.run(req, fakeHost(), signal());
    expect(r.status).toBe('limit_exceeded');
    expect(r.error?.type).toBe('TimeoutError');
    expect(Date.now() - t0).toBeLessThan(5000);
  });

  it('enforces the memory limit', async () => {
    const req = request('a = []\nwhile True:\n    a.append("x" * 100000)');
    req.limits.maxMemoryMb = 16;
    const r = await ex.run(req, fakeHost(), signal());
    expect(r.status).toBe('limit_exceeded');
    expect(r.error?.type).toBe('MemoryError');
  });

  it('enforces the recursion limit', async () => {
    const r = await ex.run(request('def f(n):\n    return f(n + 1)\nreturn f(0)'), fakeHost(), signal());
    expect(r.status).toBe('limit_exceeded');
    expect(r.error?.type).toBe('RecursionError');
  });

  it('works normally after a limit trip (the worker is replaced)', async () => {
    const req = request('while True:\n    pass');
    req.limits.cpuTimeSec = 0.5;
    expect((await ex.run(req, fakeHost(), signal())).status).toBe('limit_exceeded');
    const r = await ex.run(request('return 1 + 1'), fakeHost(), signal());
    expect(r).toMatchObject({ status: 'ok', value: 2 });
  });

  it('caps host calls per run (backstop of the server count)', async () => {
    const req = request('for i in range(10):\n    github.get_issue(owner="o", repo="r", issue_number=1)\nreturn "unreachable"');
    req.limits.maxToolCalls = 4;
    const host = fakeHost(() => ({ ok: true, value: {} }));
    const r = await ex.run(req, host, signal());
    expect(r.status).toBe('limit_exceeded');
    expect(host.calls).toHaveLength(4);
  });

  it('denies OS access and has no filesystem', async () => {
    const r = await ex.run(request('import os\nreturn os.getenv("HOME")', { typeCheck: false }), fakeHost(), signal());
    expect(r.status).toBe('script_error');
    expect(r.error?.message).toMatch(/not supported/);
    const r2 = await ex.run(request('from pathlib import Path\nreturn Path("/etc/passwd").read_text()', { typeCheck: false }), fakeHost(), signal());
    expect(r2.status).toBe('script_error');
  });

  it('freezes the clock, seeds random and makes sleep free', async () => {
    const code = 'import datetime\nimport random\nimport time\ntime.sleep(100)\nreturn [str(datetime.datetime.now()), ops.now(), random.random()]';
    const t0 = Date.now();
    const a = await ex.run(request(code, { typeCheck: false }), fakeHost(), signal());
    const b = await ex.run(request(code, { typeCheck: false }), fakeHost(), signal());
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(a.status).toBe('ok');
    const [dt, now, rnd] = a.value as [string, string, number];
    expect(dt).toBe('2026-11-26 12:00:00');
    expect(now).toBe('2026-11-26T12:00:00.000Z');
    expect((b.value as unknown[])[2]).toBe(rnd);
  });

  it('captures print output (capped) and binds inputs as globals', async () => {
    const r = await ex.run(request('print("hello", who)\nfor i in range(3000):\n    print("x" * 10)\nreturn who', { inputs: { who: 'world' } }), fakeHost(), signal());
    expect(r.status).toBe('ok');
    expect(r.value).toBe('world');
    expect(r.stdout.startsWith('hello world\n')).toBe(true);
    expect(Buffer.byteLength(r.stdout)).toBeLessThanOrEqual(16 * 1024);
  });

  it('converts Python values to JSON and truncates large results', async () => {
    const r = await ex.run(request('return {"t": (1, 2), "s": sorted({3, 1}), "n": None, "f": 1.5, "nested": {"a": [{"b": True}]}}'), fakeHost(), signal());
    expect(r.value).toEqual({ t: [1, 2], s: [1, 3], n: null, f: 1.5, nested: { a: [{ b: true }] } });
    const req = request('return ["x" * 100 for i in range(100)]');
    req.limits.maxResultBytes = 1000;
    const big = await ex.run(req, fakeHost(), signal());
    expect(big).toMatchObject({ status: 'ok', truncated: true });
    expect(big.value).toBeUndefined();
    expect(big.valueBytes).toBeGreaterThan(10_000);
    expect(big.preview!.length).toBeLessThanOrEqual(8192);
  });

  it('enforces the wall deadline across slow host calls', async () => {
    const req = request('return github.get_issue(owner="o", repo="r", issue_number=1)');
    req.limits.wallTimeSec = 0.3;
    const r = await ex.run(req, fakeHost(() => new Promise((res) => setTimeout(() => res({ ok: true, value: 1 }), 2000))), signal());
    expect(r.status).toBe('limit_exceeded');
    expect(r.error?.message).toMatch(/wall time/);
  });

  it('cancels on abort', async () => {
    const ac = new AbortController();
    const p = ex.run(request('while True:\n    pass'), fakeHost(), ac.signal);
    setTimeout(() => ac.abort('user'), 200);
    const r = await p;
    expect(r.status).toBe('cancelled');
  });

  it('a crashed worker yields `crashed` and the next run works', async () => {
    const host = fakeHost(async () => {
      for (const pid of montyWorkerPids()) process.kill(pid, 'SIGKILL');
      await new Promise((r) => setTimeout(r, 100));
      return { ok: true, value: 1 };
    });
    const r = await ex.run(request('x = github.get_issue(owner="o", repo="r", issue_number=1)\nreturn x'), host, signal());
    expect(r.status).toBe('crashed');
    const next = await ex.run(request('return "alive"'), fakeHost(), signal());
    expect(next).toMatchObject({ status: 'ok', value: 'alive' });
  });

  it('reports health', async () => {
    expect(await ex.health()).toMatchObject({ ok: true, montyVersion: '1.7.0', poolSize: 3, busy: 0 });
  });
});

describe('LocalExecutor guard', () => {
  it('is refused in production', async () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(LocalExecutor.create({ poolMax: 1, prewarm: 0 })).rejects.toThrow(/production/);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
