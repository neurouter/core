import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer, type RunningServer } from '../../server.js';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

/** A port the OS just reported free (tests run files in parallel, so fixed/random bases collide). */
export async function freePort(): Promise<number> {
  const { createServer } = await import('node:net');
  return new Promise((res, rej) => {
    const srv = createServer();
    srv.once('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => res(port));
    });
  });
}

/** Boots a real server (SQLite in memory, in-process executor, embeddings off) on a free port. */
export async function bootServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const port = String(await freePort());
  return startServer({
    env: {
      NODE_ENV: 'test',
      HOST: '127.0.0.1',
      PORT: port,
      PUBLIC_URL: `http://127.0.0.1:${port}`,
      DATABASE_URL: 'sqlite::memory:',
      EMBEDDINGS_ENABLED: 'false',
      NEUROUTER_EXECUTOR_MODE: 'local',
      NEUROUTER_EXECUTOR_PREWARM: '1',
      LOG_LEVEL: 'error',
      NEUROUTER_CONFIG: resolve(REPO_ROOT, 'neurouter.example.yaml'),
      ...env,
    },
    jobs: false,
    services: { defaultMetrics: false },
  });
}

export async function keyFor(s: RunningServer, server: string, env: string, scopes: Array<'tools:read' | 'tools:write' | 'code:run'>, extra: { profile?: string; purpose?: 'user' | 'eval' } = {}): Promise<string> {
  const svc = s.services;
  const srv = (await svc.servers.bySlug(svc.tenantId, server))!;
  const envRow = (await svc.servers.environments(srv.id)).find((e) => e.slug === env)!;
  const admin = await svc.users.ensureBootstrapAdmin();
  const { token } = await svc.apiKeys.create({ tenantId: svc.tenantId, name: `test ${env}`, serverId: srv.id, environmentId: envRow.id, scopes, ownerUserId: admin.id, ...extra });
  return token;
}

export async function mcpClient(s: RunningServer, server: string, env: string, token: string, opts: { elicitation?: boolean; headers?: Record<string, string>; onElicit?: (msg: string) => { approve: boolean }; era?: 'legacy' | 'modern' } = {}): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {}, ...(opts.era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {}) } as never);
  if (opts.elicitation) {
    client.setRequestHandler('elicitation/create', async (req) => {
      const r = opts.onElicit ? opts.onElicit(String((req.params as { message?: string }).message ?? '')) : { approve: true };
      return r.approve ? { action: 'accept', content: { approve: true } } : { action: 'decline' };
    });
  }
  const transport = new StreamableHTTPClientTransport(new URL(`${s.url}/mcp/${server}/${env}`), { requestInit: { headers: { authorization: `Bearer ${token}`, ...(opts.headers ?? {}) } } });
  await client.connect(transport);
  return client;
}

/** A fresh database per test file on a throwaway Postgres (integration tests only); returns its URL. */
export async function resetPg(url: string, name = 'nr_test'): Promise<string> {
  const pg = (await import('pg')).default;
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  const db = name.replace(/[^a-z0-9_]/gi, '_').toLowerCase();
  await c.query(`drop database if exists ${db} with (force)`);
  await c.query(`create database ${db}`);
  await c.end();
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}
