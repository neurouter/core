import type { AuditEventInput } from './types.js';

/**
 * Eval-only, in-memory view of tool-call arguments before redaction. The audit log stores
 * arguments redacted (`secret_name`, `card` → `{"$redacted": …}`), so `called` assertions checked on
 * the audit view could never pass for such arguments. The eval runner watches its per-attempt API key,
 * reads the clear arguments by audit event id when it collects the attempt's calls, and releases them.
 * Nothing here is persisted; only watched keys are captured, and entries are bounded.
 */
export class EvalArgsTap {
  private readonly watched = new Map<string, Map<string, unknown>>();

  constructor(private readonly maxPerKey = 2000) {}

  /** Starts capturing the clear arguments of calls made with this API key. */
  watch(apiKeyId: string): void {
    if (!this.watched.has(apiKeyId)) this.watched.set(apiKeyId, new Map());
  }

  /** Audit pipeline hook: records `params` of a watched key's event (by event id). */
  capture(e: Pick<AuditEventInput, 'id' | 'apiKeyId' | 'params'>): void {
    if (!e.apiKeyId || e.params === undefined || e.params === null) return;
    const m = this.watched.get(e.apiKeyId);
    if (!m || m.size >= this.maxPerKey) return;
    m.set(e.id, structuredClone(e.params));
  }

  /** The captured arguments by audit event id (still watching). */
  peek(apiKeyId: string): ReadonlyMap<string, unknown> {
    return this.watched.get(apiKeyId) ?? new Map();
  }

  /** Stops watching the key and drops what was captured. */
  release(apiKeyId: string): void {
    this.watched.delete(apiKeyId);
  }

  get size(): number {
    return this.watched.size;
  }
}
