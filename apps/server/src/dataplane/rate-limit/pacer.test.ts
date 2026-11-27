import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../test/fakes/context.js';
import { RateLimiter } from './limiter.js';
import { newPaceBudget, takePaced } from './pacer.js';
import { MemoryRateLimitStore } from './stores.js';

/**
 * R1 (long-workflows probe, github-n100/200-code): a script that fans out past the per-tool burst got `rate_limited`
 * immediately and could not wait ("retry after 1s"; 143 of 455 calls blocked at size 200). Inside run_script an
 * inner call now waits for a token, bounded by the script's remaining wall time and a max wait (default 30 s).
 */
describe('takePaced (run_script pacing, fake clock)', () => {
  const setup = (perMinute: number, burst: number) => {
    const clock = new FakeClock(0);
    const limiter = new RateLimiter(new MemoryRateLimitStore(clock));
    const checks = limiter.checksFor({ environmentId: 'e', credentialKey: 'k', tool: 'pulls_list_reviews', principalLimit: { perMinute: 6000, burst: 1000 }, toolLimit: { perMinute, burst } });
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
      clock.advance(ms);
    };
    return { clock, limiter, checks, slept, sleep };
  };

  it('a fan-out past the burst waits for tokens and completes (88 calls at 300/min, burst 60: ~5.6 s of waiting)', async () => {
    const { clock, limiter, checks, slept, sleep } = setup(300, 60);
    const budget = newPaceBudget({ now: 0, wallMs: 30_000, maxWaitMs: 30_000 });
    for (let i = 0; i < 88; i++) expect((await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep })).allowed).toBe(true);
    expect(slept).toHaveLength(28);
    expect(budget.waits).toBe(28);
    expect(budget.waitedMs).toBe(28 * 200);
    expect(clock.now()).toBe(5_600);
  });

  it('without a budget (tool mode, agent calls) a denial is immediate, as before', async () => {
    const { clock, limiter, checks, slept, sleep } = setup(60, 1);
    expect((await takePaced(limiter, checks, { budget: null, now: () => clock.now(), sleep })).allowed).toBe(true);
    expect(await takePaced(limiter, checks, { budget: null, now: () => clock.now(), sleep })).toMatchObject({ allowed: false, retryAfterMs: 1000 });
    expect(slept).toEqual([]);
  });

  it('a wait that does not fit the remaining wall time fails at once with retry_after (no sleep)', async () => {
    const { clock, limiter, checks, slept, sleep } = setup(6, 1); // one token per 10 s
    const budget = newPaceBudget({ now: 0, wallMs: 5_000, maxWaitMs: 30_000 });
    expect((await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep })).allowed).toBe(true);
    const r = await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep });
    expect(r).toMatchObject({ allowed: false, retryAfterMs: 10_000, pacing: { reason: 'wall_time', roomMs: expect.any(Number) } });
    expect(slept).toEqual([]);
  });

  it('a wait over the max wait fails with retry_after; max wait 0 turns pacing off', async () => {
    const { clock, limiter, checks, sleep } = setup(6, 1);
    const budget = newPaceBudget({ now: 0, wallMs: 120_000, maxWaitMs: 5_000 });
    await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep });
    expect(await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep })).toMatchObject({ allowed: false, pacing: { reason: 'max_wait' } });
    const off = newPaceBudget({ now: clock.now(), wallMs: 120_000, maxWaitMs: 0 });
    expect(await takePaced(limiter, checks, { budget: off, now: () => clock.now(), sleep })).toMatchObject({ allowed: false, pacing: { reason: 'max_wait' } });
  });

  it('an aborted script stops waiting', async () => {
    const { clock, limiter, checks } = setup(60, 1);
    const budget = newPaceBudget({ now: 0, wallMs: 30_000, maxWaitMs: 30_000 });
    await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep: async () => {} });
    const ac = new AbortController();
    ac.abort();
    const r = await takePaced(limiter, checks, { budget, now: () => clock.now(), sleep: async (_ms, signal) => { if (signal?.aborted) throw new Error('aborted'); }, signal: ac.signal });
    expect(r.allowed).toBe(false);
  });
});
