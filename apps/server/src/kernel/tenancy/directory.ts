import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { TENANT_HEADER, TENANT_QUERY } from '@neurouter/shared';
import type { MainDB } from '../db/schema.js';
import type { TenantKind, TenantRef, TenantRole, TenantStatus } from './types.js';

/**
 * Database building blocks of a tenant resolver (multi-tenancy spec §2, §3): tenant lookups by id
 * and slug (live slug aliases included), memberships, and the console tenant pick. The core
 * `SingleTenantResolver` and the private cloud resolver are both made of these.
 */

type TenantRow = { id: string; slug: string; name: string; status: TenantStatus; plan: string; kind: TenantKind };

export function tenantRef(t: TenantRow): TenantRef {
  return { id: t.id, slug: t.slug, name: t.name, status: t.status, plan: t.plan, kind: t.kind };
}

const COLS = ['id', 'slug', 'name', 'status', 'plan', 'kind'] as const;

export class TenantDirectory {
  constructor(
    private readonly db: () => Kysely<MainDB>,
    private readonly now: () => number = Date.now,
  ) {}

  async byId(id: string): Promise<TenantRef | null> {
    const t = await this.db().selectFrom('tenants').select(COLS).where('id', '=', id).executeTakeFirst();
    return t ? tenantRef(t) : null;
  }

  /** By current slug, then by a live alias (an old slug after a rename, `default` → the migrated tenant; spec §2.3, §11). */
  async bySlug(slug: string): Promise<TenantRef | null> {
    const s = slug.toLowerCase();
    const t = await this.db().selectFrom('tenants').select(COLS).where('slug', '=', s).executeTakeFirst();
    if (t) return tenantRef(t);
    const a = await this.db()
      .selectFrom('tenant_slug_aliases')
      .select('tenant_id')
      .where('slug', '=', s)
      .where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', this.now())]))
      .executeTakeFirst();
    return a ? this.byId(a.tenant_id) : null;
  }
}

/** Live tenants: deleted or pending deletion ones read as unknown everywhere (spec §3.2). */
export const isLive = (t: TenantRef | null): t is TenantRef => t !== null && t.status !== 'deleted' && t.status !== 'pending_deletion';

export interface MembershipView {
  tenant: TenantRef;
  role: TenantRole;
  createdAt: number;
}

export class MembershipDirectory {
  constructor(private readonly db: () => Kysely<MainDB>) {}

  /** The user's role in the tenant: an active membership of an active user, else null. */
  async roleOf(tenantId: string, userId: string): Promise<TenantRole | null> {
    const m = await this.db()
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['m.role'])
      .where('m.tenant_id', '=', tenantId)
      .where('m.user_id', '=', userId)
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    return m?.role ?? null;
  }

  /** The user's active memberships in live tenants, oldest first. */
  async forUser(userId: string): Promise<MembershipView[]> {
    // tenant-scope: user-scope (the signed-in user's own memberships, across tenants)
    const rows = await this.db()
      .selectFrom('memberships as m')
      .innerJoin('tenants as t', 't.id', 'm.tenant_id')
      .select(['t.id', 't.slug', 't.name', 't.status', 't.plan', 't.kind', 'm.role', 'm.created_at'])
      .where('m.user_id', '=', userId)
      .where('m.status', '=', 'active')
      .where('t.status', 'not in', ['deleted', 'pending_deletion'])
      .orderBy('m.created_at', 'asc')
      .orderBy('t.slug', 'asc')
      .execute();
    return rows.map((r) => ({ tenant: tenantRef(r), role: r.role, createdAt: Number(r.created_at) }));
  }
}

/**
 * Picks the console tenant of a request (spec §3.3): the `X-Neurouter-Tenant` header, else `?org=`,
 * else the session's active tenant, else the user's oldest membership. An explicit slug the user
 * isn't a member of gives null (403 `no_tenant`; never a silent fallback to another tenant).
 */
export async function pickConsoleTenant(
  req: Pick<FastifyRequest, 'headers' | 'query'>,
  userId: string,
  sessionDefault: string | null,
  d: { tenants: TenantDirectory; memberships: MembershipDirectory },
): Promise<{ tenant: TenantRef; role: TenantRole } | null> {
  const h = req.headers[TENANT_HEADER];
  const q = (req.query as Record<string, unknown> | undefined)?.[TENANT_QUERY];
  const explicit = typeof h === 'string' && h ? h : typeof q === 'string' && q ? q : null;
  if (explicit) {
    const t = await d.tenants.bySlug(explicit);
    if (!isLive(t)) return null;
    const role = await d.memberships.roleOf(t.id, userId);
    return role ? { tenant: t, role } : null;
  }
  if (sessionDefault) {
    const t = await d.tenants.byId(sessionDefault);
    if (isLive(t)) {
      const role = await d.memberships.roleOf(t.id, userId);
      if (role) return { tenant: t, role };
    }
  }
  const first = (await d.memberships.forUser(userId))[0];
  return first ? { tenant: first.tenant, role: first.role } : null;
}
