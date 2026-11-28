import type { Kysely } from 'kysely';
import type { MainDB } from '../../kernel/db/schema.js';
import type { TenantResolver } from '../../kernel/tenancy/types.js';

/** Former public base URLs (`NEUROUTER_RESOURCE_ALIASES`, spec §11 M4) and the current one. */
export interface ResourceBase {
  publicUrl: string;
  aliases?: readonly string[];
}

/** Rewrites `alias + /mcp/...` to `PUBLIC_URL + /mcp/...` (other values unchanged). */
export function canonicalResource(resource: string, base: ResourceBase | undefined): string {
  if (!base?.aliases?.length) return resource;
  for (const a of base.aliases) {
    const root = a.replace(/\/+$/, '');
    if (resource.toLowerCase().startsWith(`${root.toLowerCase()}/mcp/`)) return `${base.publicUrl}${resource.slice(root.length)}`;
  }
  return resource;
}

/** RFC 8707 audience check; tolerate a differently-cased host and a trailing slash; resource aliases count as the same resource. */
export function sameResource(a0: string, b0: string, base?: ResourceBase): boolean {
  const a = canonicalResource(a0, base);
  const b = canonicalResource(b0, base);
  if (a === b) return true;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.protocol === y.protocol && x.host.toLowerCase() === y.host.toLowerCase() && x.pathname.replace(/\/$/, '') === y.pathname.replace(/\/$/, '') && x.search === y.search;
  } catch {
    return false;
  }
}

export interface ResolvedResource {
  /** Canonical `PUBLIC_URL/mcp/{server}/{env}` (legacy form) or `PUBLIC_URL/mcp/{tenant}/{server}/{env}` (the tenant's current slug). */
  resource: string;
  tenantId: string;
  server: { id: string; slug: string; name: string };
  environment: { id: string; slug: string; name: string; kind: 'dev' | 'qa' | 'prod'; writesEnabled: boolean; codeMode: boolean };
}

const SERVER_SEG = '[a-z][a-z0-9-]{1,38}[a-z0-9]';
const ENV_SEG = '[a-z][a-z0-9-]{0,30}';
const TENANT_SEG = '[a-z][a-z0-9-]{1,30}[a-z0-9]';
const LEGACY_RE = new RegExp(`^/mcp/(${SERVER_SEG})/(${ENV_SEG})/?$`);
const TENANT_RE = new RegExp(`^/mcp/(${TENANT_SEG})/(${SERVER_SEG})/(${ENV_SEG})/?$`);

/**
 * Maps an RFC 8707 `resource` to one of our MCP endpoints (§13.3, A5): `PUBLIC_URL/mcp/{server}/{env}`
 * (the legacy form) or, on a multi-tenant deployment, `PUBLIC_URL/mcp/{tenant}/{server}/{env}` (or a
 * resource alias of either) for an active server and environment of a live tenant, else `null`
 * (→ invalid_target). Slugs repeat across tenants, so the tenant is resolved first and the lookup is
 * filtered by it (multi-tenancy spec §3.4, G2).
 */
export async function resolveResource(db: Kysely<MainDB>, base: ResourceBase & { tenancy: Pick<TenantResolver, 'forMcp' | 'multi'> }, resource0: string): Promise<ResolvedResource | null> {
  const publicUrl = base.publicUrl;
  const resource = canonicalResource(resource0, base);
  let u: URL;
  try {
    u = new URL(resource);
  } catch {
    return null;
  }
  const pub = new URL(publicUrl);
  if (u.protocol !== pub.protocol || u.host.toLowerCase() !== pub.host.toLowerCase() || u.search || u.hash) return null;
  const t3 = base.tenancy.multi ? TENANT_RE.exec(u.pathname) : null;
  const m2 = t3 ? null : LEGACY_RE.exec(u.pathname);
  if (!t3 && !m2) return null;
  const tenantSlug = t3 ? t3[1]! : null;
  const serverSlug = t3 ? t3[2]! : m2![1]!;
  const envSlug = t3 ? t3[3]! : m2![2]!;
  const tenant = await base.tenancy.forMcp({ tenantSlug, serverSlug, envSlug });
  if (!tenant || tenant.status !== 'active') return null;
  const row = await db
    .selectFrom('environments as e')
    .innerJoin('servers as s', 's.id', 'e.server_id')
    .select(['e.id as env_id', 'e.slug as env_slug', 'e.name as env_name', 'e.kind', 'e.writes', 'e.code_mode', 'e.status as env_status', 's.id as server_id', 's.slug as server_slug', 's.name as server_name', 's.status as server_status', 's.tenant_id'])
    .where('s.tenant_id', '=', tenant.id)
    .where('e.tenant_id', '=', tenant.id)
    .where('s.slug', '=', serverSlug)
    .where('e.slug', '=', envSlug)
    .executeTakeFirst();
  if (!row || row.env_status !== 'active' || row.server_status !== 'active') return null;
  const writes = (typeof row.writes === 'string' ? JSON.parse(row.writes) : row.writes) as { enabled?: boolean } | null;
  return {
    resource: `${publicUrl}/mcp/${tenantSlug === null ? '' : `${tenant.slug}/`}${row.server_slug}/${row.env_slug}`,
    tenantId: row.tenant_id,
    server: { id: row.server_id, slug: row.server_slug, name: row.server_name },
    environment: { id: row.env_id, slug: row.env_slug, name: row.env_name, kind: row.kind, writesEnabled: writes?.enabled === true, codeMode: row.code_mode === 1 },
  };
}
