import { resolve } from 'node:path';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const CONFIG = resolve(import.meta.dirname, '../fixtures/acme.neurouter.yaml');
const V2 = { 'x-neurouter-contract': '2' };
type Env = Record<string, any>;

/**
 * R1 (long-workflows probe 2026-11-27, github-n100/n200-code): a script fanning out past the per-tool burst got
 * `rate_limited` at the first call over it (60 calls, then 143 of 455 calls blocked at size 200) and could not wait.
 * 0.3.3: the built-in mock has no gateway rate limit unless one is configured; inside run_script an inner call waits
 * for a token within the script's wall time (contract 1 and 2), and raises RateLimited with retry_after only when the
 * wait cannot fit. Wait time is counted in the script's stats.
 */
describe('run_script pacing and the mock rate limit (acme, mock)', () => {
  let s: RunningServer;
  const envRow = async () => (await s.services.servers.environments((await s.services.servers.bySlug(DEFAULT_TENANT_ID, 'acme'))!.id)).find((e) => e.slug === 'mock')!;
  const setLimits = async (limits: Record<string, unknown>) => {
    await s.services.dbs.main.db.updateTable('environments').set({ limits: JSON.stringify(limits) }).where('id', '=', (await envRow()).id).execute();
    s.services.runtime.invalidate();
  };
  const script = async (code: string, headers: Record<string, string> = V2) => {
    const key = await keyFor(s, 'acme', 'mock', ['tools:read', 'code:run']);
    const c = rawMcp(`${s.url}/mcp/acme/mock`, key, { headers });
    await c.initialize();
    return (await c.call('run_script', { code })).result as Env;
  };
  const lastStats = async () => {
    const row = await s.services.dbs.main.db.selectFrom('script_runs').select(['stats', 'started_at']).orderBy('started_at', 'desc').limit(1).executeTakeFirstOrThrow();
    return JSON.parse(row.stats as string) as Record<string, number>;
  };
  const fanOut = (n: number) => `out = []\nfor i in range(${n}):\n    out.append(acme.get_order(order_id="order_1")["id"])\nreturn len(out)`;

  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_CONFIG: CONFIG });
  }, 60_000);
  afterEach(async () => {
    await setLimits({});
  });
  afterAll(async () => {
    await s?.close();
  });

  it('the built-in mock has no gateway rate limit by default: 90 calls of one tool in one script all run', async () => {
    const r = assertEnvelope(await script(fanOut(90)), 'run_script');
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data).toBe(90);
    expect((await lastStats()).blockedCalls).toBe(0);
  }, 60_000);

  it('a configured mock rate limit applies; inner calls over the burst wait for tokens (contract 2) and the wait is in the stats', async () => {
    await setLimits({ toolRateLimit: { perMinute: 600, burst: 3 } });
    const t0 = Date.now();
    const r = assertEnvelope(await script(fanOut(8)), 'run_script');
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data).toBe(8);
    const st = await lastStats();
    expect(st.blockedCalls).toBe(0);
    expect(st.rateLimitWaits).toBeGreaterThanOrEqual(4);
    expect(st.rateLimitWaitMs).toBeGreaterThanOrEqual(400);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('contract 1 scripts are paced too (stats in the structured result)', async () => {
    await setLimits({ toolRateLimit: { perMinute: 600, burst: 3 } });
    const r = (await script(fanOut(8), {})).structuredContent as Env;
    expect(r.status, JSON.stringify(r.error)).toBe('ok');
    expect(r.result).toBe(8);
    expect(r.stats.rateLimitWaitMs).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('a wait that cannot fit the wall time raises RateLimited with retry_after_ms at once (contract 2)', async () => {
    await setLimits({ toolRateLimit: { perMinute: 1, burst: 1 } });
    const t0 = Date.now();
    const r = assertEnvelope(await script('acme.get_order(order_id="order_1")\ntry:\n    acme.get_order(order_id="order_1")\nexcept RateLimited as e:\n    i = ops.error(e)\n    return [i["code"], i["retry"], i["retry_after_ms"] > 30000, str(e)]\nreturn "no error"'), 'run_script');
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(r.data.slice(0, 3)).toEqual(['rate_limited', 'after_wait', true]);
    expect(r.data[3]).toMatch(/Waiting does not fit this script/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  }, 60_000);

  it('limits.code.rateLimitWaitSec: 0 turns pacing off (contract 1: a rate_limited error at once)', async () => {
    await setLimits({ toolRateLimit: { perMinute: 600, burst: 1 }, code: { rateLimitWaitSec: 0 } });
    const r = (await script('acme.get_order(order_id="order_1")\ntry:\n    acme.get_order(order_id="order_1")\nexcept RuntimeError as e:\n    return str(e)[:40]\nreturn "no error"', {})).structuredContent as Env;
    expect(r.result).toMatch(/^rate_limited: Rate limit exceeded/);
  }, 60_000);
});
