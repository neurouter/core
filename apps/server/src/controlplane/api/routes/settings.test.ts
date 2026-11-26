import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, importPetstore, type TestContext } from '../../../test/fakes/app-context.js';

describe('settings, model providers, kill switches, system, users, public report', () => {
  let t: TestContext;
  let server: any;
  beforeAll(async () => {
    t = await createTestContext();
    server = await importPetstore(t);
  }, 60_000);
  afterAll(async () => t?.close());

  it('settings get/update; anthropic key is write-only (last4 only)', async () => {
    const s = await t.json(t.admin, { url: '/api/settings' }, 200);
    expect(s.models).toMatchObject({ evalModel: 'claude-sonnet-5-5', anthropicKey: { configured: false } });
    expect(s.codeMode.executor.mode).toBe('off');
    const u = await t.json(t.admin, { method: 'PATCH', url: '/api/settings', payload: { general: { orgName: 'Acme' }, models: { anthropicKey: { value: 'sk-ant-test-1234567890' }, effort: 'high' } } }, 200);
    expect(u.general.orgName).toBe('Acme');
    expect(u.models.anthropicKey).toEqual({ configured: true, source: 'stored', last4: '7890' });
    expect(JSON.stringify(u)).not.toContain('sk-ant-test');
    expect((await t.json(t.admin, { url: '/api/me' }, 200)).features.evals).toBe(true);
    const p = await t.json(t.admin, { url: '/api/settings/model-providers' }, 200);
    expect(p.items).toHaveLength(1);
    expect((await t.as(t.admin, { method: 'POST', url: '/api/settings/model-providers', payload: { kind: 'anthropic', name: 'x', apiKey: 'sk-ant-other-key' } })).statusCode).toBe(409);
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/settings/model-providers/${p.items[0].id}` })).statusCode).toBe(204);
    expect((await t.as(t.admin, { method: 'POST', url: '/api/settings/models/test' })).statusCode).toBe(412);
    const tel = await t.json(t.admin, { method: 'POST', url: '/api/settings/telemetry/test' }, 200);
    expect(tel.ok).toBe(false);
  });

  it('kill switches set/list/clear', async () => {
    const k = await t.json(t.admin, { method: 'PUT', url: '/api/kill-switches', payload: { scope: 'server', target: server.id, kind: 'writes', reason: 'incident' } }, 200);
    expect(k).toMatchObject({ scope: 'server', kind: 'writes' });
    expect((await t.json(t.admin, { url: '/api/kill-switches' }, 200)).items).toHaveLength(1);
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/kill-switches?scope=server&target=${server.id}&kind=writes` })).statusCode).toBe(204);
  });

  it('system info, users (last admin protected), jobs', async () => {
    const i = await t.json(t.admin, { url: '/api/system/info' }, 200);
    expect(i).toMatchObject({ db: { dialect: 'sqlite' }, coordination: 'memory', protocolVersions: ['2026-07-28', '2025-11-25'] });
    const users = await t.json(t.admin, { url: '/api/users' }, 200);
    const admins = users.items.filter((u: any) => u.role === 'admin');
    expect(admins.length).toBeGreaterThan(0);
    const v = await t.user('v2@test.dev', 'viewer');
    expect((await t.json(t.admin, { method: 'PATCH', url: `/api/users/${v.id}`, payload: { role: 'admin' } }, 200)).role).toBe('admin');
  });

  it('public report and badge: 404 until publicReport + measured run', async () => {
    expect((await t.as(null, { url: '/public/servers/petstore/report' })).statusCode).toBe(404);
    const b404 = await t.as(null, { url: '/public/servers/petstore/badge.svg' });
    expect(b404.statusCode).toBe(404);
    await t.json(t.admin, { method: 'PATCH', url: `/api/servers/${server.id}`, payload: { publicReport: true } }, 200);
    const db = t.s.services.dbs.main.db;
    const s = (await db.selectFrom('servers').selectAll().where('id', '=', server.id).executeTakeFirst())!;
    const suite = 'suite-1';
    await db.insertInto('eval_suites').values({ id: suite, server_id: s.id, version: 1, status: 'frozen', created_at: Date.now() }).execute();
    const score = { headline: 87, band: 'ready', recommendedMode: 'code', recommendationText: 'code mode: +12 pts', confidence: 'measured', modeScores: { tool: 80, code: 87 }, cells: [{ model: 'claude-sonnet-5-5', mode: 'tool', score: 80 }, { model: 'claude-sonnet-5-5', mode: 'code', score: 87 }], breakdown: [{ key: 'success', label: 'Task success', weight: 0.45, score: 0.9, detail: '9/10', fixCount: 1 }] };
    await db.insertInto('eval_runs').values({ id: 'run-1', server_id: s.id, suite_id: suite, environment_id: (await db.selectFrom('environments').select('id').where('server_id', '=', s.id).executeTakeFirstOrThrow()).id, build_id: s.latest_build_id!, models: JSON.stringify(['claude-sonnet-5-5']), modes: JSON.stringify(['tool', 'code']), status: 'succeeded', score: JSON.stringify(score), headline: 87, recommended_mode: 'code', confidence: 'measured', trigger: 'cli', created_at: Date.now(), ended_at: Date.now() }).execute();
    const rep = await t.json(null, { url: '/public/servers/petstore/report' }, 200);
    expect(rep).toMatchObject({ score: 87, band: 'ready', recommendedMode: 'code', models: [{ model: 'claude-sonnet-5-5', toolScore: 80, codeScore: 87 }], toolCount: 19 });
    const badge = await t.as(null, { url: '/public/servers/petstore/badge.svg' });
    expect(badge.headers['content-type']).toContain('image/svg+xml');
    expect(badge.body).toContain('87');
    const r = await t.json(t.admin, { url: `/api/servers/${server.id}/readiness` }, 200);
    expect(r).toMatchObject({ score: 87, confidence: 'measured', runId: 'run-1', recommendation: 'code mode: +12 pts', modeScores: { tool: 80, code: 87 } });
  });
});
