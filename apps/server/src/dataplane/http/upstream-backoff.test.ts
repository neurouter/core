import { describe, expect, it } from 'vitest';
import { HttpInvoker } from './invoker.js';
import { upstreamRetryAfterMs } from './upstream-backoff.js';
import type { BuiltRequest } from './request-builder.js';

/**
 * Upstream backoff (0.3.3): a 429/503 that says when to come back (Retry-After, or X-RateLimit-Remaining 0 with
 * X-RateLimit-Reset) is retried for reads within a bound; writes are never retried (the pipeline surfaces
 * rate_limited with retry_after_ms); an optional per-environment cap bounds concurrent upstream calls.
 */
describe('upstreamRetryAfterMs', () => {
  const now = Date.UTC(2026, 10, 27, 12, 0, 0);
  it('reads Retry-After (seconds or HTTP date) and X-RateLimit-Reset (epoch seconds or delta) on 429/503 only', () => {
    expect(upstreamRetryAfterMs(429, { 'retry-after': '2' }, now)).toBe(2000);
    expect(upstreamRetryAfterMs(503, { 'retry-after': new Date(now + 3000).toUTCString() }, now)).toBe(3000);
    expect(upstreamRetryAfterMs(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(now / 1000 + 5) }, now)).toBe(5000);
    expect(upstreamRetryAfterMs(429, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '7' }, now)).toBe(7000);
    expect(upstreamRetryAfterMs(429, { 'x-ratelimit-remaining': '12', 'x-ratelimit-reset': '7' }, now)).toBeNull();
    expect(upstreamRetryAfterMs(429, {}, now)).toBeNull();
    expect(upstreamRetryAfterMs(500, { 'retry-after': '2' }, now)).toBeNull();
  });
});

describe('HttpInvoker retry and concurrency cap', () => {
  const req = (method = 'GET'): BuiltRequest => ({ method, url: new URL('https://api.test/v1/charges'), urlTemplate: '/v1/charges', headers: {} }) as unknown as BuiltRequest;
  const mk = (answers: Array<{ status: number; headers?: Record<string, string> }>) => {
    let t = 0;
    const slept: number[] = [];
    let calls = 0;
    const fetch = async () => {
      const a = answers[Math.min(calls++, answers.length - 1)]!;
      return new Response(JSON.stringify({ n: calls }), { status: a.status, headers: { 'content-type': 'application/json', ...(a.headers ?? {}) } });
    };
    const inv = new HttpInvoker(() => fetch as never, () => t, undefined, async (ms) => {
      slept.push(ms);
      t += ms;
    });
    return { inv, slept, calls: () => calls };
  };
  const base = { timeoutMs: 5000, maxBytes: 1 << 20, allowHttp: false };

  it('a read retries after Retry-After and returns the success; the response says how often it retried', async () => {
    const { inv, slept, calls } = mk([{ status: 429, headers: { 'retry-after': '1' } }, { status: 503, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '2' } }, { status: 200 }]);
    const r = await inv.invoke('e1', req(), { ...base, retry: { maxRetries: 2, maxWaitMs: 10_000 } });
    expect(r).toMatchObject({ status: 200, retries: 2, retryWaitMs: 3000 });
    expect(slept).toEqual([1000, 2000]);
    expect(calls()).toBe(3);
  });

  it('bounded: at most maxRetries, no wait over maxWaitMs or past the deadline, no hint = no retry', async () => {
    const always = (h: Record<string, string>) => mk([{ status: 429, headers: h }]);
    const a = always({ 'retry-after': '1' });
    expect(await a.inv.invoke('e', req(), { ...base, retry: { maxRetries: 2, maxWaitMs: 10_000 } })).toMatchObject({ status: 429, retries: 2 });
    expect(a.calls()).toBe(3);
    const long = always({ 'retry-after': '60' });
    expect(await long.inv.invoke('e', req(), { ...base, retry: { maxRetries: 2, maxWaitMs: 10_000 } })).toMatchObject({ status: 429 });
    expect(long.slept).toEqual([]);
    const late = always({ 'retry-after': '3' });
    expect(await late.inv.invoke('e', req(), { ...base, retry: { maxRetries: 2, maxWaitMs: 10_000, deadline: 2000 } })).toMatchObject({ status: 429 });
    expect(late.slept).toEqual([]);
    const none = always({});
    await none.inv.invoke('e', req(), { ...base, retry: { maxRetries: 2, maxWaitMs: 10_000 } });
    expect(none.calls()).toBe(1);
  });

  it('without a retry policy (writes) a 429 is returned at once, with its Retry-After header', async () => {
    const w = mk([{ status: 429, headers: { 'retry-after': '1' } }, { status: 200 }]);
    const r = await w.inv.invoke('e', req('POST'), base);
    expect(r).toMatchObject({ status: 429, headers: { 'retry-after': '1' } });
    expect(w.calls()).toBe(1);
  });

  it('maxConcurrent caps in-flight upstream calls per environment', async () => {
    let inFlight = 0;
    let peak = 0;
    const fetch = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const inv = new HttpInvoker(() => fetch as never);
    await Promise.all(Array.from({ length: 10 }, () => inv.invoke('e', req(), { ...base, maxConcurrent: 3 })));
    expect(peak).toBe(3);
    inFlight = 0;
    peak = 0;
    await Promise.all(Array.from({ length: 10 }, () => inv.invoke('e', req(), base)));
    expect(peak).toBe(10);
  });
});
