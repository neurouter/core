/**
 * Test doubles for the extension points (multi-tenancy spec §1.4: "each extension has a test double
 * in core"). `FakeMultiTenantResolver` stands in for the private cloud resolver: several tenants,
 * console tenant picked by the `x-neurouter-tenant` header (else the user's home tenant), membership
 * = `users.tenant_id`. The legacy MCP route maps to the default tenant.
 */
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Executor } from '@neurouter/executor';
import { openDatabase, type DbHandle } from '../../kernel/db/index.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { ModelKeyPolicy, SecretRefPolicy, TenantRef, TenantResolver, TenantRole } from '../../kernel/tenancy/types.js';
import type { UsageEvent, UsageSink } from '../../extensions.js';

export class FakeMultiTenantResolver implements TenantResolver {
  readonly multi = true;
  private handle: DbHandle<MainDB> | null = null;
  /** Extra memberships beyond `users.tenant_id` (tenantId → userId → role). */
  readonly memberships = new Map<string, Map<string, TenantRole>>();

  /** `databaseUrl`: the server's own database (a SQLite file or Postgres), opened lazily on first use (after migrations). */
  constructor(private readonly databaseUrl: string) {}

  private get db(): Kysely<MainDB> {
    this.handle ??= openDatabase<MainDB>(this.databaseUrl);
    return this.handle.db;
  }

  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
  }

  private ref(t: { id: string; slug: string; name: string }): TenantRef {
    return { id: t.id, slug: t.slug, name: t.name, status: 'active', plan: 'test' };
  }

  async byId(id: string): Promise<TenantRef | null> {
    const t = await this.db.selectFrom('tenants').select(['id', 'slug', 'name']).where('id', '=', id).executeTakeFirst();
    return t ? this.ref(t) : null;
  }

  async bySlug(slug: string): Promise<TenantRef | null> {
    const t = await this.db.selectFrom('tenants').select(['id', 'slug', 'name']).where('slug', '=', slug).executeTakeFirst();
    return t ? this.ref(t) : null;
  }

  async defaultTenant(): Promise<TenantRef | null> {
    return this.byId(DEFAULT_TENANT_ID);
  }

  async forMcp(p: { tenantSlug: string | null }): Promise<TenantRef | null> {
    return p.tenantSlug ? this.bySlug(p.tenantSlug) : this.defaultTenant();
  }

  async forPublic(p: { tenantSlug: string | null }): Promise<TenantRef | null> {
    return p.tenantSlug ? this.bySlug(p.tenantSlug) : this.defaultTenant();
  }

  async roleOf(tenantId: string, userId: string): Promise<TenantRole | null> {
    const extra = this.memberships.get(tenantId)?.get(userId);
    if (extra) return extra;
    const u = await this.db.selectFrom('users').select(['role', 'status']).where('id', '=', userId).where('tenant_id', '=', tenantId).executeTakeFirst();
    return u && u.status === 'active' ? u.role : null;
  }

  async forConsole(req: FastifyRequest, userId: string): Promise<{ tenant: TenantRef; role: TenantRole } | null> {
    const h = req.headers['x-neurouter-tenant'];
    let t: TenantRef | null;
    if (typeof h === 'string' && h) t = await this.bySlug(h);
    else {
      const u = await this.db.selectFrom('users').select('tenant_id').where('id', '=', userId).executeTakeFirst();
      t = u ? await this.byId(u.tenant_id) : null;
    }
    if (!t) return null;
    const role = await this.roleOf(t.id, userId);
    return role ? { tenant: t, role } : null;
  }
}

/** Seeds a second tenant row (same shape as the default one). */
export async function seedTenant(db: Kysely<MainDB>, id: string, slug: string, name = slug): Promise<void> {
  await db.insertInto('tenants').values({ id, slug, name, created_at: Date.now() }).onConflict((oc) => oc.doNothing()).execute();
}

/** `SecretRefPolicy` double: env references on or off per tenant id, optional name policy. */
export function secretRefPolicy(opts: { denyTenants?: string[]; allowName?: (name: string) => boolean } = {}): SecretRefPolicy {
  return { allowEnvRefs: (t) => !(opts.denyTenants ?? []).includes(t.id), ...(opts.allowName ? { allowEnvName: (n: string) => opts.allowName!(n) } : {}) };
}

/** `ModelKeyPolicy` double. */
export function modelKeyPolicy(allow: boolean): ModelKeyPolicy {
  return { allowEnvKeys: () => allow };
}

/** `UsageSink` double that keeps every event. */
export class RecordingUsageSink implements UsageSink {
  readonly events: UsageEvent[] = [];
  record(e: readonly UsageEvent[]): void {
    this.events.push(...e);
  }
}

/** Executor decorator double: counts runs and delegates. */
export function countingExecutor(counter: { runs: number; wrapped: number }): (base: Executor) => Executor {
  return (base) => {
    counter.wrapped++;
    return new Proxy(base, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv) as unknown;
        if (prop === 'run' && typeof v === 'function') {
          return (...args: unknown[]) => {
            counter.runs++;
            return (v as (...a: unknown[]) => unknown).apply(target, args);
          };
        }
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
  };
}
