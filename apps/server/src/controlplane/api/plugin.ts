import type { FastifyInstance } from 'fastify';
import { installWebAuth } from '../auth/guards.js';
import type { ApiContext } from './context.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { toolRoutes } from './routes/tools.js';
import { overlayRoutes } from './routes/overlays.js';
import { environmentRoutes } from './routes/environments.js';
import { keyRoutes } from './routes/keys.js';
import { taskRoutes } from './routes/tasks.js';
import { inboxRoutes } from './routes/inbox.js';
import { metricsRoutes } from './routes/metrics.js';
import { auditRoutes } from './routes/audit.js';
import { settingsRoutes } from './routes/settings.js';
import { memberRoutes } from './routes/members.js';
import { publicRoutes } from './routes/public.js';

/** Signature of every console route module (evals routes included). */
export type ApiRouteModule = (app: FastifyInstance, c: ApiContext) => Promise<void>;

export const ROUTE_MODULES: ApiRouteModule[] = [authRoutes, serverRoutes, toolRoutes, overlayRoutes, environmentRoutes, keyRoutes, taskRoutes, inboxRoutes, metricsRoutes, auditRoutes, settingsRoutes, memberRoutes, publicRoutes];

/** Optional route modules owned by other workstreams, loaded when present (keeps the build green). */
const OPTIONAL_MODULES = [{ path: './routes/evals.js', exportName: 'evalsRoutes' }];

/** Console REST API (§14): session/CSRF/access gate, then every route module. */
export async function apiPlugin(app: FastifyInstance, c: ApiContext): Promise<void> {
  installWebAuth(app, { db: c.dbs.main.db, sessions: c.sessions, audit: c.audit, demoReadOnly: c.config.env.NEUROUTER_DEMO_READ_ONLY, tenancy: c.tenancy, maintenance: c.config.env.NEUROUTER_MAINTENANCE });
  for (const m of ROUTE_MODULES) await m(app, c);
  for (const o of OPTIONAL_MODULES) {
    let mod: Record<string, unknown> | null = null;
    try {
      mod = (await import(o.path)) as Record<string, unknown>;
    } catch (err) {
      if (!/Cannot find module|ERR_MODULE_NOT_FOUND|Failed to load/i.test((err as Error).message)) throw err;
    }
    const fn = mod?.[o.exportName];
    if (typeof fn === 'function') await (fn as ApiRouteModule)(app, c);
  }
}
