import type { FastifyInstance, FastifyRequest } from 'fastify';
import { api, capabilitiesFor, isSafeReturnTo, type Me } from '@neurouter/shared';
import { AppError } from '../../../kernel/lib/errors.js';
import { newId } from '../../../kernel/lib/ids.js';
import { loadConsoleUser, type ConsoleUser } from '../../../kernel/principal.js';
import { clientMeta, requireUser } from '../../auth/guards.js';
import { anyProviderKey } from '../../evals/model-keys.js';
import type { ApiContext } from '../context.js';
import { embedderView } from '../context.js';
import { route } from '../routes.js';

export const ANONYMOUS_EMAIL = 'anonymous@demo.invalid';

async function badges(c: ApiContext) {
  const db = c.dbs.main.db;
  const [n, i, e] = await Promise.all([
    db.selectFrom('need_groups').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'open').executeTakeFirst(),
    db.selectFrom('issues').select((eb) => eb.fn.countAll<number>().as('n')).where('status', '=', 'open').executeTakeFirst(),
    db.selectFrom('eval_runs').select((eb) => eb.fn.countAll<number>().as('n')).where('status', 'in', ['queued', 'running']).executeTakeFirst(),
  ]);
  return { inboxOpen: Number(n?.n ?? 0) + Number(i?.n ?? 0), evalsRunning: Number(e?.n ?? 0) };
}

export async function evalsConfigured(c: ApiContext): Promise<boolean> {
  if (c.config.env.NEUROUTER_EVAL_LLM || c.config.env.NEUROUTER_EVAL_FAKE_LLM) return true;
  return anyProviderKey({ env: c.config.env as unknown as Record<string, string | undefined>, settings: c.settings });
}

export async function buildMe(c: ApiContext, user: ConsoleUser, csrfToken: string): Promise<Me> {
  const codeMode = (await c.settings.get('codeModeEnabled')) && c.ports.executorStatus().ok;
  return {
    user: { id: user.id, email: user.email, name: user.name, role: user.role, anonymous: user.anonymous },
    capabilities: capabilitiesFor(user.role),
    csrfToken,
    features: {
      codeMode,
      embeddings: c.embedderStatus(),
      evals: await evalsConfigured(c),
      oauthBroker: true,
      externalAs: c.config.externalAs !== null,
      events: true,
      configMode: c.config.configMode,
    },
    badges: await badges(c),
    instance: { name: (await c.settings.get('orgName')) ?? c.config.env.ORG_NAME, version: c.version, demoReadOnly: c.config.env.NEUROUTER_DEMO_READ_ONLY },
  };
}

/** The demo's shared anonymous viewer user (§13.1). */
async function anonymousUser(c: ApiContext): Promise<string> {
  const db = c.dbs.main.db;
  const u = await db.selectFrom('users').select('id').where('email', '=', ANONYMOUS_EMAIL).executeTakeFirst();
  if (u) return u.id;
  const id = newId();
  const now = c.clock.now();
  await db.insertInto('users').values({ id, email: ANONYMOUS_EMAIL, name: 'Demo visitor', role: 'viewer', role_source: 'local', created_at: now, updated_at: now }).onConflict((oc) => oc.doNothing()).execute();
  return (await db.selectFrom('users').select('id').where('email', '=', ANONYMOUS_EMAIL).executeTakeFirstOrThrow()).id;
}

async function startSession(c: ApiContext, req: FastifyRequest, reply: Parameters<Parameters<typeof route>[3]>[1], userId: string, opts: { anonymous?: boolean; idTokenHint?: string | null } = {}) {
  const m = clientMeta(req);
  const sess = await c.sessions.create(userId, { ip: m.ip, userAgent: m.userAgent, ...(opts.idTokenHint ? { idTokenHint: opts.idTokenHint } : {}), ...(opts.anonymous ? { anonymous: true } : {}) });
  c.sessions.setCookie(reply, sess.token, sess.expiresAt);
  return sess;
}

/** `auth.*` and `me.*` (§14.2). */
export async function authRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  route(app, 'auth.config', api.auth.config, async () => ({
    oidc: { enabled: c.login.oidcEnabled, displayName: c.config.env.OIDC_DISPLAY_NAME },
    localLink: c.config.localLink,
    demoReadOnly: c.config.env.NEUROUTER_DEMO_READ_ONLY,
    orgName: (await c.settings.get('orgName')) ?? c.config.env.ORG_NAME,
  }));

  route(app, 'auth.oidcStart', api.auth.oidcStart, async (req, reply) => {
    if (!c.login.oidcEnabled) throw AppError.notFound('OIDC sign-in');
    return reply.redirect(await c.login.start(req.query.returnTo), 302);
  });

  route(app, 'auth.oidcCallback', api.auth.oidcCallback, async (req, reply) => {
    const url = new URL(req.url, c.config.publicUrl);
    const out = await c.login.finish(url, clientMeta(req));
    if (!out.ok) return reply.redirect(`/auth/login?error=${out.error}`, 302);
    await startSession(c, req, reply, out.userId, { idTokenHint: out.idToken });
    await c.settings.set('firstAdminSignedIn', true);
    return reply.redirect(isSafeReturnTo(out.returnTo) ? out.returnTo : '/', 302);
  });

  route(app, 'auth.link', api.auth.link, async (req, reply) => {
    if (!c.config.localLink) throw AppError.unauthenticated('Local sign-in links are disabled');
    const userId = await c.links.consume(req.body.token);
    if (!userId) {
      c.audit.auth({ userId: null, action: 'auth.local_link.use', status: 'blocked', reason: 'invalid_or_used' });
      throw AppError.unauthenticated('The sign-in link is invalid, expired or already used');
    }
    const user = await loadConsoleUser(c.dbs.main.db, userId);
    if (!user || user.status !== 'active') throw AppError.unauthenticated('The account is disabled');
    const sess = await startSession(c, req, reply, userId);
    await c.dbs.main.db.updateTable('users').set({ last_login_at: c.clock.now() }).where('id', '=', userId).execute();
    await c.settings.set('firstAdminSignedIn', true);
    c.audit.auth({ userId, action: 'auth.local_link.use', ...clientMeta(req) });
    return buildMe(c, user, sess.csrfToken);
  });

  route(app, 'auth.logout', api.auth.logout, async (req, reply) => {
    const auth = req.webAuth;
    let endSessionUrl: string | null = null;
    if (auth) {
      await c.sessions.destroy(auth.session.idHash);
      if (c.oidcProvider && auth.session.idTokenHint) endSessionUrl = await c.oidcProvider.endSessionUrl({ idTokenHint: auth.session.idTokenHint, postLogoutRedirectUri: `${c.config.publicUrl}/auth/logged-out` });
      c.audit.auth({ userId: auth.user.id, action: 'auth.logout' });
    }
    c.sessions.clearCookie(reply);
    return { endSessionUrl };
  });

  route(app, 'me.get', api.me.get, async (req, reply) => {
    if (!req.webAuth) {
      if (!c.config.env.NEUROUTER_DEMO_READ_ONLY) throw AppError.unauthenticated();
      const id = await anonymousUser(c);
      const sess = await startSession(c, req, reply, id, { anonymous: true });
      const user = (await loadConsoleUser(c.dbs.main.db, id, true))!;
      return buildMe(c, user, sess.csrfToken);
    }
    return buildMe(c, requireUser(req), req.webAuth.session.csrfToken);
  });

  route(app, 'me.badges', api.me.badges, async () => badges(c));
  void embedderView;
}
