import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import { DEMO_ANONYMOUS_ALLOW, hasCapability, type Capability } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { timingSafeEqualStr } from '../../kernel/lib/crypto.js';
import { AppError } from '../../kernel/lib/errors.js';
import { loadConsoleUser, type ConsoleUser } from '../../kernel/principal.js';
import type { SessionService, WebSession } from './sessions.js';
import type { TenantContext, TenantResolver } from '../../kernel/tenancy/types.js';

export interface WebAuth {
  user: ConsoleUser;
  session: WebSession;
}

declare module 'fastify' {
  interface FastifyRequest {
    webAuth: WebAuth | null;
    /** The request's tenant (multi-tenancy spec §3.3): from the signed-in user's membership, or the public tenant on `public` routes. */
    tenantCtx: TenantContext | null;
  }
  interface FastifyContextConfig {
    /** Registry key of the route (`servers.get`), set by `route()`. */
    key?: string;
    /** False on tenant-free endpoints (`EndpointDef.tenant`); every other signed-in endpoint needs the request's tenant. */
    tenant?: boolean;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const DEMO_ALLOW = new Set<string>(DEMO_ANONYMOUS_ALLOW);

/**
 * `/api/*` session + CSRF + access gate (ADAPT Hub auth/web/guards.ts): loads the session user
 * (active only), requires `X-CSRF-Token` on non-GET requests that carry a session, checks the
 * contract's access list (capabilities; admin all, viewer `:read`), and in demo mode answers 403
 * `demo_read_only` for anonymous mutations outside DEMO_ANONYMOUS_ALLOW. Mutations by signed-in
 * users are audited as `admin_action` (after = redacted request body).
 */
export function installWebAuth(app: FastifyInstance, deps: { db: Kysely<MainDB>; sessions: SessionService; audit: AuditRecorder; demoReadOnly: boolean; tenancy: TenantResolver; maintenance?: boolean }): void {
  app.decorateRequest('webAuth', null);
  app.decorateRequest('tenantCtx', null);
  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/') && !req.url.startsWith('/oauth/')) return;
    const token = deps.sessions.readCookie(req);
    if (!token) return;
    const session = await deps.sessions.validate(token);
    if (!session) return;
    const user = await loadConsoleUser(deps.db, session.userId, session.anonymous);
    if (!user || user.status !== 'active') return;
    if (!SAFE_METHODS.has(req.method) && req.url.startsWith('/api/')) {
      const header = req.headers['x-csrf-token'];
      if (typeof header !== 'string' || !timingSafeEqualStr(header, session.csrfToken)) throw new AppError('forbidden', 'Missing or invalid CSRF token', { extensions: { reason: 'csrf' } });
    }
    req.webAuth = { user, session };
    const t = await deps.tenancy.forConsole(req, user.id, session.activeTenantId);
    if (t) req.tenantCtx = { tenant: t.tenant, role: t.role };
  });
  app.addHook('preValidation', async (req) => {
    const cfg = req.routeOptions.config as { access?: readonly string[]; key?: string; tenant?: boolean } | undefined;
    const access = cfg?.access;
    if (!access) return;
    if (access.includes('public')) {
      // public pages (reports, badges, auth config) resolve their own tenant (legacy paths: the default tenant)
      if (!req.tenantCtx) {
        const slug = (req.params as Record<string, string> | undefined)?.tenant ?? null;
        const t = await deps.tenancy.forPublic({ tenantSlug: slug });
        if (t) req.tenantCtx = { tenant: t, role: null };
      }
      return;
    }
    if (deps.maintenance && !SAFE_METHODS.has(req.method) && !(cfg?.key ?? '').startsWith('auth.')) throw new AppError('service_unavailable', 'Neurouter is in maintenance; changes are paused', { headers: { 'retry-after': '120' }, extensions: { reason: 'maintenance' } });
    // demo mode: unauthenticated GET /api/me creates the anonymous session in the handler
    if (cfg?.key === 'me.get' && !req.webAuth && deps.demoReadOnly) return;
    const user = requireUser(req);
    if (user.anonymous && !SAFE_METHODS.has(req.method) && !DEMO_ALLOW.has(cfg?.key ?? '')) {
      throw new AppError('forbidden', 'The public demo is read-only', { extensions: { reason: 'demo_read_only' } });
    }
    if (cfg?.tenant === false) return;
    // every tenant-scoped endpoint needs the request's tenant (403 `no_tenant` without a membership, spec §3.3)
    const ctx = requireTenant(req);
    if (ctx.tenant.status === 'suspended' && !SAFE_METHODS.has(req.method)) throw new AppError('forbidden', 'This organization is suspended', { extensions: { reason: 'tenant_suspended' } });
    if (access.includes('user')) return;
    if (!access.some((a) => hasCapability(roleOf(ctx), a as Capability))) throw new AppError('forbidden', 'You do not have permission to perform this action', { extensions: { reason: 'capability' } });
  });
  app.addHook('onResponse', async (req, reply) => {
    const cfg = req.routeOptions.config as { key?: string } | undefined;
    if (SAFE_METHODS.has(req.method) || !cfg?.key || !req.webAuth || req.webAuth.user.anonymous) return;
    if (reply.statusCode >= 300 || cfg.key.startsWith('auth.')) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const targetId = params.id ?? params.groupId ?? params.reportId ?? params.auditId ?? null;
    deps.audit.admin({ tenantId: req.tenantCtx?.tenant.id ?? null, actorUserId: req.webAuth.user.id, action: cfg.key, targetType: cfg.key.split('.')[0]!, targetId, after: sanitizeBody(req.body), ip: req.ip, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null });
  });
}

/** Secret values never reach the audit log, not even redacted. */
function sanitizeBody(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body ?? null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) out[k] = /^(value|apiKey|token|content|password|secret)$/i.test(k) ? '[omitted]' : v;
  return out;
}

export function requireUser(req: FastifyRequest): ConsoleUser {
  if (!req.webAuth) throw AppError.unauthenticated();
  return req.webAuth.user;
}

export function requireCap(req: FastifyRequest, cap: Capability): ConsoleUser {
  const user = requireUser(req);
  if (!hasCapability(roleOf(requireTenant(req)), cap)) throw AppError.forbidden();
  return user;
}

/** The membership role that drives capability checks; a context without a role (data plane, public pages) gets the viewer set. */
function roleOf(ctx: TenantContext) {
  return ctx.role ?? 'viewer';
}

/** The request's tenant context; 403 `no_tenant` when the user has no membership (spec §3.3). */
export function requireTenant(req: FastifyRequest): TenantContext {
  if (!req.tenantCtx) {
    if (!req.webAuth) throw AppError.unauthenticated();
    throw new AppError('forbidden', 'You are not a member of any organization on this server', { extensions: { reason: 'no_tenant' } });
  }
  return req.tenantCtx;
}

/** The id of the request's tenant (every tenant-scoped `/api` handler reads it from here). */
export function tenantOf(req: FastifyRequest): string {
  return requireTenant(req).tenant.id;
}

export function clientMeta(req: FastifyRequest): { ip: string; userAgent: string | null } {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua.slice(0, 512) : null };
}
