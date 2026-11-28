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
import { evalsRoutes } from './routes/evals.js';

/** Signature of every console route module. */
export type ApiRouteModule = (app: FastifyInstance, c: ApiContext) => Promise<void>;

/**
 * Every console route module, statically imported: the production bundle (dist-bundle/) does not
 * follow a dynamic `import()` of a computed relative path, so a module loaded that way silently
 * vanished from the image (the evals routes, 0.2.0–0.3.5).
 */
export const ROUTE_MODULES: ApiRouteModule[] = [authRoutes, serverRoutes, toolRoutes, overlayRoutes, environmentRoutes, keyRoutes, taskRoutes, inboxRoutes, metricsRoutes, auditRoutes, settingsRoutes, memberRoutes, publicRoutes, evalsRoutes];

/** Console REST API (§14): session/CSRF/access gate, then every route module. */
export async function apiPlugin(app: FastifyInstance, c: ApiContext): Promise<void> {
  installWebAuth(app, { db: c.dbs.main.db, sessions: c.sessions, audit: c.audit, demoReadOnly: c.config.env.NEUROUTER_DEMO_READ_ONLY, tenancy: c.tenancy, maintenance: c.config.env.NEUROUTER_MAINTENANCE });
  for (const m of ROUTE_MODULES) await m(app, c);
}
