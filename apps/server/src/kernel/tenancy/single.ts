import type { Kysely } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import { MembershipDirectory, TenantDirectory } from './directory.js';
import type { TenantRef, TenantResolver, TenantRole } from './types.js';

/**
 * OSS resolver (spec §1.3): one tenant, the default one. The tenant segment of any URL and the
 * `X-Neurouter-Tenant` header are ignored (core never registers the 3-segment routes because `multi`
 * is false). Console access requires an active membership of the default tenant; the role is the
 * membership's role (owner | admin | viewer). This is the only runtime module that reads
 * `DEFAULT_TENANT_ID` (P0 acceptance).
 */
export class SingleTenantResolver implements TenantResolver {
  readonly multi = false;
  private cached: TenantRef | null = null;
  private readonly tenants: TenantDirectory;
  private readonly memberships: MembershipDirectory;

  constructor(db: Kysely<MainDB>) {
    this.tenants = new TenantDirectory(() => db);
    this.memberships = new MembershipDirectory(() => db);
  }

  private async tenant(): Promise<TenantRef | null> {
    if (this.cached) return this.cached;
    const t = await this.tenants.byId(DEFAULT_TENANT_ID);
    if (!t) return null;
    // the single tenant is always reachable on a self-hosted install, whatever its plan or status column says
    this.cached = { ...t, status: 'active', plan: 'oss' };
    return this.cached;
  }

  async forMcp(): Promise<TenantRef | null> {
    return this.tenant();
  }

  async forConsole(_req: unknown, userId: string): Promise<{ tenant: TenantRef; role: TenantRole } | null> {
    const t = await this.tenant();
    if (!t) return null;
    const role = await this.roleOf(t.id, userId);
    return role ? { tenant: t, role } : null;
  }

  async roleOf(tenantId: string, userId: string): Promise<TenantRole | null> {
    return this.memberships.roleOf(tenantId, userId);
  }

  async forPublic(): Promise<TenantRef | null> {
    return this.tenant();
  }

  async defaultTenant(): Promise<TenantRef | null> {
    return this.tenant();
  }

  async bySlug(slug: string): Promise<TenantRef | null> {
    const t = await this.tenant();
    return t && t.slug === slug ? t : null;
  }

  async byId(id: string): Promise<TenantRef | null> {
    const t = await this.tenant();
    return t && t.id === id ? t : null;
  }

  /** Renaming the tenant (settings) must drop the cached ref. */
  invalidate(): void {
    this.cached = null;
  }
}
