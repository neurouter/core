import type { Kysely } from 'kysely';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Principal } from '../pipeline/context.js';

/** `eval:<runId>:<taskRun>` (one eval attempt, spec §7.4). */
export const EVAL_NS_RE = /^eval:([0-9a-f-]{36}):[A-Za-z0-9:_-]{1,150}$/;
/** `gen:<apiKeyId>:<suffix>` (suite generation reference calls), bound to the eval key that sends it. */
export const GEN_NS_RE = /^gen:([0-9a-f-]{36}):[A-Za-z0-9:_-]{1,150}$/;

/**
 * Binds the `X-Neurouter-Mock-State` header to the authenticated request (fixes G13). Accepted only
 * from `purpose='eval'` API keys (which are bound to one environment and tenant): an `eval:` name
 * needs an `eval_runs` row of the request's tenant and environment in status `running` (cached 60 s);
 * a `gen:` name must carry the sending key's own id. Anything else falls back to `env`.
 */
export class MockNamespaceBinder {
  private readonly running = new Map<string, number>();

  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly now: () => number,
    private readonly cacheMs = 60_000,
  ) {}

  async bind(header: string | undefined, ctx: { tenantId: string; environmentId: string; principal: Principal }): Promise<string> {
    const p = ctx.principal;
    if (!header || p.type !== 'api_key' || p.purpose !== 'eval') return 'env';
    const gen = GEN_NS_RE.exec(header);
    if (gen) return gen[1] === p.apiKeyId ? header : 'env';
    const ev = EVAL_NS_RE.exec(header);
    if (ev && (await this.runActive(ctx.tenantId, ctx.environmentId, ev[1]!))) return header;
    return 'env';
  }

  private async runActive(tenantId: string, environmentId: string, runId: string): Promise<boolean> {
    const key = `${tenantId}|${environmentId}|${runId}`;
    const t = this.now();
    const until = this.running.get(key);
    if (until !== undefined && until > t) return true;
    const row = await this.db
      .selectFrom('eval_runs')
      .select('id')
      .where('tenant_id', '=', tenantId)
      .where('environment_id', '=', environmentId)
      .where('id', '=', runId)
      .where('status', '=', 'running')
      .executeTakeFirst();
    if (!row) {
      this.running.delete(key);
      return false;
    }
    if (this.running.size > 10_000) this.running.clear();
    this.running.set(key, t + this.cacheMs);
    return true;
  }
}
