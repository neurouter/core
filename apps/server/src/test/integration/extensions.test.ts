/**
 * Extension points and P0 operational flags (multi-tenancy spec §1.4, §13 P0):
 * `StartOptions.extensions` (executor decorator, routes, jobs, features, migrations, usage sink) and
 * `NEUROUTER_MAINTENANCE`, `NEUROUTER_RESOURCE_ALIASES`, `METRICS_PER_SERVER_LABELS`.
 */
import { resolve } from 'node:path';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../../server.js';
import { Metrics } from '../../kernel/observability/metrics.js';
import { canonicalResource, resolveResource, sameResource } from '../../controlplane/oauth/resource.js';
import { sameResource as dataplaneSameResource } from '../../dataplane/auth/authenticate.js';
import { createTestContext, importPetstore } from '../fakes/app-context.js';
import { countingExecutor, RecordingUsageSink } from '../fakes/extensions.js';
import { freePort, keyFor, mcpClient, REPO_ROOT } from '../fakes/server.js';

describe('extension points (StartOptions.extensions)', () => {
  let s: RunningServer;
  const exec = { runs: 0, wrapped: 0 };
  const usage = new RecordingUsageSink();
  const jobsSeen: string[] = [];
  beforeAll(async () => {
    const port = String(await freePort());
    s = await startServer({
      env: { NODE_ENV: 'test', HOST: '127.0.0.1', PORT: port, PUBLIC_URL: `http://127.0.0.1:${port}`, DATABASE_URL: 'sqlite::memory:', EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'local', NEUROUTER_EXECUTOR_PREWARM: '1', LOG_LEVEL: 'error', NEUROUTER_CONFIG: resolve(REPO_ROOT, 'neurouter.example.yaml') },
      jobs: false,
      loadDotenv: false,
      services: { defaultMetrics: false },
      extensions: {
        executor: countingExecutor(exec),
        usage,
        routes: [async (app, svc) => void app.get('/ext/ping', async () => ({ ok: true, version: svc.version }))],
        jobs: [(sch) => void jobsSeen.push(typeof sch.register)],
        features: async () => ({ billing: true }),
        migrations: { main: { c0001_test: { up: async (db) => void (await db.schema.createTable('ext_things').addColumn('id', 'text', (c) => c.primaryKey()).execute()), down: async (db) => void (await db.schema.dropTable('ext_things').execute()) } } },
      },
    });
  }, 60_000);
  afterAll(async () => s?.close());

  it('wraps the executor, mounts routes, registers jobs, runs extension migrations', async () => {
    expect(exec.wrapped).toBe(1);
    expect(await (await fetch(`${s.url}/ext/ping`)).json()).toEqual({ ok: true, version: s.services.version });
    expect(jobsSeen).toEqual(['function']);
    await sql`insert into ext_things (id) values ('x')`.execute(s.services.dbs.main.db);
    const m = await sql<{ name: string }>`select name from kysely_migration order by name`.execute(s.services.dbs.main.db);
    expect(m.rows.map((r) => r.name).at(-1)).toBe('c0001_test');
  });

  it('merges extension features into /api/auth/config', async () => {
    const cfg = (await (await fetch(`${s.url}/api/auth/config`)).json()) as { features: unknown };
    expect(cfg.features).toEqual({ tenancy: { multi: false }, billing: true });
  });

  it('feeds the usage sink one tool_calls event per tool call, with the tenant; code runs go through the decorated executor', async () => {
    const key = await keyFor(s, 'petstore', 'dev', ['tools:read', 'code:run']);
    const c = await mcpClient(s, 'petstore', 'dev', key);
    await c.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 1 } });
    await c.callTool({ name: 'run_script', arguments: { code: 'print(1)' } }).catch(() => null);
    await c.close();
    await s.services.auditStore.flush();
    await new Promise((r) => setTimeout(r, 50));
    const calls = usage.events.filter((e) => e.meter === 'tool_calls');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0]!.tenantId).toBe((await s.services.tenancy.defaultTenant())!.id);
    expect(exec.runs).toBeGreaterThanOrEqual(1);
  });
});

describe('NEUROUTER_MAINTENANCE', () => {
  it('503 on /mcp and on mutating /api calls; reads keep working', async () => {
    const t = await createTestContext({ NEUROUTER_MAINTENANCE: 'true' });
    try {
      expect((await t.as(t.admin, { url: '/api/servers' })).statusCode).toBe(200);
      const w = await t.as(t.admin, { method: 'PATCH', url: '/api/settings', payload: { general: { orgName: 'x' } } });
      expect(w.statusCode).toBe(503);
      expect(w.headers['retry-after']).toBe('120');
      const m = await t.s.app.inject({ method: 'POST', url: '/mcp/petstore/dev', payload: '{}', headers: { 'content-type': 'application/json' } });
      expect(m.statusCode).toBe(503);
      expect(JSON.parse(m.body).error).toBe('maintenance');
    } finally {
      await t.close();
    }
  });
});

describe('NEUROUTER_RESOURCE_ALIASES', () => {
  const base = { publicUrl: 'https://app.neurouter.com', aliases: ['https://old-demo.a.run.app/'] };
  it('treats alias + /mcp/... as the current resource', () => {
    expect(canonicalResource('https://old-demo.a.run.app/mcp/github/mock', base)).toBe('https://app.neurouter.com/mcp/github/mock');
    expect(sameResource('https://old-demo.a.run.app/mcp/github/mock', 'https://app.neurouter.com/mcp/github/mock', base)).toBe(true);
    expect(sameResource('https://old-demo.a.run.app/mcp/github/mock', 'https://app.neurouter.com/mcp/github/mock')).toBe(false);
    expect(dataplaneSameResource('https://old-demo.a.run.app/mcp/github/mock', 'https://app.neurouter.com/mcp/github/mock', base)).toBe(true);
    expect(sameResource('https://evil.test/mcp/github/mock', 'https://app.neurouter.com/mcp/github/mock', base)).toBe(false);
  });
  it('resolveResource accepts an alias URL and canonicalises it', async () => {
    const t = await createTestContext();
    try {
      await importPetstore(t);
      const r = await resolveResource(t.s.services.dbs.main.db, { publicUrl: 'http://console.test', aliases: ['https://old.example.test'], tenancy: t.s.services.tenancy }, 'https://old.example.test/mcp/petstore/mock');
      expect(r?.resource).toBe('http://console.test/mcp/petstore/mock');
    } finally {
      await t.close();
    }
  });
});

describe('METRICS_PER_SERVER_LABELS', () => {
  it('blanks server/environment label values when false', async () => {
    const off = new Metrics({ defaultMetrics: false, perServerLabels: false });
    off.toolCall('petstore', 'prod', 'get_pet', 'direct', 'allowed', 'ok', 0.01);
    off.unmetNeeds.inc({ server: 'petstore' });
    const body = (await off.render()).body;
    expect(body).not.toContain('petstore');
    expect(body).toContain('server=""');
    const on = new Metrics({ defaultMetrics: false });
    on.toolCall('petstore', 'prod', 'get_pet', 'direct', 'allowed', 'ok', 0.01);
    expect((await on.render()).body).toContain('server="petstore"');
  });
});
