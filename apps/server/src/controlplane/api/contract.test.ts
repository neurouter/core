import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '@neurouter/shared';
import { createTestContext, type TestContext } from '../../test/fakes/app-context.js';

/**
 * Keys whose handlers live in other workstreams. evals.* / suggestions.* → controlplane/api/routes/evals.ts
 * (loaded by plugin.ts when present); environments.connectUpstream → the OAuth AS (`/oauth/upstream/...`).
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
