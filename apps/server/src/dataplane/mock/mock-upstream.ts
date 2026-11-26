import { handleMockRequest, MockStore, type MockModel } from '@neurouter/compiler';
import type { MockUpstream } from '../http/invoker.js';

/**
 * In-process mock upstream (§16): the compiler's mock model + a seeded in-memory state store,
 * namespaced `env:<environmentId>` (shared demo traffic) and `eval:<…>` (per eval task run).
 * The pipeline treats it exactly like an upstream (steps 0–13 run; step 11 calls this instead of HTTP).
 */
export class InProcessMock implements MockUpstream {
  readonly store: MockStore;

  constructor(opts: { seed?: number; latencyMs?: number; now?: () => number } = {}) {
    this.store = new MockStore({ ...(opts.seed !== undefined ? { seed: opts.seed } : {}), ...(opts.now ? { now: opts.now } : {}) });
    this.latencyMs = opts.latencyMs ?? 0;
  }

  private readonly latencyMs: number;

  async handle(req: Parameters<MockUpstream['handle']>[0]): Promise<{ status: number; headers?: Record<string, string>; body: unknown }> {
    if (!req.mockModel) return { status: 501, body: { title: 'No mock model for this build' } };
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const q: Record<string, string | string[] | undefined> = req.query;
    return handleMockRequest(req.mockModel as MockModel, this.store, req.namespace, { method: req.method, path: req.path, query: q, body: req.body, headers: req.headers });
  }

  reset(namespace: string, seed?: number): void {
    this.store.resetNamespace(namespace, seed);
  }
}
