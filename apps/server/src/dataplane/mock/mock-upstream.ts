import { handleMockRequest, MemoryMockStateStore, type MockModel, type MockStateStore } from '@neurouter/compiler';
import type { MockUpstream } from '../http/invoker.js';

/**
 * In-process mock upstream (§16): the compiler's mock model over a `MockStateStore` (the database by
 * default, so every instance shares the mock world; `NEUROUTER_MOCK_STORE=memory` keeps it in this
 * process). Namespaces (`MockNs`) are bound to the request's tenant and environment: `env` (shared
 * traffic) or `eval:<…>` / `gen:<…>` (eval attempts and generation, multi-tenancy spec §7.4).
 * The pipeline treats it exactly like an upstream (steps 0–13 run; step 11 calls this instead of HTTP).
 */
export class InProcessMock implements MockUpstream {
  readonly store: MockStateStore;
  private readonly latencyMs: number;

  constructor(opts: { store?: MockStateStore; seed?: number; latencyMs?: number; now?: () => number } = {}) {
    this.store = opts.store ?? new MemoryMockStateStore({ ...(opts.seed !== undefined ? { seed: opts.seed } : {}), ...(opts.now ? { now: opts.now } : {}) });
    this.latencyMs = opts.latencyMs ?? 0;
  }

  async handle(req: Parameters<MockUpstream['handle']>[0]): Promise<{ status: number; headers?: Record<string, string>; body: unknown }> {
    if (!req.mockModel) return { status: 501, body: { title: 'No mock model for this build' } };
    if (this.latencyMs > 0) await new Promise((r) => setTimeout(r, this.latencyMs));
    const q: Record<string, string | string[] | undefined> = req.query;
    return handleMockRequest(req.mockModel as MockModel, this.store, req.ns, { method: req.method, path: req.path, query: q, body: req.body, headers: req.headers });
  }
}
