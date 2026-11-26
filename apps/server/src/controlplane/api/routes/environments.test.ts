import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { createTestContext, importPetstore, REPO_ROOT, type TestContext } from '../../../test/fakes/app-context.js';

describe('environments API', () => {
  let t: TestContext;
  let id: string;
  beforeAll(async () => {
    t = await createTestContext();
    id = (await importPetstore(t)).id;
  }, 60_000);
  afterAll(async () => t?.close());

  it('creates a read-only prod environment; setWrites enforces prod rules; matrix and cells', async () => {
    const e = await t.json(t.admin, { method: 'POST', url: `/api/servers/${id}/environments`, payload: { slug: 'prod', kind: 'prod', baseUrl: 'https://petstore3.swagger.io/api/v3', auth: { type: 'bearer', secretRef: 'secret:pet_token' } } }, 201);
    expect(e.writes).toMatchObject({ enabled: false });
    expect(e.credential).toBe('missing');
    expect(e.auth).toMatchObject({ type: 'bearer', secretRef: 'secret:pet_token', hasSecret: false });
    const none = await t.as(t.admin, { method: 'PUT', url: `/api/environments/${e.id}/writes`, payload: { enabled: true, confirm: 'none', confirmEnvironmentSlug: 'prod' } });
    expect(none.statusCode).toBe(422);
    const mismatch = await t.as(t.admin, { method: 'PUT', url: `/api/environments/${e.id}/writes`, payload: { enabled: true, confirm: 'elicit', confirmEnvironmentSlug: 'dev' } });
    expect(mismatch.statusCode).toBe(422);
    const ok = await t.json(t.admin, { method: 'PUT', url: `/api/environments/${e.id}/writes`, payload: { enabled: true, confirm: 'elicit', confirmEnvironmentSlug: 'prod', tools: ['add_pet'] } }, 200);
    expect(ok.writes).toMatchObject({ enabled: true, confirm: 'elicit', enabledToolNames: ['add_pet'] });
    const cell = await t.json(t.admin, { method: 'PUT', url: `/api/environments/${e.id}/writes/tools/update_pet`, payload: { enabled: true } }, 200);
    expect(cell.writes.enabledToolNames.sort()).toEqual(['add_pet', 'update_pet']);
    const m = await t.json(t.admin, { url: `/api/servers/${id}/write-switches` }, 200);
    const row = m.tools.find((x: any) => x.name === 'add_pet');
    expect(row.cells).toMatchObject({ prod: true, mock: true });
  });

  it('secrets are write-only; credential becomes ok', async () => {
    const list = await t.json(t.admin, { url: `/api/servers/${id}/environments` }, 200);
    const prod = list.items.find((e: any) => e.slug === 'prod');
    const s = await t.json(t.admin, { method: 'PUT', url: `/api/environments/${prod.id}/secrets/pet_token`, payload: { value: 'super-secret-value' } }, 200);
    expect(s).toMatchObject({ name: 'pet_token', ref: 'secret:pet_token' });
    const e = await t.json(t.admin, { url: `/api/environments/${prod.id}` }, 200);
    expect(e.credential).toBe('ok');
    expect(JSON.stringify(e)).not.toContain('super-secret-value');
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/environments/${prod.id}/secrets/pet_token` })).statusCode).toBe(204);
  });

  it('mock: test probe, test read call, reset; builtin mock cannot be deleted', async () => {
    const list = await t.json(t.admin, { url: `/api/servers/${id}/environments` }, 200);
    const mock = list.items.find((e: any) => e.slug === 'mock');
    expect(mock).toMatchObject({ isMock: true, builtin: true });
    const probe = await t.json(t.admin, { method: 'POST', url: `/api/environments/${mock.id}/test`, payload: {} }, 200);
    expect(probe.ok).toBe(true);
    const call = await t.json(t.admin, { method: 'POST', url: `/api/environments/${mock.id}/test`, payload: { toolName: 'get_pet_by_id', arguments: { pet_id: 1 } } }, 200);
    expect(call.ok).toBe(true);
    const w = await t.json(t.admin, { method: 'POST', url: `/api/environments/${mock.id}/test`, payload: { toolName: 'add_pet', arguments: {} } }, 200);
    expect(w.ok).toBe(false);
    expect((await t.as(t.admin, { method: 'POST', url: `/api/environments/${mock.id}/mock/reset`, payload: { seed: 7 } })).statusCode).toBe(204);
    expect((await t.as(t.admin, { method: 'DELETE', url: `/api/environments/${mock.id}?confirm=mock` })).statusCode).toBe(409);
  });

  it('pin build: other server → 422', async () => {
    const list = await t.json(t.admin, { url: `/api/servers/${id}/environments` }, 200);
    const prod = list.items.find((e: any) => e.slug === 'prod');
    const builds = await t.json(t.admin, { url: `/api/servers/${id}/builds` }, 200);
    expect((await t.json(t.admin, { method: 'PUT', url: `/api/environments/${prod.id}/build`, payload: { buildId: builds.items[0].id } }, 200)).buildId).toBe(builds.items[0].id);
    expect((await t.as(t.admin, { method: 'PUT', url: `/api/environments/${prod.id}/build`, payload: { buildId: 'nope' } })).statusCode).toBe(422);
  });
});

describe('config_managed (neurouter.yaml)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ NEUROUTER_CONFIG: resolve(REPO_ROOT, 'neurouter.example.yaml') });
  }, 60_000);
  afterAll(async () => t?.close());

  it('file-managed servers and environments answer 409 with path and line; config status/validate/export', async () => {
    const list = await t.json(t.admin, { url: '/api/servers' }, 200);
    const s = list.items.find((x: any) => x.slug === 'petstore');
    expect(s.managedBy).toBe('file');
    const upd = await t.as(t.admin, { method: 'PATCH', url: `/api/servers/${s.id}`, payload: { description: 'x' } });
    expect(upd.statusCode).toBe(409);
    expect(JSON.parse(upd.body)).toMatchObject({ code: 'config_managed', configLine: expect.any(Number) });
    const envs = await t.json(t.admin, { url: `/api/servers/${s.id}/environments` }, 200);
    const dev = envs.items.find((e: any) => e.slug === 'dev');
    expect(dev.config.path).toContain('neurouter.example.yaml');
    const r = await t.as(t.admin, { method: 'PUT', url: `/api/environments/${dev.id}/writes`, payload: { enabled: false, confirm: 'none' } });
    expect(JSON.parse(r.body).code).toBe('config_managed');
    const st = await t.json(t.admin, { url: '/api/config' }, 200);
    expect(st).toMatchObject({ mode: 'hybrid', status: 'ok', managed: { servers: 1 } });
    const v = await t.json(t.admin, { method: 'POST', url: '/api/config/validate', payload: { yaml: 'version: 1\nservers:\n  - slug: x\n' } }, 200);
    expect(v.ok).toBe(false);
    expect(v.diagnostics[0].line).toBeGreaterThan(0);
    const ex = await t.as(t.admin, { url: '/api/config/export' });
    expect(ex.body).toContain('slug: petstore');
    expect((await t.json(t.admin, { method: 'POST', url: '/api/config/reload' }, 200)).status).toBe('ok');
  });
});
