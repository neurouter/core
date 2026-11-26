import formbody from '@fastify/formbody';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimitStore } from '../../kernel/coordination/types.js';
import type { AuthorizationService, ConsentView } from './authorize.js';
import { OAuthError } from './cimd.js';
import type { OAuthClientsService } from './clients.service.js';
import { authorizationServerMetadata } from './metadata.js';
import type { ConsoleSessionLookup } from './session.js';
import type { OAuthTokensService } from './tokens.service.js';
import type { UpstreamOAuthService } from '../upstream-oauth/upstream-oauth.service.js';

const NO_STORE = { 'cache-control': 'no-store', pragma: 'no-cache' } as const;

export interface OAuthRouteDeps {
  publicUrl: string;
  consentCookie: string;
  dcrEnabled: () => Promise<boolean>;
  clients: OAuthClientsService;
  tokens: OAuthTokensService;
  authorization: AuthorizationService;
  sessions: ConsoleSessionLookup;
  rateLimit?: RateLimitStore;
  upstream?: UpstreamOAuthService | null;
}

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `body{font:15px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;min-height:100vh;background:#fafafa;color:#18181b}main{max-width:34rem;margin:1rem;padding:1.5rem;border:1px solid #e4e4e7;border-radius:.75rem;background:#fff}code{background:#f4f4f5;padding:.1rem .3rem;border-radius:.25rem}.prod{display:inline-block;background:#dc2626;color:#fff;font-weight:600;font-size:.75rem;padding:.1rem .45rem;border-radius:.3rem;margin-left:.4rem;letter-spacing:.04em}.muted{color:#71717a}label{display:block;margin:.5rem 0}label.off{color:#a1a1aa}.row{display:flex;gap:.5rem;margin-top:1.25rem}button{font:inherit;padding:.5rem 1rem;border-radius:.5rem;border:1px solid #d4d4d8;background:#fff;cursor:pointer}button.primary{background:#18181b;color:#fff;border-color:#18181b}@media(prefers-color-scheme:dark){body{background:#09090b;color:#fafafa}main{background:#18181b;border-color:#27272a}code{background:#27272a}button{background:#27272a;color:#fafafa;border-color:#3f3f46}button.primary{background:#fafafa;color:#18181b}}`;

/** Script-free error page: authorization errors before redirect_uri validation are never redirected. */
export function errorPage(reply: FastifyReply, status: number, error: string, description: string) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorization error</title><style>${STYLE}</style></head>
<body><main><h1 style="font-size:1.125rem;margin:0 0 .5rem">This app can't be authorized</h1><p>${esc(description)}</p><p class="muted">Error: <code>${esc(error)}</code>. Close this window and check your MCP client's configuration, or contact your Neurouter administrator.</p></main></body></html>`;
  return reply.status(status).header('content-type', 'text/html; charset=utf-8').headers(NO_STORE).send(html);
}

/** Server-rendered consent page (§13.3; ADAPT Hub): client, server, environment (PROD badge), scope checkboxes. */
export function consentPage(v: ConsentView): string {
  const prod = v.environment.kind === 'prod' ? '<span class="prod">PROD</span>' : '';
  const scopes = v.scopes
    .map(
      (s) =>
        `<label class="${s.disabled && s.name !== 'mcp:tools' ? 'off' : ''}"><input type="checkbox" name="scope" value="${esc(s.name)}"${s.checked ? ' checked' : ''}${s.disabled ? ' disabled' : ''}> <code>${esc(s.name)}</code> ${esc(s.description)}${s.note ? ` <span class="muted">(${esc(s.note)})</span>` : ''}</label>${s.name === 'mcp:tools' ? '<input type="hidden" name="scope" value="mcp:tools">' : ''}`,
    )
    .join('');
  const who = v.client.verified ? `<span class="muted">${esc(v.client.idHost ?? '')}</span>` : '<span class="muted">(self-registered, unverified)</span>';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Authorize ${esc(v.client.name)}</title><style>${STYLE}</style></head>
<body><main>
<h1 style="font-size:1.125rem;margin:0 0 .5rem">Allow <strong>${esc(v.client.name)}</strong> ${who} to use ${esc(v.server.name)}?</h1>
<p>Environment: <strong>${esc(v.environment.name)}</strong> <code>${esc(v.server.slug)}/${esc(v.environment.slug)}</code>${prod}</p>
<p class="muted">Signed in as ${esc(v.user.email)}. After approval you return to <code>${esc(v.client.redirectHost)}</code>${v.client.localhostOnly ? ' (this computer)' : ''}.</p>
<form method="post" action="/oauth/consent">
<input type="hidden" name="request" value="${esc(v.requestId)}"><input type="hidden" name="csrf" value="${esc(v.csrfToken)}">
${scopes}
<div class="row"><button class="primary" type="submit" name="decision" value="approve">Allow</button><button type="submit" name="decision" value="deny">Deny</button></div>
</form></main></body></html>`;
}

function oauthError(reply: FastifyReply, err: OAuthError, basic = false) {
  if (err.status === 401 && basic) reply.header('www-authenticate', 'Basic realm="neurouter"');
  return reply.status(err.status).headers(NO_STORE).header('access-control-allow-origin', '*').send({ error: err.error, error_description: err.description });
}

function parseBasic(header: string | undefined): { id: string; secret: string } | null {
  const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header ?? '');
  if (!m) return null;
  const raw = Buffer.from(m[1]!, 'base64').toString('utf8');
  const i = raw.indexOf(':');
  if (i < 0) return null;
  try {
    return { id: decodeURIComponent(raw.slice(0, i).replace(/\+/g, ' ')), secret: decodeURIComponent(raw.slice(i + 1).replace(/\+/g, ' ')) };
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * MCP OAuth 2.1 AS endpoints (§13.3; ADAPT Hub oauth/routes.ts): RFC 8414 metadata (+ OIDC alias),
 * authorize, server-rendered consent, token, DCR, revoke, and the upstream broker connect/callback.
 */
export async function oauthRoutes(app: FastifyInstance, d: OAuthRouteDeps): Promise<void> {
  const issuer = d.publicUrl;
  const secure = d.publicUrl.startsWith('https://');
  const asMetadata = async (_req: FastifyRequest, reply: FastifyReply) => reply.header('cache-control', 'public, max-age=3600').header('access-control-allow-origin', '*').send(authorizationServerMetadata(issuer, { dcrEnabled: await d.dcrEnabled() }));
  app.get('/.well-known/oauth-authorization-server', asMetadata);
  app.get('/.well-known/openid-configuration', asMetadata);

  app.get('/oauth/authorize', async (req, reply) => {
    const user = await d.sessions.userFromRequest(req);
    const out = await d.authorization.authorize(req.query as Record<string, string | undefined>, req.url, user);
    switch (out.kind) {
      case 'error_page':
        return errorPage(reply, out.status, out.error, out.description);
      case 'redirect':
      case 'login':
        return reply.headers(NO_STORE).redirect(out.location, 302);
      case 'consent':
        reply.setCookie(d.consentCookie, out.cookieValue, { path: '/oauth', httpOnly: true, secure, sameSite: 'strict', maxAge: 600 });
        return reply.headers(NO_STORE).redirect(out.location, 302);
    }
  });

  app.get('/oauth/consent', async (req, reply) => {
    const user = await d.sessions.userFromRequest(req);
    if (!user) return reply.headers(NO_STORE).redirect(d.sessions.loginUrl(req.url), 302);
    const id = str((req.query as Record<string, unknown>).request) ?? '';
    try {
      const view = await d.authorization.view(id, user);
      return reply.header('content-type', 'text/html; charset=utf-8').headers(NO_STORE).header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'").send(consentPage(view));
    } catch (err) {
      if (err instanceof OAuthError) return errorPage(reply, err.status, err.error, err.description);
      throw err;
    }
  });

  const limit = async (req: FastifyRequest, route: string, perMinute: number): Promise<boolean> => {
    if (!d.rateLimit) return true;
    return (await d.rateLimit.take(`ip:${req.ip}:${route}`, { capacity: perMinute, refillPerMs: perMinute / 60_000 })).allowed;
  };

  await app.register(async (scope) => {
    await scope.register(formbody, { bodyLimit: 64 * 1024 });
    for (const path of ['/oauth/token', '/oauth/register', '/oauth/revoke']) {
      scope.options(path, async (_req, reply) =>
        reply.status(204).header('access-control-allow-origin', '*').header('access-control-allow-methods', 'POST, OPTIONS').header('access-control-allow-headers', 'authorization, content-type, mcp-protocol-version').header('access-control-max-age', '600').send(),
      );
    }

    scope.post('/oauth/consent', async (req, reply) => {
      const user = await d.sessions.userFromRequest(req);
      if (!user) return errorPage(reply, 401, 'login_required', 'Your console session ended; restart the authorization from your MCP client.');
      const b = (req.body ?? {}) as Record<string, unknown>;
      const scopes = Array.isArray(b.scope) ? b.scope.filter((x): x is string => typeof x === 'string') : typeof b.scope === 'string' ? [b.scope] : [];
      try {
        const out = await d.authorization.decide(str(b.request) ?? '', { decision: b.decision === 'approve' ? 'approve' : 'deny', scopes, ...(str(b.csrf) ? { csrf: str(b.csrf)! } : {}) }, user, (req.cookies as Record<string, string | undefined>)[d.consentCookie], { ip: req.ip, userAgent: str(req.headers['user-agent']) ?? null });
        reply.clearCookie(d.consentCookie, { path: '/oauth' });
        return reply.headers(NO_STORE).redirect(out.redirectTo, 302);
      } catch (err) {
        if (err instanceof OAuthError) return errorPage(reply, err.status, err.error, err.description);
        throw err;
      }
    });

    scope.post('/oauth/token', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const basic = parseBasic(req.headers.authorization);
      try {
        if (!(await limit(req, 'oauth_token', 120))) throw new OAuthError('slow_down', 'Too many token requests; retry shortly', 429);
        const client = await d.clients.authenticate({ clientId: str(b.client_id), basic, postSecret: str(b.client_secret) });
        const grant = str(b.grant_type);
        let out;
        if (grant === 'authorization_code') out = await d.tokens.redeemCode(client, { code: str(b.code), redirectUri: str(b.redirect_uri), codeVerifier: str(b.code_verifier), resource: str(b.resource) });
        else if (grant === 'refresh_token') out = await d.tokens.refresh(client, { refreshToken: str(b.refresh_token), resource: str(b.resource), scope: str(b.scope) });
        else throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
        return reply.headers(NO_STORE).header('access-control-allow-origin', '*').send(out);
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(reply, err, !!basic);
        throw err;
      }
    });

    scope.post('/oauth/register', async (req, reply) => {
      try {
        if (!(await limit(req, 'oauth_register', 10))) throw new OAuthError('slow_down', 'Too many registrations from this address; retry in a minute', 429);
        const body = req.body;
        if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OAuthError('invalid_client_metadata', 'Expected a JSON object');
        const out = await d.clients.register(body as Record<string, unknown>, { ip: req.ip, userAgent: str(req.headers['user-agent']) ?? null });
        return reply.status(201).headers(NO_STORE).header('access-control-allow-origin', '*').send(out);
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(reply, err);
        throw err;
      }
    });

    scope.post('/oauth/revoke', async (req, reply) => {
      const b = (req.body ?? {}) as Record<string, unknown>;
      const basic = parseBasic(req.headers.authorization);
      try {
        const client = await d.clients.authenticate({ clientId: str(b.client_id), basic, postSecret: str(b.client_secret) });
        await d.tokens.revoke(client, str(b.token));
        return reply.status(200).headers(NO_STORE).header('access-control-allow-origin', '*').send({});
      } catch (err) {
        if (err instanceof OAuthError) return oauthError(reply, err, !!basic);
        throw err;
      }
    });
  });

  if (d.upstream) {
    const up = d.upstream;
    app.get<{ Params: { environmentId: string }; Querystring: { returnTo?: string } }>('/oauth/upstream/:environmentId/connect', async (req, reply) => {
      const user = await d.sessions.userFromRequest(req);
      if (!user) return reply.headers(NO_STORE).redirect(d.sessions.loginUrl(req.url), 302);
      try {
        return reply.headers(NO_STORE).redirect(await up.authorizeUrl(req.params.environmentId, user, req.query.returnTo), 302);
      } catch (err) {
        return errorPage(reply, 400, 'connect_failed', (err as Error).message);
      }
    });
    app.get('/oauth/upstream/callback', async (req, reply) => {
      const location = await up.callback(req.query as Record<string, string | undefined>, await d.sessions.userFromRequest(req));
      return reply.headers(NO_STORE).redirect(location, 302);
    });
  }
}
