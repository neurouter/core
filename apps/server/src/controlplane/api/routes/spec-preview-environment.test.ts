import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from '../../../test/fakes/app-context.js';

const openapi = (servers: string) => `openapi: 3.1.0
info: { title: Hint API, version: '1' }
${servers}
paths:
  /things:
    get:
      operationId: listThings
      responses: { '200': { description: ok } }
`;

describe('spec preview: OpenAPI servers[0].url as the environment hint', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  }, 60_000);
  afterAll(async () => t?.close());

  const hintOf = async (content: string) => {
    const acc = await t.json(t.admin, { method: 'POST', url: '/api/spec-previews', payload: { source: { content } } }, 202);
    const p = await t.json(t.admin, { url: `/api/spec-previews/${acc.previewId}` }, 200);
    expect(p.status).toBe('ready');
    return p.environmentHint;
  };

  it('an absolute servers[0].url becomes the suggested base URL (no credential, no GraphQL path)', async () => {
    expect(await hintOf(openapi('servers:\n  - url: https://api.hint.test/v1/\n  - url: https://sandbox.hint.test/v1'))).toEqual({ source: 'openapi_servers', baseUrl: 'https://api.hint.test/v1', endpointPath: null, auth: null });
  });

  it.each([
    ['no servers', ''],
    ['a relative URL', 'servers:\n  - url: /api/v3'],
    ['a templated URL', 'servers:\n  - url: https://{region}.hint.test/v1\n    variables: { region: { default: eu } }'],
    ['a non-http URL', 'servers:\n  - url: ftp://files.hint.test'],
  ])('%s → no hint', async (_name, servers) => {
    expect(await hintOf(openapi(servers))).toBeNull();
  });
});
