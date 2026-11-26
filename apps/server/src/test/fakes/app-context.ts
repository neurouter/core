import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { resolve } from 'node:path';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { startServer, type RunningServer } from '../../server.js';
import { SessionService } from '../../controlplane/auth/sessions.js';
import { newId } from '../../kernel/lib/ids.js';

export const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
export const PETSTORE = resolve(REPO_ROOT, 'examples/petstore/openapi.yaml');

export interface TestUser {
  id: string;
  email: string;
  cookie: string;
  csrf: string;
}

export interface TestContext {
  s: RunningServer;
  admin: TestUser;
  /** Creates a user with a role and a signed-in session. */
  user(email: string, role: 'admin' | 'viewer'): Promise<TestUser>;
  /** Injects with the user's cookie (+ CSRF on non-GET). `null` = anonymous. */
  as(u: TestUser | null, opts: InjectOptions): Promise<LightMyRequestResponse>;
  /** JSON body helper (throws with the payload on an unexpected status). */
  json<T = any>(u: TestUser | null, opts: InjectOptions, status?: number): Promise<T>;
  close(): Promise<void>;
}

/** Wraps an already running server (e.g. `bootServer()` from ./server.ts) with console session helpers. */
export async function consoleOn(s: RunningServer): Promise<TestContext> {
  return withHelpers(s);
}

/** In-process server (SQLite memory, embeddings off, executor off unless asked), no listening socket. */
export async function createTestContext(env: Record<string, string> = {}, services: NonNullable<Parameters<typeof startServer>[0]>['services'] = {}): Promise<TestContext> {
  return withHelpers(await startServer({
    env: {
      NODE_ENV: 'test',
      PUBLIC_URL: 'http://console.test',
      DATABASE_URL: 'sqlite::memory:',
      EMBEDDINGS_ENABLED: 'false',
      NEUROUTER_EXECUTOR_MODE: 'off',
      LOG_LEVEL: 'error',
      NEUROUTER_LOCAL_LINK: 'true',
      // suites written against agent contract 1 keep it for the servers they create (contract-2 suites pass '2' or negotiate)
      NEUROUTER_NEW_SERVER_CONTRACT: '1',
      ...env,
    },
    listen: false,
    jobs: false,
    services: { defaultMetrics: false, ...services },
  }));
}

async function withHelpers(s: RunningServer): Promise<TestContext> {
  const sessions = new SessionService(s.services.dbs.main.db, s.services.clock, { cookieName: s.config.cookieNames.session, secure: false, ttlMs: 3_600_000, idleMs: 3_600_000 });
  const user = async (email: string, role: 'admin' | 'viewer'): Promise<TestUser> => {
    const db = s.services.dbs.main.db;
    let row = await db.selectFrom('users').select('id').where('email', '=', email).executeTakeFirst();
    if (!row) {
      const id = newId();
      await db.insertInto('users').values({ id, tenant_id: DEFAULT_TENANT_ID, email, name: email.split('@')[0]!, role, role_source: 'local', created_at: Date.now(), updated_at: Date.now() }).execute();
      row = { id };
    }
    const sess = await sessions.create(row.id);
    return { id: row.id, email, cookie: `${s.config.cookieNames.session}=${sess.token}`, csrf: sess.csrfToken };
  };
  const admin = await user('admin@test.dev', 'admin');
  const as = (u: TestUser | null, opts: InjectOptions) =>
    s.app.inject({ ...opts, headers: { ...(opts.headers ?? {}), ...(u ? { cookie: u.cookie, ...(opts.method && opts.method !== 'GET' ? { 'x-csrf-token': u.csrf } : {}) } : {}) } });
  const json = async (u: TestUser | null, opts: InjectOptions, status?: number) => {
    const r = await as(u, opts);
    if (status !== undefined && r.statusCode !== status) throw new Error(`${opts.method ?? 'GET'} ${opts.url} → ${r.statusCode} (expected ${status}): ${r.body.slice(0, 2000)}`);
    return r.body ? JSON.parse(r.body) : null;
  };
  return { s, admin, user, as, json, close: () => s.close() };
}

/** Imports the petstore example through the API (as admin); returns the ServerDetail. */
export async function importPetstore(t: TestContext, slug = 'petstore'): Promise<any> {
  const { readFile } = await import('node:fs/promises');
  const content = await readFile(PETSTORE, 'utf8');
  const out = await t.json(t.admin, { method: 'POST', url: '/api/servers', payload: { slug, name: 'Petstore', source: { content } } }, 202);
  await t.s.services.jobs.idle();
  return out.server;
}
