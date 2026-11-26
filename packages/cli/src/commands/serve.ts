import { mintConsoleLink, startServer, type RunningServer } from '@neurouter/server';
import { Scope } from '@neurouter/shared';
import { serverEnv } from './common.js';

/** `npx neurouter serve`: the full server on SQLite; prints the MCP endpoints and a console link. */
export async function cmdServe(o: { config?: string; port: string; host: string; data: string; embeddings?: boolean }): Promise<void> {
  const env = serverEnv({ data: o.data, port: o.port, host: o.host, ...(o.config ? { config: o.config } : {}), ...(o.embeddings ? { embeddings: true } : {}) });
  env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';
  env.LOG_PRETTY ??= 'true';
  const running = await startServer({ env, loadDotenv: false });
  const s = running.services;
  const servers = await s.dbs.main.db.selectFrom('servers as sv').innerJoin('environments as e', 'e.server_id', 'sv.id').select(['sv.slug', 'e.slug as env', 'e.kind']).where('sv.status', '=', 'active').execute();
  console.log(`\nNeurouter is running at ${running.config.publicUrl}`);
  for (const r of servers) console.log(`  MCP  ${running.config.publicUrl}/mcp/${r.slug}/${r.env}   (${r.kind})`);
  if (!servers.length) console.log('  no servers yet: pass --config neurouter.yaml or import a spec in the console');
  const link = await consoleLink(running);
  if (link) console.log(`\nConsole sign-in (one-time, 15 min): ${link}`);
  console.log('Create an API key: npx neurouter keys create --server <slug> --env <env> --scopes tools:read,code:run\n');
  const stop = async () => {
    await running.close();
    process.exit(0);
  };
  process.once('SIGINT', () => void stop());
  process.once('SIGTERM', () => void stop());
}

async function consoleLink(running: RunningServer): Promise<string | null> {
  if (!running.config.localLink) return null;
  return mintConsoleLink(running.services);
}

/** `npx neurouter console-link`: one-time sign-in URL for the bootstrap admin (needs DB access, §13.1). */
export async function cmdConsoleLink(o: { data: string }): Promise<void> {
  const running = await startServer({ env: serverEnv({ data: o.data }), listen: false, jobs: false, loadDotenv: false, services: { executor: null } });
  try {
    const link = await consoleLink(running);
    if (!link) throw new Error('local sign-in links are disabled (NEUROUTER_LOCAL_LINK=false)');
    console.log(link);
  } finally {
    await running.close();
  }
}

/** `npx neurouter keys create`: an API key bound to one server + environment. Prints the token once. */
export async function cmdKeysCreate(o: { server: string; env: string; scopes: string; name: string; data: string }): Promise<void> {
  const running = await startServer({ env: serverEnv({ data: o.data }), listen: false, jobs: false, loadDotenv: false, services: { executor: null } });
  try {
    const s = running.services;
    const srv = await s.servers.bySlug(s.tenantId, o.server);
    if (!srv) throw new Error(`unknown server ${o.server}`);
    const env = (await s.servers.environments(srv.id)).find((e) => e.slug === o.env);
    if (!env) throw new Error(`unknown environment ${o.server}/${o.env}`);
    const scopes = o.scopes.split(',').map((x) => Scope.parse(x.trim()));
    const admin = await s.users.ensureBootstrapAdmin();
    const { token, warnings } = await s.apiKeys.create({ tenantId: s.tenantId, name: o.name, serverId: srv.id, environmentId: env.id, scopes, ownerUserId: admin.id });
    for (const w of warnings) console.error(`warning: ${w}`);
    console.log(token);
  } finally {
    await running.close();
  }
}
