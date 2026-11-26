import type { FastifyInstance, FastifyRequest } from 'fastify';
import { api, type ApiKeyRow, type Scope } from '@neurouter/shared';
import { toIso, toIsoOrNull } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { requireUser, tenantOf } from '../../auth/guards.js';
import { blockClient, isClientBlocked, unblockClient } from '../../../kernel/tenancy/client-blocks.js';
import { ApiKeysService, AUTH_REVOKED_CHANNEL, type ApiKeyRowDb } from '../../keys/api-keys.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { connectConfig } from './servers.js';
import { mask, DELETED } from '../views.js';

/** `keys.*`, `oauthClients.*`, `oauthGrants.*` (§14.8). */
export async function keyRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const row = async (k: ApiKeyRowDb, anonymous: boolean): Promise<ApiKeyRow> => {
    const [s, e, o] = await Promise.all([
      db.selectFrom('servers').where('tenant_id', '=', k.tenant_id).select(['id', 'slug', 'name']).where('id', '=', k.server_id).executeTakeFirst(),
      db.selectFrom('environments').where('tenant_id', '=', k.tenant_id).select(['id', 'slug', 'name', 'kind']).where('id', '=', k.environment_id).executeTakeFirst(),
      db.selectFrom('users').select(['id', 'name', 'email']).where('id', '=', k.owner_user_id).executeTakeFirst(),
    ]);
    return {
      id: k.id,
      name: k.name,
      displayPrefix: mask(k.display_prefix, anonymous),
      server: s ?? { id: k.server_id, slug: '', name: DELETED },
      environment: e ?? { id: k.environment_id, slug: '', name: DELETED, kind: 'dev' },
      scopes: (parseJsonColumn<Scope[]>(k.scopes) ?? []) as Scope[],
      profile: k.profile,
      rateLimit: parseJsonColumn(k.rate_limit),
      owner: o ? { id: o.id, name: o.name || o.email } : { id: k.owner_user_id, name: DELETED },
      expiresAt: toIsoOrNull(k.expires_at),
      revokedAt: toIsoOrNull(k.revoked_at),
      lastUsedAt: toIsoOrNull(k.last_used_at),
      status: ApiKeysService.status(k, c.clock.now()),
      createdAt: toIso(k.created_at),
    };
  };

  route(app, 'keys.list', api.keys.list, async (req) => {
    const q = req.query;
    const anon = Boolean(req.webAuth?.user.anonymous);
    const now = c.clock.now();
    const limit = clampLimit(q.limit);
    const key = decodeCursor(q.cursor);
    let qb = db.selectFrom('api_keys').selectAll().where('tenant_id', '=', tenantOf(req)).where('purpose', '=', 'user');
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.environmentId) qb = qb.where('environment_id', '=', q.environmentId);
    if (q.status === 'revoked') qb = qb.where('revoked_at', 'is not', null);
    if (q.status === 'active') qb = qb.where('revoked_at', 'is', null).where((eb) => eb.or([eb('expires_at', 'is', null), eb('expires_at', '>', now)]));
    if (q.status === 'expired') qb = qb.where('revoked_at', 'is', null).where('expires_at', '<=', now);
    if (key) qb = qb.where((eb) => eb.or([eb('created_at', '<', Number(key[0])), eb.and([eb('created_at', '=', Number(key[0])), eb('id', '<', String(key[1]))])]));
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at, r.id]);
    return { items: await Promise.all(page.items.map((r) => row(r, anon))), nextCursor: page.nextCursor };
  });

  route(app, 'keys.create', api.keys.create, async (req, reply) => {
    const u = requireUser(req);
    const b = req.body;
    const out = await c.apiKeys.create({ tenantId: tenantOf(req), name: b.name, serverId: b.serverId, environmentId: b.environmentId, scopes: b.scopes, ...(b.profile ? { profile: b.profile } : {}), ...(b.expiresInDays !== undefined ? { expiresInDays: b.expiresInDays } : {}), ...(b.rateLimit ? { rateLimit: b.rateLimit } : {}), ownerUserId: u.id });
    const s = await db.selectFrom('servers').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', b.serverId).executeTakeFirstOrThrow();
    const e = await db.selectFrom('environments').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', b.environmentId).executeTakeFirstOrThrow();
    const build = e.build_id ? await db.selectFrom('builds').where('tenant_id', '=', tenantOf(req)).select('visible_count').where('id', '=', e.build_id).executeTakeFirst() : null;
    reply.status(201);
    return { key: await row(out.key, false), token: out.token, connect: connectConfig(c, s, e, build?.visible_count ?? 0, c.ports.executorStatus().ok && e.code_mode === 1 && b.scopes.includes('code:run')), warnings: out.warnings };
  });

  route(app, 'keys.update', api.keys.update, async (req) => {
    const k = await c.apiKeys.get(tenantOf(req), req.params.id);
    if (k.purpose !== 'user') throw AppError.notFound('API key');
    return row(req.body.name ? await c.apiKeys.rename(tenantOf(req), k.id, req.body.name) : k, false);
  });

  route(app, 'keys.revoke', api.keys.revoke, async (req) => {
    const u = requireUser(req);
    const k = await c.apiKeys.get(tenantOf(req), req.params.id);
    if (k.purpose !== 'user') throw AppError.notFound('API key');
    return row(await c.apiKeys.revoke(tenantOf(req), k.id, u.id), false);
  });

  /* ---------------------------------------------------------------- OAuth clients and grants (read / block / revoke) */
  /** A global client as one tenant sees it: that tenant's tokens and its own block (spec §3.4, G14). */
  const clientRow = async (tenantId: string, cl: { id: string; client_id: string; client_name: string; client_uri: string | null; logo_uri: string | null; registration_type: 'cimd' | 'dcr' | 'preregistered'; redirect_uris: string; status: 'active' | 'blocked'; created_at: number }) => {
    const now = c.clock.now();
    const toks = await db
      .selectFrom('oauth_tokens as t')
      .innerJoin('environments as e', 'e.id', 't.environment_id')
      .innerJoin('servers as s', 's.id', 'e.server_id')
      .select(['e.id', 'e.slug', 'e.name', 'e.kind', 's.slug as server_slug', (eb) => eb.fn.countAll<number>().as('n'), (eb) => eb.fn.max('t.last_used_at').as('last')])
      .where('t.tenant_id', '=', tenantId)
      .where('t.client_id', '=', cl.id)
      .where('t.kind', '=', 'access')
      .where('t.revoked_at', 'is', null)
      .where('t.expires_at', '>', now)
      .groupBy(['e.id', 'e.slug', 'e.name', 'e.kind', 's.slug'])
      .execute();
    const last = await db.selectFrom('oauth_tokens').select((eb) => eb.fn.max('last_used_at').as('m')).where('tenant_id', '=', tenantId).where('client_id', '=', cl.id).executeTakeFirst();
    const blocked = cl.status === 'blocked' || (await isClientBlocked(db, tenantId, cl.id));
    return {
      id: cl.id,
      clientId: cl.client_id,
      name: cl.client_name,
      clientUri: cl.client_uri,
      logoUri: cl.logo_uri,
      registrationType: cl.registration_type,
      redirectUris: parseJsonColumn<string[]>(cl.redirect_uris) ?? [],
      status: blocked ? ('blocked' as const) : ('active' as const),
      environments: toks.map((t) => ({ id: t.id, slug: t.slug, name: t.name, serverSlug: t.server_slug, kind: t.kind, activeTokens: Number(t.n) })),
      lastUsedAt: toIsoOrNull(last?.m === null || last?.m === undefined ? null : Number(last.m)),
      createdAt: toIso(cl.created_at),
    };
  };
  const clientOr404 = async (id: string) => {
    // tenant-scope: global-table (client registrations are global; per-tenant state lives in oauth_client_blocks)
    const cl = await db.selectFrom('oauth_clients').selectAll().where('id', '=', id).executeTakeFirst();
    if (!cl) throw AppError.notFound('OAuth client');
    return cl;
  };

  route(app, 'oauthClients.list', api.oauthClients.list, async (req) => {
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    const tenantId = tenantOf(req);
    let qb = db.selectFrom('oauth_clients').selectAll();
    // multi-tenant: only clients this tenant has dealt with (consents, tokens or a block), never other tenants' registrations
    if (c.tenancy.multi)
      qb = qb.where((eb) =>
        eb.or([
          eb('id', 'in', eb.selectFrom('oauth_consents').select('client_id').where('tenant_id', '=', tenantId)),
          eb('id', 'in', eb.selectFrom('oauth_tokens').select('client_id').where('tenant_id', '=', tenantId)),
          eb('id', 'in', eb.selectFrom('oauth_client_blocks').select('client_id').where('tenant_id', '=', tenantId)),
        ]),
      );
    if (key) qb = qb.where((eb) => eb.or([eb('created_at', '<', Number(key[0])), eb.and([eb('created_at', '=', Number(key[0])), eb('id', '<', String(key[1]))])]));
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at, r.id]);
    return { items: await Promise.all(page.items.map((r) => clientRow(tenantId, r))), nextCursor: page.nextCursor };
  });
  /**
   * Block / unblock for the request's tenant only (G14): revokes that tenant's tokens of the client,
   * never another tenant's. The global `oauth_clients.status` is a platform block; a single-tenant
   * deployment (OSS) keeps it in sync so an older binary still sees the block after a rollback.
   */
  const setClientStatus = async (req: FastifyRequest, id: string, status: 'active' | 'blocked') => {
    const tenantId = tenantOf(req);
    await clientOr404(id);
    const now = c.clock.now();
    if (status === 'blocked') {
      await blockClient(db, tenantId, id, req.webAuth?.user.id ?? null, now);
      await c.coord.publish(AUTH_REVOKED_CHANNEL, { oauthClientId: id, tenantId });
    } else await unblockClient(db, tenantId, id);
    // tenant-scope: global-table (platform status mirrors the block only when this deployment has a single tenant)
    if (!c.tenancy.multi) await db.updateTable('oauth_clients').set({ status, updated_at: now }).where('id', '=', id).execute();
    return clientRow(tenantId, await clientOr404(id));
  };
  route(app, 'oauthClients.block', api.oauthClients.block, async (req) => setClientStatus(req, req.params.id, 'blocked'));
  route(app, 'oauthClients.unblock', api.oauthClients.unblock, async (req) => setClientStatus(req, req.params.id, 'active'));

  route(app, 'oauthGrants.list', api.oauthGrants.list, async (req) => {
    let qb = db
      .selectFrom('oauth_consents as g')
      .innerJoin('users as u', 'u.id', 'g.user_id')
      .innerJoin('oauth_clients as cl', 'cl.id', 'g.client_id')
      .innerJoin('environments as e', 'e.id', 'g.environment_id')
      .innerJoin('servers as s', 's.id', 'e.server_id')
      .select(['g.id', 'g.scopes', 'g.created_at', 'g.user_id', 'g.client_id', 'g.environment_id', 'u.name as uname', 'u.email', 'cl.client_name', 'e.slug', 'e.name as ename', 'e.kind', 's.slug as sslug'])
      .where('g.tenant_id', '=', tenantOf(req))
      .where('g.revoked_at', 'is', null);
    if (req.query.environmentId) qb = qb.where('g.environment_id', '=', req.query.environmentId);
    const rows = await qb.orderBy('g.created_at', 'desc').limit(500).execute();
    const items = [];
    for (const r of rows) {
      const last = await db.selectFrom('oauth_tokens').select((eb) => eb.fn.max('last_used_at').as('m')).where('tenant_id', '=', tenantOf(req)).where('user_id', '=', r.user_id).where('client_id', '=', r.client_id).where('environment_id', '=', r.environment_id).executeTakeFirst();
      items.push({
        id: r.id,
        user: { id: r.user_id, name: r.uname || r.email, email: r.email },
        client: { id: r.client_id, name: r.client_name },
        environment: { id: r.environment_id, slug: r.slug, name: r.ename, serverSlug: r.sslug, kind: r.kind },
        scopes: r.scopes.split(/\s+/).filter(Boolean),
        lastUsedAt: toIsoOrNull(last?.m === null || last?.m === undefined ? null : Number(last.m)),
        createdAt: toIso(r.created_at),
      });
    }
    return { items };
  });

  route(app, 'oauthGrants.revoke', api.oauthGrants.revoke, async (req) => {
    const g = await db.selectFrom('oauth_consents').selectAll().where('id', '=', req.params.id).where('tenant_id', '=', tenantOf(req)).executeTakeFirst();
    if (!g) throw AppError.notFound('Grant');
    const now = c.clock.now();
    await db.updateTable('oauth_consents').set({ revoked_at: now }).where('id', '=', g.id).where('tenant_id', '=', g.tenant_id).execute();
    await db.updateTable('oauth_tokens').set({ revoked_at: now }).where('tenant_id', '=', g.tenant_id).where('user_id', '=', g.user_id).where('client_id', '=', g.client_id).where('environment_id', '=', g.environment_id).where('revoked_at', 'is', null).execute();
    await c.coord.publish(AUTH_REVOKED_CHANNEL, { grantId: g.id });
  });
}
