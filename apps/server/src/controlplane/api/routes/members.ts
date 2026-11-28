import type { FastifyInstance } from 'fastify';
import { api, type MemberRow, type TenantSummary } from '@neurouter/shared';
import { AppError } from '../../../kernel/lib/errors.js';
import { isLive } from '../../../kernel/tenancy/index.js';
import type { TenantRef, TenantRole } from '../../../kernel/tenancy/types.js';
import { clientMeta, requireUser, tenantOf } from '../../auth/guards.js';
import type { MemberRowDb } from '../../users/users.service.js';
import type { InviteRowDb } from '../../members/invites.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { toIso, toIsoOrNull } from '../../../kernel/lib/clock.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';

export function tenantSummary(t: TenantRef, role: TenantRole): TenantSummary {
  return { id: t.id, slug: t.slug, name: t.name, kind: t.kind ?? 'org', status: t.status, role };
}

/** The signed-in user's organizations (multi-tenancy spec §3.3): every active membership in a live tenant. */
export async function tenantsOf(c: ApiContext, userId: string): Promise<TenantSummary[]> {
  const db = c.dbs.main.db;
  // tenant-scope: user-scope (the signed-in user's own memberships, across tenants)
  const rows = await db
    .selectFrom('memberships as m')
    .select(['m.tenant_id', 'm.role'])
    .where('m.user_id', '=', userId)
    .where('m.status', '=', 'active')
    .orderBy('m.created_at', 'asc')
    .execute();
  const out: TenantSummary[] = [];
  for (const r of rows) {
    // the resolver decides which tenants exist for this deployment (OSS: only the default one)
    const t = await c.tenancy.byId(r.tenant_id);
    if (isLive(t)) out.push(tenantSummary(t, r.role));
  }
  return out;
}

const memberRow = (m: MemberRowDb): MemberRow => ({ id: m.id, email: m.email, name: m.name, role: m.role, roleSource: m.role_source, status: m.status, lastLoginAt: toIsoOrNull(m.last_login_at), createdAt: toIso(m.created_at) });
const inviteRow = (i: InviteRowDb) => ({ id: i.id, email: i.email, role: i.role, status: i.status, invitedBy: i.invitedBy, createdAt: toIso(i.createdAt), expiresAt: toIso(i.expiresAt), acceptedAt: toIsoOrNull(i.acceptedAt) });

/** `tenants.*`, `members.*` and `invites.*` (multi-tenancy spec §2.4, §3.3). */
export async function memberRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  /* ---------------------------------------------------------------- tenants (user scope) */
  route(app, 'tenants.list', api.tenants.list, async (req) => ({ items: await tenantsOf(c, requireUser(req).id) }));

  route(app, 'tenants.switch', api.tenants.switch, async (req) => {
    const user = requireUser(req);
    const t = await c.tenancy.bySlug(req.body.slug);
    const role = isLive(t) ? await c.tenancy.roleOf(t.id, user.id) : null;
    // an organization the user isn't in looks exactly like an unknown one
    if (!t || !role) throw AppError.notFound('Organization');
    await c.sessions.setActiveTenant(req.webAuth!.session.idHash, t.id);
    c.audit.auth({ tenantId: t.id, userId: user.id, action: 'auth.tenant.switch', ...clientMeta(req) });
    return { tenant: tenantSummary(t, role) };
  });

  /* ---------------------------------------------------------------- members */
  route(app, 'members.list', api.members.list, async (req) => {
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    const rows = await c.users.list(tenantOf(req), { ...(req.query.q ? { q: req.query.q } : {}), ...(key ? { afterEmail: String(key[0]) } : {}), limit: limit + 1 });
    return toPage(rows, limit, memberRow, (r) => [r.email]);
  });

  route(app, 'members.update', api.members.update, async (req) => memberRow(await c.users.update(tenantOf(req), req.params.id, req.body, requireUser(req).id)));

  route(app, 'members.remove', api.members.remove, async (req) => {
    await c.users.remove(tenantOf(req), req.params.id, requireUser(req).id);
  });

  /* ---------------------------------------------------------------- invites */
  route(app, 'members.invites', api.members.invites, async (req) => ({ items: (await c.invites.list(tenantOf(req))).map(inviteRow) }));

  route(app, 'members.invite', api.members.invite, async (req, reply) => {
    const out = await c.invites.create(tenantOf(req), req.body, requireUser(req).id);
    reply.status(201);
    return { invite: inviteRow(out.invite), url: out.url };
  });

  route(app, 'members.revokeInvite', api.members.revokeInvite, async (req) => {
    await c.invites.revoke(tenantOf(req), req.params.id, requireUser(req).id);
  });

  route(app, 'invites.preview', api.invites.preview, async (req) => {
    const p = await c.invites.preview(req.body.token, requireUser(req).id);
    return { tenant: { slug: p.tenant.slug, name: p.tenant.name }, email: p.email, role: p.role, expiresAt: toIso(p.expiresAt), emailMatches: p.emailMatches, alreadyMember: p.alreadyMember };
  });

  route(app, 'invites.accept', api.invites.accept, async (req) => {
    const user = requireUser(req);
    const out = await c.invites.accept(req.body.token, user, clientMeta(req));
    await c.sessions.setActiveTenant(req.webAuth!.session.idHash, out.tenant.id);
    return { tenant: tenantSummary(out.tenant, out.role) };
  });
}
