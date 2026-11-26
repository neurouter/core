import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootExecutor } from '../../deps.js';
import { loadConfig } from '../../kernel/config/load.js';
import { createLogger } from '../../kernel/lib/logger.js';
import type { RunningServer } from '../../server.js';
import { bootServer, keyFor, mcpClient } from '../fakes/server.js';

/**
 * Cold start: the embedded executor boots concurrently with the DB setup, but it is still awaited
 * before listen, so readiness and tools/list offer code mode from the very first request.
 */
describe('embedded executor boot (overlapped with DB init)', () => {
  let s: RunningServer;
  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_EXECUTOR_MODE: 'embedded', NEUROUTER_EXECUTOR_PREWARM: '1', NEUROUTER_EXECUTOR_POOL_MAX: '2' });
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  it('is ready on the first probe, and run_script is listed and runs', async () => {
    const ready = (await (await fetch(`${s.url}/readyz`)).json()) as { checks: Record<string, { ok: boolean }> };
    expect(ready.checks.executor?.ok).toBe(true);
    expect(s.services.executorHealth.healthy).toBe(true);
    const c = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read', 'code:run']));
    expect((await c.listTools()).tools.map((t) => t.name)).toContain('run_script');
    const r = await c.callTool({ name: 'run_script', arguments: { code: 'return 6 * 7' } });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect((r.structuredContent as { result: unknown }).result).toBe(42);
    await c.close();
  });
});

describe('bootExecutor', () => {
  const logger = createLogger({ level: 'silent', pretty: false, instanceId: 't' });
  const config = (env: Record<string, string>) => loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', ...env });

  it('mode off: no executor, no error', async () => {
    expect(await bootExecutor(config({ NEUROUTER_EXECUTOR_MODE: 'off' }), logger)).toEqual({ executor: null, embedded: null });
  });

  it('returns a failure instead of rejecting (startup goes on with code mode unavailable)', async () => {
    const r = await bootExecutor(config({ NEUROUTER_EXECUTOR_MODE: 'embedded', MONTY_BINARY_PATH: '/nonexistent/monty' }), logger);
    expect(r.executor).toBeNull();
    expect(r.embedded).toBeNull();
    expect(r.error).toBeInstanceOf(Error);
  });
});
