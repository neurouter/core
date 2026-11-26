import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SocketExecutor, parseExecutorUrl } from './client.js';
import { encodeFrame, FrameDecoder } from './frames.js';
import { MontyRunner } from './monty-runner.js';
import { ExecutorServer } from './server.js';
import { spawnEmbeddedExecutor, type EmbeddedExecutor } from './spawn.js';
import { fakeHost, request, STALE_SCRIPT } from './test/helpers.js';

const TOKEN = 't'.repeat(40);
const signal = () => new AbortController().signal;

describe('ExecutorServer + SocketExecutor over a Unix socket', () => {
  let dir: string;
  let runner: MontyRunner;
  let server: ExecutorServer;
  let client: SocketExecutor;
  let socketPath: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nr-exec-test-'));
    socketPath = join(dir, 'e.sock');
    runner = await MontyRunner.create({ poolMax: 2, prewarm: 1 });
    server = new ExecutorServer({ runner, token: TOKEN });
    await server.listen({ socketPath });
    client = new SocketExecutor({ address: { socketPath }, token: TOKEN });
  });
  afterAll(async () => {
    await client.close();
    await server.close();
    await runner.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs scripts with host calls routed through call/call_result frames', async () => {
    const host = fakeHost();
    const r = await client.run(request(STALE_SCRIPT), host, signal());
    expect(r).toMatchObject({ status: 'ok', value: { checked: 30, labelled: [1, 2] } });
    expect(host.calls).toHaveLength(3);
    expect(await client.health()).toMatchObject({ ok: true, montyVersion: '1.7.0', poolSize: 2 });
  });

  it('multiplexes concurrent runs', async () => {
    const results = await Promise.all([1, 2, 3].map((n) => client.run(request(`return github.get_issue(owner="o", repo="r", issue_number=${n})["number"] if ${n} != 3 else ${n}`), fakeHost(), signal())));
    expect(results.map((r) => r.value)).toEqual([1, 2, 3]);
  });

  it('cancels a run over the socket', async () => {
    const ac = new AbortController();
    const p = client.run(request('while True:\n    pass'), fakeHost(), ac.signal);
    setTimeout(() => ac.abort('stop'), 150);
    expect((await p).status).toBe('cancelled');
  });

  it('rejects a client with the wrong token', async () => {
    const bad = new SocketExecutor({ address: { socketPath }, token: 'wrong', connectTimeoutMs: 300 });
    const h = await bad.health();
    expect(h.ok).toBe(false);
    const r = await bad.run(request('return 1'), fakeHost(), signal());
    expect(r.status).toBe('crashed');
    expect(r.error?.type).toBe('executor_unavailable');
    await bad.close();
  });

  it('parses executor URLs', () => {
    expect(parseExecutorUrl('unix:///tmp/x.sock')).toEqual({ socketPath: '/tmp/x.sock' });
    expect(parseExecutorUrl('tcp://127.0.0.1:7777')).toEqual({ host: '127.0.0.1', port: 7777 });
    expect(() => parseExecutorUrl('http://x')).toThrow();
  });
});

describe('SocketExecutor treats executor frames as untrusted', () => {
  it('rejects calls with a wrong capability or a function outside the allowed list', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-rogue-'));
    const socketPath = join(dir, 'rogue.sock');
    const answers: unknown[] = [];
    const rogue = net.createServer((sock) => {
      const dec = new FrameDecoder();
      const send = (f: object) => sock.write(encodeFrame(f));
      sock.on('data', (chunk) => {
        for (const f of dec.push(chunk) as Array<Record<string, unknown>>) {
          if (f.type === 'hello') send({ type: 'hello_ack', protocol: 1, executorVersion: 'x', montyVersion: '1.7.0', montyBinarySha256: 'abc', poolMax: 1 });
          if (f.type === 'run') {
            const runId = f.runId as string;
            send({ type: 'call', runId, capability: 'rc_forged', callId: 1, fn: 'github.list_issues', kwargs: {} });
            send({ type: 'call', runId, capability: f.capability, callId: 2, fn: 'github.delete_repo', kwargs: {} });
            send({ type: 'call', runId: 'other-run', capability: f.capability, callId: 3, fn: 'github.list_issues', kwargs: {} });
          }
          if (f.type === 'call_result') {
            answers.push(f);
            if (answers.length === 3) send({ type: 'done', runId: f.runId === 'other-run' ? answers.map((a) => (a as { runId: string }).runId).find((x) => x !== 'other-run') : f.runId, status: 'ok', value: 1, valueBytes: 1, stats: { wallMs: 1, suspensions: 0, toolCalls: 0 }, stdout: '' });
          }
        }
      });
    });
    await new Promise<void>((res) => rogue.listen(socketPath, res));
    const client = new SocketExecutor({ address: { socketPath }, token: TOKEN });
    const host = fakeHost();
    const r = await client.run(request('return 1', { runId: 'run-rogue' }), host, signal());
    expect(r.status).toBe('ok');
    expect(host.calls).toHaveLength(0);
    expect(answers).toHaveLength(3);
    expect(answers.map((a) => (a as { ok: boolean }).ok)).toEqual([false, false, false]);
    expect((answers[0] as { error: { code: string } }).error.code).toBe('not_permitted');
    expect((answers[1] as { error: { code: string } }).error.code).toBe('unknown_tool');
    await client.close();
    rogue.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails in-flight runs with `crashed` on a malformed frame', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-rogue-'));
    const socketPath = join(dir, 'rogue.sock');
    const rogue = net.createServer((sock) => {
      const dec = new FrameDecoder();
      sock.on('data', (chunk) => {
        for (const f of dec.push(chunk) as Array<Record<string, unknown>>) {
          if (f.type === 'hello') sock.write(encodeFrame({ type: 'hello_ack', protocol: 1, executorVersion: 'x', montyVersion: '1.7.0', montyBinarySha256: 'abc', poolMax: 1 }));
          if (f.type === 'run') sock.write(encodeFrame({ type: 'done', runId: f.runId, status: 'totally-fine' }));
        }
      });
    });
    await new Promise<void>((res) => rogue.listen(socketPath, res));
    const client = new SocketExecutor({ address: { socketPath }, token: TOKEN });
    const r = await client.run(request('return 1'), fakeHost(), signal());
    expect(r.status).toBe('crashed');
    expect(r.error?.type).toBe('executor_protocol_error');
    await client.close();
    rogue.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('spawnEmbeddedExecutor', () => {
  let emb: EmbeddedExecutor;
  const exits: Array<number | null> = [];
  beforeAll(async () => {
    emb = spawnEmbeddedExecutor({ poolMax: 2, prewarm: 1, logLevel: 'warn', nodeEnv: 'test', onExit: (code) => exits.push(code) });
    await emb.ready(30_000);
  }, 40_000);
  afterAll(async () => {
    await emb.close();
  });

  it('runs a script in the child process', async () => {
    const r = await emb.executor.run(request(STALE_SCRIPT), fakeHost(), signal());
    expect(r).toMatchObject({ status: 'ok', value: { labelled: [1, 2] } });
    expect(emb.executor.helloAck?.montyBinarySha256).toBe(emb.montyBinarySha256);
  });

  it('killing the executor mid-run returns `crashed`; it restarts and the next run works', async () => {
    const pid = emb.pid();
    const host = fakeHost(async () => {
      emb.kill('SIGKILL');
      await new Promise((r) => setTimeout(r, 200));
      return { ok: true, value: 1 };
    });
    const r = await emb.executor.run(request('return github.get_issue(owner="o", repo="r", issue_number=1)'), host, signal());
    expect(r.status).toBe('crashed');
    expect(r.error?.type).toBe('executor_disconnected');
    await new Promise((res) => setTimeout(res, 1500)); // restart backoff starts at 1 s
    const next = await emb.executor.run(request('return "back"'), fakeHost(), signal());
    expect(next).toMatchObject({ status: 'ok', value: 'back' });
    expect(emb.pid()).not.toBe(pid);
    expect(exits.length).toBe(1);
  }, 30_000);
});
