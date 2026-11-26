import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Logger } from 'pino';
import { errorHandler, notFoundProblem } from './controlplane/api/problem.js';
import type { AuditStore } from './kernel/audit/store.js';
import type { Config } from './kernel/config/load.js';
import type { Databases } from './kernel/db/index.js';
import { healthRoutes } from './health/routes.js';
import type { Clock } from './kernel/lib/clock.js';
import { newId } from './kernel/lib/ids.js';
import { timingSafeEqualStr } from './kernel/lib/crypto.js';
import type { Metrics } from './kernel/observability/metrics.js';
import { WEB_CSP_DIRECTIVES, registerWebStatic, sendIndex, wantsSpa } from './web/static.js';

export interface AppDeps {
  config: Config;
  logger: Logger;
  dbs: Databases;
  auditStore: AuditStore;
  clock: Clock;
  version: string;
  metrics?: Metrics;
  /** extra readiness checks (`executor`, `embedder`): informational, never fail readiness by themselves. */
  readinessInfo?: Record<string, () => Promise<{ ok: boolean; error?: string; detail?: string }>>;
  /** Route plugins (MCP, OAuth, `/api/*`, `/public/*`); contract paths include their prefixes. */
  plugins?: Array<(app: FastifyInstance) => Promise<void> | void>;
}

const REQUEST_ID_RE = /^[A-Za-z0-9._:-]{8,128}$/;

/** `TRUST_PROXY`: 'true' / 'false' / hop count / comma list of IPs, CIDRs or 'loopback' (COPY Hub). */
export function parseTrustProxy(value: string): boolean | string | ((addr: string, hop: number) => boolean) {
  if (value === 'true') return true;
  if (value === 'false' || value === '') return false;
  if (/^\d+$/.test(value)) {
    const hops = Number(value);
    return (_addr: string, hop: number) => hop < hops;
  }
  return value;
}

/** Pure wiring (ADAPT Hub app.ts): plugins, error model, health, metrics, route plugins and (in production) the console. */
export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const { config } = deps;
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger,
    trustProxy: parseTrustProxy(config.env.TRUST_PROXY),
    bodyLimit: 12 * 1024 * 1024,
    requestIdHeader: false,
    genReqId: (req) => {
      const incoming = req.headers['x-request-id'];
      return typeof incoming === 'string' && REQUEST_ID_RE.test(incoming) ? incoming : newId();
    },
    routerOptions: { ignoreTrailingSlash: true },
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(errorHandler);
  app.addHook('onSend', async (req, reply) => {
    reply.header('x-request-id', String(req.id));
  });
  await app.register(helmet, {
    contentSecurityPolicy: { useDefaults: false, directives: WEB_CSP_DIRECTIVES },
    hsts: config.publicUrl.startsWith('https://') ? { maxAge: 31536000, includeSubDomains: true } : false,
    crossOriginEmbedderPolicy: false,
    frameguard: { action: 'deny' },
  });
  await app.register(cookie);
  await app.register(healthRoutes, { dbs: deps.dbs, auditStore: deps.auditStore, version: deps.version, ...(deps.readinessInfo ? { infoChecks: deps.readinessInfo } : {}) });

  if (config.env.METRICS_ENABLED && deps.metrics) {
    const m = deps.metrics;
    app.get('/metrics', { logLevel: 'warn' }, async (req, reply) => {
      const token = config.env.METRICS_TOKEN;
      if (token) {
        const auth = req.headers.authorization ?? '';
        if (!timingSafeEqualStr(auth, `Bearer ${token}`)) return reply.status(401).send({ error: 'unauthorized' });
      }
      const out = await m.render();
      return reply.type(out.contentType).send(out.body);
    });
  }

  for (const plugin of deps.plugins ?? []) await app.register(async (scope) => plugin(scope));

  let spa = false;
  if (config.serveWeb) {
    spa = await registerWebStatic(app, { distDir: config.webDistDir });
    if (!spa) app.log.warn({ dir: config.webDistDir }, 'console build not found; run `npm run build -w @neurouter/web` to serve the UI');
  }
  app.setNotFoundHandler((req, reply) => {
    if (spa && wantsSpa(req)) return sendIndex(reply);
    return notFoundProblem(req, reply);
  });
  return app;
}
