import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '@neurouter/shared';
import { createTestContext, type TestContext } from '../../test/fakes/app-context.js';

/**
 * Keys without a console route yet (none). The production bundle is checked the same way by
 * `apps/server/scripts/check-routes.mjs` (run by smoke.mjs and the docker-smoke CI job).
 */
export const PENDING_KEYS: readonly string[] = [];

describe('server ↔ contract', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  }, 60_000);
  afterAll(async () => t?.close());

  it('every registry key has a route (method + path) except PENDING_KEYS', () => {
    const missing: string[] = [];
    for (const { key, def } of ALL_ENDPOINTS) {
      if (PENDING_KEYS.includes(key)) continue;
      if (!t.s.app.hasRoute({ method: def.method, url: def.path })) missing.push(`${key} ${def.method} ${def.path}`);
    }
    expect(missing).toEqual([]);
  });
});
