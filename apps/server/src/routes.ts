import type { FastifyInstance } from 'fastify';
import type { Services } from './deps.js';
import { mcpRoutes } from './dataplane/mcp/route.js';
import { topToolsByUsage } from './dataplane/tasks/usage.js';
import { oauthRoutes } from './controlplane/oauth/routes.js';
import { consolePlugin } from './console.js';

/** Route plugins in registration order: data plane (`/mcp`, PRM), then control plane (`/api`, OAuth, public). */
export function routePlugins(s: Services, extra: Array<(app: FastifyInstance) => Promise<void> | void> = []): Array<(app: FastifyInstance) => Promise<void> | void> {
  const usageCache = new Map<string, { at: number; tools: string[] }>();
  const usagePinned = (environmentId: string): string[] => {
    const hit = usageCache.get(environmentId);
    if (!hit || s.clock.now() - hit.at > 3_600_000) {
      const since = new Date(s.clock.now() - 7 * 86_400_000).toISOString().slice(0, 10);
      usageCache.set(environmentId, { at: s.clock.now(), tools: hit?.tools ?? [] });
      void topToolsByUsage(s.dbs.main.db, environmentId, since).then((tools) => usageCache.set(environmentId, { at: s.clock.now(), tools })).catch(() => {});
    }
    return usageCache.get(environmentId)?.tools ?? [];
  };
  let nativeClients: string[] = [];
  void s.settings.get('nativeSearchClients').then((v) => (nativeClients = v)).catch(() => {});
  return [
    async (app) => {
      await mcpRoutes(app, {
        publicUrl: s.config.publicUrl,
        allowedOrigins: s.config.env.MCP_ALLOWED_ORIGINS,
        version: s.version,
        runtime: s.runtime,
        authenticator: s.authenticator,
        pipeline: s.pipeline,
        dispatcher: s.dispatcher,
        tracker: s.tracker,
        audit: s.audit,
        keyring: s.keyring,
        bus: s.bus,
        executorHealthy: () => s.executorHealth.healthy,
        usagePinned,
        nativeSearchClients: () => nativeClients,
        externalIssuer: s.config.externalAs?.issuer ?? null,
        now: () => s.clock.now(),
        onAuthFailure: (reason, method) => s.metrics.authFailure(method, reason),
      });
    },
    async (app) => {
      await oauthRoutes(app, {
        publicUrl: s.config.publicUrl,
        consentCookie: s.config.cookieNames.consent,
        dcrEnabled: () => s.settings.get('dcrEnabled'),
        clients: s.oauthClients,
        tokens: s.oauthTokens,
        authorization: s.authorization,
        sessions: s.consoleSessions,
        rateLimit: s.coord.rateLimit,
        upstream: s.upstreamOAuth,
      });
    },
    consolePlugin(s),
    ...extra,
  ];
}
