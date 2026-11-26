import { resolve } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startServer, type RunningServer } from '../../server.js';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

let nextPort = 39000 + Math.floor(Math.random() * 2000);

/** Boots a real server (SQLite in memory, in-process executor, embeddings off) on a free port. */
export async function bootServer(env: Record<string, string> = {}): Promise<RunningServer> {
  const port = String(nextPort++);
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

export async function mcpClient(s: RunningServer, server: string, env: string, token: string, opts: { elicitation?: boolean; headers?: Record<string, string>; onElicit?: (msg: string) => { approve: boolean } } = {}): Promise<Client> {
  const client = new Client({ name: 'test-agent', version: '1.0.0' }, { capabilities: opts.elicitation ? { elicitation: { form: {} } } : {} });
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
