import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SAMPLE_SPEC_URL } from '@neurouter/shared';
import { createTestContext, REPO_ROOT, type TestContext } from '../../../test/fakes/app-context.js';
import { SAMPLE_SPEC_YAML } from '../../servers/sample-spec.js';

describe('"Try the sample" (bundled Acme Orders spec)', () => {
  let t: TestContext;
  let fetches = 0;
  beforeAll(async () => {
    const offline = async () => {
      fetches++;
      throw new Error('network is off in this test');
    };
    t = await createTestContext({}, { outboundFetch: offline as never });
  }, 60_000);
  afterAll(async () => t?.close());

  it('the bundled copy equals examples/acme-orders/openapi.yaml', () => {
    expect(SAMPLE_SPEC_YAML).toBe(readFileSync(resolve(REPO_ROOT, 'examples/acme-orders/openapi.yaml'), 'utf8'));
  });

  it('imports without network access and answers tool calls on the mock environment', async () => {
    const acc = await t.json(t.admin, { method: 'POST', url: '/api/spec-previews', payload: { source: { url: SAMPLE_SPEC_URL } } }, 202);
    const p = await t.json(t.admin, { url: `/api/spec-previews/${acc.previewId}` }, 200);
    expect(p).toMatchObject({ status: 'ready', title: 'Acme Orders API', slug: 'acme-orders-api', counts: { tools: 14, writeTools: 5 } });
    expect(p.diagnostics.filter((d: { severity: string }) => d.severity === 'error')).toEqual([]);
    const s = await t.json(t.admin, { method: 'POST', url: '/api/servers', payload: { previewId: p.id, slug: 'acme-orders', name: 'Acme Orders API' } }, 201);
    expect(s.environments.map((e: { slug: string }) => e.slug)).toEqual(['mock']);
    const mock = s.environments[0];
    const list = await t.json(t.admin, { method: 'POST', url: `/api/environments/${mock.id}/test`, payload: { toolName: 'list_orders', arguments: {} } }, 200);
    expect(list.ok).toBe(true);
    expect((list.result as { items: unknown[] }).items.length).toBeGreaterThan(0);
    // re-import refetches the stored sample URL from the bundle too
    expect((await t.as(t.admin, { method: 'POST', url: `/api/servers/${s.id}/specs`, payload: {} })).statusCode).toBe(202);
    expect(fetches).toBe(0);
  });
});
