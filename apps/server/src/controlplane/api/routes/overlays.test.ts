import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, importPetstore, type TestContext } from '../../../test/fakes/app-context.js';

describe('overlays API (draft → publish)', () => {
  let t: TestContext;
  let id: string;
  beforeAll(async () => {
    t = await createTestContext();
    id = (await importPetstore(t)).id;
  }, 60_000);
  afterAll(async () => t?.close());

  it('draft = published (empty) with an ETag; If-Match required; stale ETag → 409 draft_conflict', async () => {
    const r = await t.as(t.admin, { url: `/api/servers/${id}/overlay/draft` });
    const d = JSON.parse(r.body);
    expect(r.headers.etag).toBe(d.etag);
    expect(d).toMatchObject({ changeCount: 0, basedOnRev: null, preview: { visibleCount: 19 } });
    const noMatch = await t.as(t.admin, { method: 'PATCH', url: `/api/servers/${id}/overlay/draft`, payload: { yaml: 'overlay: 1\n' } });
    expect(noMatch.statusCode).toBe(412);
    const stale = await t.as(t.admin, { method: 'PATCH', url: `/api/servers/${id}/overlay/draft`, payload: { yaml: 'overlay: 1\n' }, headers: { 'if-match': '"stale"' } });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe('draft_conflict');
  });

  it('patch ops keep YAML comments; invalid YAML → 422 overlay_invalid; publish builds and pins dev/mock', async () => {
    let d = await t.json(t.admin, { url: `/api/servers/${id}/overlay/draft` }, 200);
    d = await t.json(t.admin, { method: 'PATCH', url: `/api/servers/${id}/overlay/draft`, payload: { yaml: '# curated by the platform team\noverlay: 1\ntools:\n  "operationId:getPetById":\n    # keep this short\n    title: Get a pet\n' }, headers: { 'if-match': d.etag } }, 200);
    d = await t.json(t.admin, { method: 'PATCH', url: `/api/servers/${id}/overlay/draft`, payload: { ops: [{ op: 'set', selector: 'operationId:deletePet', field: 'hidden', value: true }, { op: 'set', selector: 'operationId:getPetById', field: 'name', value: 'get_pet' }] }, headers: { 'if-match': d.etag } }, 200);
    expect(d.yaml).toContain('# curated by the platform team');
    expect(d.yaml).toContain('# keep this short');
    expect(d.changeCount).toBeGreaterThan(0);
    expect(d.preview.visibleCount).toBe(18);
    const bad = await t.as(t.admin, { method: 'PATCH', url: `/api/servers/${id}/overlay/draft`, payload: { yaml: 'overlay: 1\ntools: [nope' }, headers: { 'if-match': d.etag } });
    expect(bad.statusCode).toBe(422);
    expect(JSON.parse(bad.body).code).toBe('overlay_invalid');
    const pub = await t.json(t.admin, { method: 'POST', url: `/api/servers/${id}/overlay/publish`, payload: { message: 'hide delete, rename get' }, headers: { 'if-match': d.etag } }, 200);
    expect(pub.revision.rev).toBe(1);
    expect(pub.build.visibleCount).toBe(18);
    expect(pub.pinnedEnvironments.map((e: any) => e.slug)).toContain('mock');
    const tools = await t.json(t.admin, { url: `/api/servers/${id}/tools` }, 200);
    expect(tools.items.map((x: any) => x.name)).toContain('get_pet');
    const after = await t.json(t.admin, { url: `/api/servers/${id}/overlay/draft` }, 200);
    expect(after.changeCount).toBe(0);
  });

  it('versions, getVersion, diff, download, validate, revert', async () => {
    const v = await t.json(t.admin, { url: `/api/servers/${id}/overlay/versions` }, 200);
    expect(v.items).toHaveLength(1);
    const one = await t.json(t.admin, { url: `/api/overlays/${v.items[0].id}` }, 200);
    expect(one.yaml).toContain('get_pet');
    const diff = await t.json(t.admin, { url: `/api/servers/${id}/overlay/diff?from=0&to=1` }, 200);
    expect(diff.toolChanges.map((c: any) => c.toolName)).toContain('get_pet');
    const dl = await t.as(t.admin, { url: `/api/servers/${id}/overlay/download` });
    expect(dl.headers['content-type']).toContain('yaml');
    const val = await t.json(t.admin, { method: 'POST', url: '/api/overlays/validate', payload: { serverId: id, yaml: 'overlay: 1\ntools:\n  "operationId:nope":\n    hidden: true\n' } }, 200);
    expect(val.ok).toBe(true);
    const rev = await t.json(t.admin, { method: 'POST', url: `/api/servers/${id}/overlay/revert`, payload: { toRev: 1, message: 'again' } }, 200);
    expect(rev.revision).toMatchObject({ rev: 2, source: 'revert' });
  });

  it('tool detail with agent view (exact tools/list entry + python), preview with token estimates, search', async () => {
    const tools = await t.json(t.admin, { url: `/api/servers/${id}/tools` }, 200);
    const get = tools.items.find((x: any) => x.name === 'get_pet');
    const d = await t.json(t.admin, { url: `/api/tools/${get.id}` }, 200);
    expect(d.agentView.mcp).toMatchObject({ name: 'get_pet', _meta: { 'dev.neurouter/write': false } });
    expect(d.agentView.python).toContain('def get_pet(');
    expect(d.overlayEntry).toMatchObject({ name: 'get_pet' });
    const p = await t.json(t.admin, { method: 'POST', url: `/api/servers/${id}/overlay/preview`, payload: { toolName: 'get_pet', ops: [{ op: 'set', selector: 'operationId:getPetById', field: 'response', value: { include: ['id', 'name'] } }] } }, 200);
    expect(p.tokens.estimated).toBe(true);
    expect(p.tokens.definition).toBeGreaterThan(0);
    const s = await t.json(t.admin, { url: `/api/servers/${id}/tools/search?q=find%20pets%20by%20status` }, 200);
    expect(s.tools[0].name).toBe('find_pets_by_status');
    const all = await t.json(t.admin, { url: '/api/tools/search?q=pet' }, 200);
    expect(all.items.length).toBeGreaterThan(0);
  });
});
