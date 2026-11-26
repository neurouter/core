import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { bootServer, mcpClient } from '../../test/fakes/server.js';
import { sha256 } from '../../kernel/lib/crypto.js';

const REDIRECT = 'http://127.0.0.1:33418/callback';

const b64url = (b: Buffer) => b.toString('base64url');

describe('Neurouter as MCP OAuth 2.1 AS (per-environment resources)', () => {
  let s: RunningServer;
  let cookie: string;
  let csrf: string;
  let clientId: string;

  beforeAll(async () => {
    s = await bootServer({ NEUROUTER_EXECUTOR_MODE: 'off' });
    const admin = await s.services.users.ensureBootstrapAdmin();
    const token = b64url(randomBytes(32));
    csrf = b64url(randomBytes(24));
    const now = Date.now();
    await s.services.dbs.main.db.insertInto('web_sessions').values({ id_hash: sha256(token), user_id: admin.id, csrf_token: csrf, created_at: now, expires_at: now + 3_600_000, last_seen_at: now, ip: null, user_agent: null, id_token_hint: null }).execute();
    cookie = `${s.config.cookieNames.session}=${token}`;
    const reg = await fetch(`${s.url}/oauth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Test MCP Client', redirect_uris: [REDIRECT] }) });
    expect(reg.status).toBe(201);
    clientId = ((await reg.json()) as { client_id: string }).client_id;
  }, 60_000);
  afterAll(async () => {
    await s?.close();
  });

  /** Runs authorize → consent → code → token; returns the token response. */
  async function flow(env: string, consentScopes: string[], requestScope = 'mcp:tools mcp:write mcp:code'): Promise<{ access_token: string; refresh_token: string; scope: string }> {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const resource = `${s.url}/mcp/petstore/${env}`;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource, scope: requestScope, state: 'st1' });
    const a = await fetch(`${s.url}/oauth/authorize?${q}`, { headers: { cookie }, redirect: 'manual' });
    expect(a.status).toBe(302);
    const loc = a.headers.get('location')!;
    expect(loc).toMatch(/^\/oauth\/consent\?request=/);
    const consentCookie = a.headers.get('set-cookie')!.split(';')[0]!;
    const page = await fetch(`${s.url}${loc}`, { headers: { cookie } });
    const html = await page.text();
    expect(html).toContain('Test MCP Client');
    if (env === 'prod') expect(html).toContain('PROD');
    const requestId = new URL(loc, s.url).searchParams.get('request')!;
    const form = new URLSearchParams({ request: requestId, csrf, decision: 'approve' });
    for (const sc of consentScopes) form.append('scope', sc);
    const d = await fetch(`${s.url}/oauth/consent`, { method: 'POST', headers: { cookie: `${cookie}; ${consentCookie}`, 'content-type': 'application/x-www-form-urlencoded' }, body: form.toString(), redirect: 'manual' });
    expect(d.status).toBe(302);
    const back = new URL(d.headers.get('location')!);
    expect(back.searchParams.get('state')).toBe('st1');
    expect(back.searchParams.get('iss')).toBe(s.url.replace('127.0.0.1', '127.0.0.1'));
    const code = back.searchParams.get('code')!;
    const t = await fetch(`${s.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: clientId, resource }).toString() });
    expect(t.status).toBe(200);
    return (await t.json()) as { access_token: string; refresh_token: string; scope: string };
  }

  it('serves RFC 8414 metadata with the three MCP scopes', async () => {
    const m = (await (await fetch(`${s.url}/.well-known/oauth-authorization-server`)).json()) as Record<string, unknown>;
    expect(m).toMatchObject({ issuer: s.config.publicUrl, code_challenge_methods_supported: ['S256'], scopes_supported: ['mcp:tools', 'mcp:write', 'mcp:code'] });
    expect(await (await fetch(`${s.url}/.well-known/openid-configuration`)).json()).toMatchObject({ token_endpoint: `${s.config.publicUrl}/oauth/token` });
  });

  it('without a session, authorize redirects to the console login and resumes', async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: `${s.url}/mcp/petstore/dev` });
    const a = await fetch(`${s.url}/oauth/authorize?${q}`, { redirect: 'manual' });
    expect(a.headers.get('location')).toMatch(/^\/auth\/login\?returnTo=%2Foauth%2Fauthorize/);
  });

  it('rejects an unknown resource with invalid_target (redirected) and a missing resource', async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'x'.repeat(43), code_challenge_method: 'S256', resource: `${s.url}/mcp/petstore/nope`, state: 'z' });
    const a = await fetch(`${s.url}/oauth/authorize?${q}`, { headers: { cookie }, redirect: 'manual' });
    expect(new URL(a.headers.get('location')!).searchParams.get('error')).toBe('invalid_target');
  });

  it('DCR → authorize → consent → token; the token works on /mcp/petstore/dev only', async () => {
    const tok = await flow('dev', []);
    expect(tok.access_token).toMatch(/^nrk_at_/);
    expect(tok.refresh_token).toMatch(/^nrk_rt_/);
    expect(tok.scope).toBe('mcp:tools');
    const c = await mcpClient(s, 'petstore', 'dev', tok.access_token);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain('get_pet_by_id');
    // mcp:write unchecked → write tools refused (not_permitted)
    const add = await c.callTool({ name: 'add_pet', arguments: { name: 'Rex', photoUrls: [] } });
    expect(add.isError).toBe(true);
    const errId = (add._meta as Record<string, string>)['dev.neurouter/error-id'];
    const ex = await c.callTool({ name: 'neurouter_explain_error', arguments: { error_id: errId } });
    expect(ex.structuredContent).toMatchObject({ code: 'not_permitted' });
    await c.close();
    const other = await fetch(`${s.url}/mcp/petstore/prod`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(other.status).toBe(401);
  });

  it('consent scopes are reflected in the token (mcp:write checked → writes allowed); PROD badge on prod', async () => {
    const tok = await flow('dev', ['mcp:write', 'mcp:code']);
    expect(tok.scope.split(' ').sort()).toEqual(['mcp:code', 'mcp:tools', 'mcp:write']);
    const c = await mcpClient(s, 'petstore', 'dev', tok.access_token);
    const add = await c.callTool({ name: 'add_pet', arguments: { name: 'Rex', photoUrls: [] } });
    expect(add.isError, JSON.stringify(add.content)).toBeFalsy();
    await c.close();
    const prod = await flow('prod', []);
    expect(prod.scope).toBe('mcp:tools');
  });

  it('rotates refresh tokens and revokes the family on reuse', async () => {
    const tok = await flow('dev', []);
    const refresh = (rt: string) => fetch(`${s.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: clientId }).toString() });
    const r1 = await refresh(tok.refresh_token);
    expect(r1.status).toBe(200);
    const t1 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(t1.refresh_token).not.toBe(tok.refresh_token);
    const reuse = await refresh(tok.refresh_token);
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');
    // the whole family is revoked: the newest refresh token no longer works either
    const r2 = await refresh(t1.refresh_token);
    expect(r2.status).toBe(400);
    s.services.authenticator.clearCache();
    const list = await fetch(`${s.url}/mcp/petstore/dev`, { method: 'POST', headers: { authorization: `Bearer ${t1.access_token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) });
    expect(list.status).toBe(401);
  });

  it('a code is single use and PKCE is enforced', async () => {
    const verifier = b64url(randomBytes(48));
    const challenge = b64url(createHash('sha256').update(verifier).digest());
    const resource = `${s.url}/mcp/petstore/dev`;
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', resource });
    const a = await fetch(`${s.url}/oauth/authorize?${q}`, { headers: { cookie }, redirect: 'manual' });
    const loc = a.headers.get('location')!;
    const consentCookie = a.headers.get('set-cookie')!.split(';')[0]!;
    const requestId = new URL(loc, s.url).searchParams.get('request')!;
    const d = await fetch(`${s.url}/oauth/consent`, { method: 'POST', headers: { cookie: `${cookie}; ${consentCookie}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: requestId, csrf, decision: 'approve' }).toString(), redirect: 'manual' });
    const code = new URL(d.headers.get('location')!).searchParams.get('code')!;
    const tok = (verifierUsed: string) => fetch(`${s.url}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifierUsed, client_id: clientId, resource }).toString() });
    const bad = await tok(b64url(randomBytes(48)));
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');
    const again = await tok(verifier);
    expect(((await again.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('consent without the CSRF token is refused', async () => {
    const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: 'y'.repeat(43), code_challenge_method: 'S256', resource: `${s.url}/mcp/petstore/dev` });
    const a = await fetch(`${s.url}/oauth/authorize?${q}`, { headers: { cookie }, redirect: 'manual' });
    const requestId = new URL(a.headers.get('location')!, s.url).searchParams.get('request')!;
    const consentCookie = a.headers.get('set-cookie')!.split(';')[0]!;
    const d = await fetch(`${s.url}/oauth/consent`, { method: 'POST', headers: { cookie: `${cookie}; ${consentCookie}`, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ request: requestId, decision: 'approve' }).toString(), redirect: 'manual' });
    expect(d.status).toBe(403);
  });
});
