import type { Kysely } from 'kysely';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import type { TenantRef, TenantResolver, TenantRole } from './types.js';

/**
 * OSS resolver (spec §1.3): one tenant, the default one. The tenant segment of any URL is ignored
 * (core never registers the 3-segment routes because `multi` is false). Console access requires the
 * user to belong to the default tenant; the role is the user's role. This is the only runtime module
 * that reads `DEFAULT_TENANT_ID` (P0 acceptance).
 */
export class SingleTenantResolver implements TenantResolver {
  readonly multi = false;
  private cached: TenantRef | null = null;

  constructor(private readonly db: Kysely<MainDB>) {}

  private async tenant(): Promise<TenantRef | null> {
    if (this.cached) return this.cached;
    const t = await this.db.selectFrom('tenants').select(['id', 'slug', 'name']).where('id', '=', DEFAULT_TENANT_ID).executeTakeFirst();
    if (!t) return null;
    this.cached = { id: t.id, slug: t.slug, name: t.name, status: 'active', plan: 'oss' };
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

  /** Users belong to one tenant until memberships exist (P1): `users.tenant_id` + `users.role`. */
  async roleOf(tenantId: string, userId: string): Promise<TenantRole | null> {
    const u = await this.db.selectFrom('users').select(['role', 'status']).where('id', '=', userId).where('tenant_id', '=', tenantId).executeTakeFirst();
    return u && u.status === 'active' ? u.role : null;
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
}
