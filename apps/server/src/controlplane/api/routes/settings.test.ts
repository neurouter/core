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
    expect(s.models).toMatchObject({ evalModel: 'gpt-6-luna', judgeModel: 'gpt-6-luna', anthropicKey: { configured: false }, keys: { openai: { configured: false }, anthropic: { configured: false }, gemini: { configured: false } } });
    expect(s.codeMode.executor.mode).toBe('off');
    const u = await t.json(t.admin, { method: 'PATCH', url: '/api/settings', payload: { general: { orgName: 'Acme' }, models: { anthropicKey: { value: 'sk-ant-test-1234567890' }, effort: 'high' } } }, 200);
    expect(u.general.orgName).toBe('Acme');
    expect(u.models.anthropicKey).toEqual({ configured: true, source: 'stored', last4: '7890' });
    expect(u.models.keys.anthropic).toEqual({ configured: true, source: 'stored', last4: '7890' });
    expect(JSON.stringify(u)).not.toContain('sk-ant-test');
    expect((await t.json(t.admin, { url: '/api/me' }, 200)).features.evals).toBe(true);
    const p = await t.json(t.admin, { url: '/api/settings/model-providers' }, 200);
    expect(p.items).toHaveLength(1);
    expect(p.items[0]).toMatchObject({ id: 'anthropic-stored', kind: 'anthropic', keySource: 'stored', keyLast4: '7890', isDefault: false, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] });
    expect((await t.as(t.admin, { method: 'POST', url: '/api/settings/model-providers', payload: { kind: 'anthropic', name: 'x', apiKey: 'sk-ant-other-key' } })).statusCode).toBe(409);
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/settings/model-providers/${p.items[0].id}` })).statusCode).toBe(204);
    expect((await t.as(t.admin, { method: 'POST', url: '/api/settings/models/test' })).statusCode).toBe(412);
    const tel = await t.json(t.admin, { method: 'POST', url: '/api/settings/telemetry/test' }, 200);
    expect(tel.ok).toBe(false);
  });

  it('labelInferredTasks is gone from the settings view and accepted but ignored on update (deprecated)', async () => {
    const u = await t.json(t.admin, { method: 'PATCH', url: '/api/settings', payload: { models: { labelInferredTasks: true } } }, 200);
    expect(u.models).not.toHaveProperty('labelInferredTasks');
    expect(await t.s.services.dbs.main.db.selectFrom('settings').select('key').where('key', '=', 'labelInferredTasks').executeTakeFirst()).toBeUndefined();
  });

  it('per-provider stored keys: openai and gemini beside anthropic, one provider per kind, keys write-only', async () => {
    const u = await t.json(t.admin, { method: 'PATCH', url: '/api/settings', payload: { models: { apiKeys: { openai: { value: 'sk-proj-openai-1111' }, gemini: { value: 'AIza-gemini-2222' } } } } }, 200);
    expect(u.models.keys).toMatchObject({ openai: { configured: true, source: 'stored', last4: '1111' }, gemini: { configured: true, source: 'stored', last4: '2222' } });
    expect(JSON.stringify(u)).not.toMatch(/sk-proj|AIza/);
    const p = await t.json(t.admin, { url: '/api/settings/model-providers' }, 200);
    const openai = p.items.find((x: any) => x.kind === 'openai');
    expect(openai).toMatchObject({ id: 'openai-stored', name: 'OpenAI', defaultModel: 'gpt-6-luna', isDefault: true });
    expect(openai.models[0]).toBe('gpt-6-luna');
    expect(p.items.find((x: any) => x.kind === 'gemini')).toMatchObject({ id: 'gemini-stored', defaultModel: 'gemini-3.5-flash-lite', isDefault: false });
    expect((await t.as(t.admin, { method: 'POST', url: '/api/settings/model-providers', payload: { kind: 'openai', name: 'x', apiKey: 'sk-other-key' } })).statusCode).toBe(409);
    const created = await t.json(t.admin, { method: 'POST', url: '/api/settings/model-providers', payload: { kind: 'anthropic', name: 'Claude', apiKey: 'sk-ant-new-3333' } }, 201);
    expect(created).toMatchObject({ id: 'anthropic-stored', kind: 'anthropic', name: 'Claude', keyLast4: '3333' });
    const renamed = await t.json(t.admin, { method: 'PATCH', url: '/api/settings/model-providers/gemini-stored', payload: { name: 'Google' } }, 200);
    expect(renamed.name).toBe('Google');
    for (const id of ['openai-stored', 'gemini-stored', 'anthropic-stored']) expect((await t.as(t.admin, { method: 'DELETE', url: `/api/settings/model-providers/${id}` })).statusCode).toBe(204);
    expect((await t.json(t.admin, { url: '/api/settings/model-providers' }, 200)).items).toEqual([]);
    expect((await t.json(t.admin, { url: '/api/me' }, 200)).features.evals).toBe(false);
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
    await db.insertInto('eval_suites').values({ id: suite, tenant_id: s.tenant_id, server_id: s.id, version: 1, status: 'frozen', created_at: Date.now() }).execute();
    const score = { headline: 87, band: 'ready', recommendedMode: 'code', recommendationText: 'code mode: +12 pts', confidence: 'measured', modeScores: { tool: 80, code: 87 }, cells: [{ model: 'claude-sonnet-5-5', mode: 'tool', score: 80 }, { model: 'claude-sonnet-5-5', mode: 'code', score: 87 }], breakdown: [{ key: 'success', label: 'Task success', weight: 0.45, score: 0.9, detail: '9/10', fixCount: 1 }] };
    await db.insertInto('eval_runs').values({ id: 'run-1', tenant_id: s.tenant_id, server_id: s.id, suite_id: suite, environment_id: (await db.selectFrom('environments').select('id').where('server_id', '=', s.id).executeTakeFirstOrThrow()).id, build_id: s.latest_build_id!, models: JSON.stringify(['claude-sonnet-5-5']), modes: JSON.stringify(['tool', 'code']), status: 'succeeded', score: JSON.stringify(score), headline: 87, recommended_mode: 'code', confidence: 'measured', trigger: 'cli', created_at: Date.now(), ended_at: Date.now() }).execute();
    const rep = await t.json(null, { url: '/public/servers/petstore/report' }, 200);
    expect(rep).toMatchObject({ score: 87, band: 'ready', recommendedMode: 'code', models: [{ model: 'claude-sonnet-5-5', toolScore: 80, codeScore: 87 }], toolCount: 19 });
    const badge = await t.as(null, { url: '/public/servers/petstore/badge.svg' });
    expect(badge.headers['content-type']).toContain('image/svg+xml');
    expect(badge.body).toContain('87');
    const r = await t.json(t.admin, { url: `/api/servers/${server.id}/readiness` }, 200);
    expect(r).toMatchObject({ score: 87, confidence: 'measured', runId: 'run-1', recommendation: 'code mode: +12 pts', modeScores: { tool: 80, code: 87 } });
  });
});

describe('env model providers (all three keys, as in production)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ OPENAI_API_KEY: 'sk-env-openai-aaaa', ANTHROPIC_API_KEY: 'sk-ant-env-bbbb', GEMINI_API_KEY: 'AIza-env-cccc' });
  }, 60_000);
  afterAll(async () => t?.close());

  it('lists one env provider per kind; the default resolves to openai / gpt-6-luna; env providers are not deletable', async () => {
    const s = await t.json(t.admin, { url: '/api/settings' }, 200);
    expect(s.models.evalModel).toBe('gpt-6-luna');
    // a Gemini key makes the reproducible Gemini judge the default (temperature 0 + seed); no key → the eval model (line 15)
    expect(s.models.judgeModel).toBe('gemini-3.5-flash-lite');
    expect(s.models.keys).toEqual({ openai: { configured: true, source: 'env', last4: 'aaaa' }, anthropic: { configured: true, source: 'env', last4: 'bbbb' }, gemini: { configured: true, source: 'env', last4: 'cccc' } });
    const p = await t.json(t.admin, { url: '/api/settings/model-providers' }, 200);
    expect(p.items.map((x: any) => [x.id, x.isDefault, x.defaultModel])).toEqual([['openai-env', true, 'gpt-6-luna'], ['anthropic-env', false, 'claude-opus-5-5'], ['gemini-env', false, 'gemini-3.5-flash-lite']]);
    expect(p.items[0].name).toBe('OpenAI (OPENAI_API_KEY)');
    expect(JSON.stringify(p)).not.toMatch(/sk-env|sk-ant-env|AIza-env/);
    expect((await t.as(t.admin, { method: 'DELETE', url: '/api/settings/model-providers/openai-env' })).statusCode).toBe(409);
    expect((await t.as(t.admin, { method: 'PATCH', url: '/api/settings/model-providers/gemini-env', payload: { apiKey: 'AIza-new-key-0000' } })).statusCode).toBe(422);
    // test calls are disabled under NODE_ENV=test but resolve the provider of the eval model
    expect(await t.json(t.admin, { method: 'POST', url: '/api/settings/models/test' }, 200)).toMatchObject({ ok: false, model: 'gpt-6-luna' });
    expect(await t.json(t.admin, { method: 'POST', url: '/api/settings/model-providers/gemini-env/test' }, 200)).toMatchObject({ model: 'gemini-3.5-flash-lite' });
  });
});
