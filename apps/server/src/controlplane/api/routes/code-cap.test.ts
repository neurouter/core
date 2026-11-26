import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, importPetstore, PETSTORE, type TestContext } from '../../../test/fakes/app-context.js';

describe('instance code-limit cap (settings codeLimitsCap)', () => {
  let t: TestContext;
  let server: any;
  beforeAll(async () => {
    t = await createTestContext();
    server = await importPetstore(t);
  }, 60_000);
  afterAll(async () => t?.close());

  it('the settings view reports the cap; console limits above it are 422 with the field', async () => {
    const s = await t.json(t.admin, { url: '/api/settings' }, 200);
    expect(s.codeMode.cap).toMatchObject({ maxToolCalls: 1000, wallTimeSec: 120, maxMemoryMb: 512 });
    const r = await t.as(t.admin, { method: 'POST', url: `/api/servers/${server.id}/environments`, payload: { slug: 'dev', kind: 'dev', baseUrl: 'mock:', limits: { code: { maxToolCalls: 5000, maxMemoryMb: 1024 } } } });
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.body).errors.map((e: { path: string[] }) => e.path.join('.'))).toEqual(['limits.code.maxToolCalls', 'limits.code.maxMemoryMb']);
    await t.json(t.admin, { method: 'POST', url: `/api/servers/${server.id}/environments`, payload: { slug: 'dev', kind: 'dev', baseUrl: 'mock:', limits: { code: { maxToolCalls: 900 } } } }, 201);
  });

  it('stored limits above the cap (older rows, a lowered cap) are clamped at runtime', async () => {
    const db = t.s.services.dbs.main.db;
    const env = await db.selectFrom('environments').select(['id']).where('server_id', '=', server.id).where('slug', '=', 'dev').executeTakeFirstOrThrow();
    await db.updateTable('environments').set({ limits: JSON.stringify({ code: { maxToolCalls: 9000, wallTimeSec: 600, maxMemoryMb: 4096 } }) }).where('id', '=', env.id).execute();
    t.s.services.runtime.invalidate();
    let b = await t.s.services.runtime.getByEnvironmentId(DEFAULT_TENANT_ID, env.id);
    expect(b!.environment.limits.code).toMatchObject({ maxToolCalls: 1000, wallTimeSec: 120, maxMemoryMb: 512, cpuTimeSec: 10 });
    // lowering the cap applies to running environments (and to the defaults)
    await t.json(t.admin, { method: 'PATCH', url: '/api/settings', payload: { codeMode: { defaults: { maxToolCalls: 100 } } } }, 200);
    b = await t.s.services.runtime.getByEnvironmentId(DEFAULT_TENANT_ID, env.id);
    expect(b!.environment.limits.code.maxToolCalls).toBe(100);
    const s = await t.json(t.admin, { url: '/api/settings' }, 200);
    expect(s.codeMode).toMatchObject({ cap: { maxToolCalls: 100 }, defaults: { maxToolCalls: 100 } });
  });

  it('neurouter.yaml limits above the cap get a limits_capped warning', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-cap-'));
    const f = join(dir, 'neurouter.yaml');
    writeFileSync(f, `version: 1\nservers:\n  - slug: capped\n    name: Capped\n    spec: { path: ${PETSTORE} }\n    environments:\n      - slug: dev\n        kind: dev\n        baseUrl: "mock:"\n        limits:\n          code: { wallTimeSec: 300 }\n`);
    const r = await t.s.services.configSync.loadFile(f);
    expect(r.ok).toBe(true);
    expect(r.diagnostics).toContainEqual(expect.objectContaining({ severity: 'warning', code: 'limits_capped', message: expect.stringContaining('wallTimeSec: 300 is above the instance cap 120') }));
  });
});
