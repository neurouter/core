/**
 * Test doubles for the extension points (multi-tenancy spec §1.4: "each extension has a test double
 * in core"). `FakeMultiTenantResolver` stands in for the private cloud resolver, built from the same
 * core building blocks (`TenantDirectory`, `MembershipDirectory`, `pickConsoleTenant`): several
 * tenants, memberships from the `memberships` table, console tenant from the `X-Neurouter-Tenant`
 * header / `?org=` / the session's active tenant. The legacy MCP route maps to the default tenant.
 */
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { Executor } from '@neurouter/executor';
import { openDatabase, type DbHandle } from '../../kernel/db/index.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { MembershipDirectory, TenantDirectory, pickConsoleTenant } from '../../kernel/tenancy/index.js';
import type { ModelKeyPolicy, SecretRefPolicy, TenantRef, TenantResolver, TenantRole } from '../../kernel/tenancy/types.js';
import type { UsageEvent, UsageSink } from '../../extensions.js';

export class FakeMultiTenantResolver implements TenantResolver {
  readonly multi = true;
  private handle: DbHandle<MainDB> | null = null;
  private readonly tenants = new TenantDirectory(() => this.db);
  private readonly members = new MembershipDirectory(() => this.db);

  /** `databaseUrl`: the server's own database (a SQLite file or Postgres), opened lazily on first use (after migrations). */
  constructor(
    private readonly databaseUrl: string,
    /** The tenant of the legacy 2-segment MCP and public routes (cloud: `NEUROUTER_LEGACY_MCP_TENANT`); null = the default tenant. */
    public legacySlug: string | null = null,
  ) {}

  private get db(): Kysely<MainDB> {
    this.handle ??= openDatabase<MainDB>(this.databaseUrl);
    return this.handle.db;
  }

  async close(): Promise<void> {
    await this.handle?.close();
    this.handle = null;
  }

  async byId(id: string): Promise<TenantRef | null> {
    return this.tenants.byId(id);
  }

  async bySlug(slug: string): Promise<TenantRef | null> {
    return this.tenants.bySlug(slug);
  }

  async defaultTenant(): Promise<TenantRef | null> {
    return this.byId(DEFAULT_TENANT_ID);
  }

  private legacy(): Promise<TenantRef | null> {
    return this.legacySlug ? this.bySlug(this.legacySlug) : this.defaultTenant();
  }

  async forMcp(p: { tenantSlug: string | null }): Promise<TenantRef | null> {
    return p.tenantSlug ? this.bySlug(p.tenantSlug) : this.legacy();
  }

  async forPublic(p: { tenantSlug: string | null }): Promise<TenantRef | null> {
    return p.tenantSlug ? this.bySlug(p.tenantSlug) : this.legacy();
  }

  async roleOf(tenantId: string, userId: string): Promise<TenantRole | null> {
    return this.members.roleOf(tenantId, userId);
  }

  async forConsole(req: FastifyRequest, userId: string, sessionDefault: string | null): Promise<{ tenant: TenantRef; role: TenantRole } | null> {
    return pickConsoleTenant(req, userId, sessionDefault, { tenants: this.tenants, memberships: this.members });
  }
}

/** Seeds a second tenant row (same shape as the default one). */
export async function seedTenant(db: Kysely<MainDB>, id: string, slug: string, name = slug): Promise<void> {
  await db.insertInto('tenants').values({ id, slug, name, created_at: Date.now() }).onConflict((oc) => oc.doNothing()).execute();
}

/** Seeds a user (if new) and its membership in a tenant (the user's home tenant is the first one it joins). */
export async function seedMember(db: Kysely<MainDB>, p: { tenantId: string; email: string; role: TenantRole; userId?: string; name?: string }): Promise<string> {
  const now = Date.now();
  const existing = await db.selectFrom('users').select('id').where('email', '=', p.email).executeTakeFirst();
  const id = existing?.id ?? p.userId ?? crypto.randomUUID();
  if (!existing) await db.insertInto('users').values({ id, tenant_id: p.tenantId, email: p.email, name: p.name ?? p.email.split('@')[0]!, role: p.role === 'viewer' ? 'viewer' : 'admin', role_source: 'local', created_at: now, updated_at: now }).execute();
  await db
    .insertInto('memberships')
    .values({ tenant_id: p.tenantId, user_id: id, role: p.role, role_source: 'local', status: 'active', invited_by: null, created_at: now, updated_at: now })
    .onConflict((oc) => oc.columns(['tenant_id', 'user_id']).doUpdateSet({ role: p.role, status: 'active', updated_at: now }))
    .execute();
  return id;
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
