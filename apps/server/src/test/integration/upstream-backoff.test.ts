import { mkdtempSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const SPEC = resolve(import.meta.dirname, '../fixtures/paging.openapi.yaml');
const V2 = { 'x-neurouter-contract': '2' };
type Env = Record<string, any>;

/**
 * Upstream backoff (0.3.3) against a real HTTP upstream: a read that gets 429/503 with a hint (Retry-After,
 * X-RateLimit-Reset) is retried within bounds and succeeds; a write gets the 429 once, as rate_limited with
 * retry_after_ms (never auto-retried).
 */
describe('upstream 429/503 backoff (real upstream)', () => {
  let s: RunningServer;
  let api: Server;
  const hits: Record<string, number> = {};
  let live: ReturnType<typeof rawMcp>;

  beforeAll(async () => {
    api = createServer((req, res) => {
      const u = new URL(req.url ?? '/', 'http://x');
      const k = `${req.method} ${u.pathname}`;
      hits[k] = (hits[k] ?? 0) + 1;
      res.setHeader('content-type', 'application/json');
      if (k === 'GET /api/notes/n_1' && hits[k] === 1) {
        res.statusCode = 429;
        res.setHeader('retry-after', '1');
        return res.end('{"message":"slow down"}');
      }
      if (k === 'GET /api/notes/n_1' && hits[k] === 2) {
        res.statusCode = 503;
        res.setHeader('x-ratelimit-remaining', '0');
        res.setHeader('x-ratelimit-reset', String(Math.ceil(Date.now() / 1000) + 1));
        return res.end('{"message":"busy"}');
      }
      if (k === 'GET /api/notes/n_1') return res.end('{"id":"n_1","title":"One"}');
      if (k === 'GET /api/notes/n_2') {
        res.statusCode = 429;
        res.setHeader('retry-after', '120');
        return res.end('{"message":"come back later"}');
      }
      if (k === 'POST /api/notes') {
        res.statusCode = 429;
        res.setHeader('retry-after', '1');
        return res.end('{"message":"slow down"}');
      }
      res.statusCode = 404;
      res.end('{"message":"not found"}');
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', () => r()));
    const port = (api.address() as { port: number }).port;
    const dir = mkdtempSync(join(tmpdir(), 'nr-backoff-'));
    writeFileSync(
      join(dir, 'neurouter.yaml'),
      `version: 1
servers:
  - slug: paging
    name: Paging
    spec: { path: ${SPEC} }
    exposure: { contract: 2 }
    environments:
      - slug: live
        kind: dev
        baseUrl: http://127.0.0.1:${port}/api
        allowHttp: true
        writes: { enabled: true }
`,
    );
    s = await bootServer({ NEUROUTER_CONFIG: join(dir, 'neurouter.yaml'), UPSTREAM_ALLOW_PRIVATE_NETWORKS: 'true' });
    live = rawMcp(`${s.url}/mcp/paging/live`, await keyFor(s, 'paging', 'live', ['tools:read', 'tools:write']), { headers: V2 });
    await live.initialize();
  }, 90_000);
  afterAll(async () => {
    await s?.close();
    api?.close();
  });

  it('a read retries after Retry-After and X-RateLimit-Reset, then succeeds', async () => {
    const t0 = Date.now();
    const env = assertEnvelope((await live.call('get_note', { note_id: 'n_1' })).result, 'get_note') as Env;
    expect(env.ok, JSON.stringify(env.error)).toBe(true);
    expect(env.data).toMatchObject({ id: 'n_1' });
    expect(hits['GET /api/notes/n_1']).toBe(3);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
  }, 30_000);

  it('a read whose wait is over the bound is not retried: rate_limited with retry_after_ms', async () => {
    const env = assertEnvelope((await live.call('get_note', { note_id: 'n_2' })).result, 'get_note') as Env;
    expect(env.error).toMatchObject({ code: 'rate_limited', retry: 'after_wait', retry_after_ms: 120_000 });
    expect(hits['GET /api/notes/n_2']).toBe(1);
  }, 30_000);

  it('a write is never retried: rate_limited with retry_after_ms, one upstream call', async () => {
    const env = assertEnvelope((await live.call('create_note', { title: 'Nine' })).result, 'create_note') as Env;
    expect(env.error).toMatchObject({ code: 'rate_limited', retry: 'after_wait', retry_after_ms: 1000 });
    expect(hits['POST /api/notes']).toBe(1);
  }, 30_000);
});
