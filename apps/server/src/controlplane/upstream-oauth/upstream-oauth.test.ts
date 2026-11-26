import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { createHash, randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { AuditStore } from '../../kernel/audit/store.js';
import { MemoryCoordination } from '../../kernel/coordination/memory.js';
import type { Databases } from '../../kernel/db/index.js';
import { EnvelopeService } from '../../kernel/secrets/envelope.service.js';
import { EnvKeyring } from '../../kernel/secrets/keyring.js';
import { FakeClock } from '../../test/fakes/context.js';
import { createTestDatabases } from '../../test/fakes/test-db.js';
import { UpstreamOAuthService } from './upstream-oauth.service.js';

const AS = 'https://auth.api.test';

describe('upstream OAuth broker (oauth_passthrough, §13.5)', () => {
  let dbs: Databases;
  let clock: FakeClock;
  let svc: UpstreamOAuthService;
  let tokenCalls: Array<Record<string, string>>;
  let nextExpiresIn: number;

  beforeEach(async () => {
    dbs = await createTestDatabases();
    clock = new FakeClock(Date.now());
    tokenCalls = [];
    nextExpiresIn = 30;
    const db = dbs.main.db;
    const now = clock.now();
    await db.insertInto('users').values({ id: 'u1', tenant_id: DEFAULT_TENANT_ID, email: 'a@x.test', created_at: now, updated_at: now }).execute();
    await db.insertInto('users').values({ id: 'u2', tenant_id: DEFAULT_TENANT_ID, email: 'b@x.test', created_at: now, updated_at: now }).execute();
    await db.insertInto('servers').values({ id: 's1', tenant_id: DEFAULT_TENANT_ID, slug: 'api', name: 'API', kind: 'openapi', created_at: now, updated_at: now }).execute();
    await db
      .insertInto('environments')
      .values({ id: 'e1', tenant_id: DEFAULT_TENANT_ID, server_id: 's1', slug: 'prod', name: 'Prod', kind: 'prod', base_url: 'https://api.test', auth: JSON.stringify({ type: 'oauth_passthrough', authorizationUrl: `${AS}/authorize`, tokenUrl: `${AS}/token`, clientId: 'nr-client', clientSecret: 'env:TEST_UPSTREAM_SECRET', scopes: ['repo'] }), created_at: now, updated_at: now })
      .execute();
    const keyring = new EnvKeyring(new Map([['k1', randomBytes(32)]]), 'k1');
    const envelope = new EnvelopeService(db, keyring, clock);
    const store = { record: () => true, canAccept: () => true } as unknown as AuditStore;
    let n = 0;
    svc = new UpstreamOAuthService({
      db,
      clock,
      envelope,
      coord: new MemoryCoordination(clock),
      audit: new AuditRecorder(store, clock, { debug: () => {}, warn: () => {} }),
      secrets: async (ref) => (ref === 'env:TEST_UPSTREAM_SECRET' ? 'shh' : null),
      fetch: () => async (url, init) => {
        expect(String(url)).toBe(`${AS}/token`);
        const body = Object.fromEntries(new URLSearchParams(String(init?.body)));
        tokenCalls.push(body);
        if (body.grant_type === 'refresh_token' && body.refresh_token === 'bad') return new Response(JSON.stringify({ error: 'invalid_grant' }), { status: 400 });
        n++;
        return new Response(JSON.stringify({ access_token: `at-${n}`, refresh_token: `rt-${n}`, expires_in: nextExpiresIn, token_type: 'Bearer' }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      publicUrl: 'https://nr.test',
      pepper: 'p'.repeat(40),
      isMember: async () => true,
      log: { warn: () => {}, info: () => {} },
    });
  });
  afterEach(async () => {
    await dbs.close();
  });

  async function connect(userId = 'u1'): Promise<string> {
    const url = new URL(await svc.authorizeUrl('e1', { id: userId }, '/servers/s1'));
    expect(url.origin + url.pathname).toBe(`${AS}/authorize`);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('redirect_uri')).toBe('https://nr.test/oauth/upstream/callback');
    expect(url.searchParams.get('scope')).toBe('repo');
    return url.searchParams.get('state')!;
  }

  it('connects with PKCE, stores tokens encrypted, and hands them to the data plane', async () => {
    nextExpiresIn = 3600;
    const state = await connect();
    const where = await svc.callback({ state, code: 'c1' }, { id: 'u1' });
    expect(where).toBe('/servers/s1?connected=e1');
    const ex = tokenCalls[0]!;
    expect(ex).toMatchObject({ grant_type: 'authorization_code', code: 'c1', client_id: 'nr-client', client_secret: 'shh' });
    // the verifier sent matches the challenge sent at authorize time (checked indirectly by its shape)
    expect(ex.code_verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
    const row = await dbs.main.db.selectFrom('upstream_tokens').selectAll().executeTakeFirstOrThrow();
    expect(row.access_ciphertext.toString('utf8')).not.toContain('at-1');
    expect(await svc.token(DEFAULT_TENANT_ID, 'e1', 'u1')).toBe('at-1');
    expect(await svc.token(DEFAULT_TENANT_ID, 'e1', 'u2')).toBeNull();
  });

  it('PKCE: the challenge equals S256(verifier) used at the token endpoint', async () => {
    const url = new URL(await svc.authorizeUrl('e1', { id: 'u1' }, undefined));
    await svc.callback({ state: url.searchParams.get('state')!, code: 'c' }, { id: 'u1' });
    const v = tokenCalls[0]!.code_verifier!;
    expect(createHash('sha256').update(v).digest('base64url')).toBe(url.searchParams.get('code_challenge'));
  });

  it('refreshes on use when the token is about to expire, keeping the latest refresh token', async () => {
    const state = await connect();
    await svc.callback({ state, code: 'c1' }, { id: 'u1' });
    nextExpiresIn = 3600;
    expect(await svc.token(DEFAULT_TENANT_ID, 'e1', 'u1')).toBe('at-2');
    expect(tokenCalls[1]).toMatchObject({ grant_type: 'refresh_token', refresh_token: 'rt-1' });
    expect(await svc.token(DEFAULT_TENANT_ID, 'e1', 'u1')).toBe('at-2');
    expect(tokenCalls).toHaveLength(2);
  });

  it('rejects a callback from another user, an unknown state, and a reused state', async () => {
    const state = await connect();
    expect(await svc.callback({ state, code: 'c' }, { id: 'u2' })).toContain('error=session_mismatch');
    expect(await svc.callback({ state, code: 'c' }, { id: 'u1' })).toContain('error=invalid_state');
    expect(await svc.callback({ state: 'nope', code: 'c' }, { id: 'u1' })).toContain('error=invalid_state');
    expect(tokenCalls).toHaveLength(0);
  });

  it('marks the connection refresh_failed on invalid_grant (user must reconnect)', async () => {
    const state = await connect();
    await svc.callback({ state, code: 'c1' }, { id: 'u1' });
    // swap the stored refresh token for one the AS rejects
    const row = await dbs.main.db.selectFrom('upstream_tokens').selectAll().executeTakeFirstOrThrow();
    await svc.save(row.tenant_id, 'e1', 'u1', { access_token: 'at-x', refresh_token: 'bad', expires_in: 10 }, null);
    expect(await svc.token(DEFAULT_TENANT_ID, 'e1', 'u1')).toBe('at-x');
    clock.advance(20_000);
    expect(await svc.token(DEFAULT_TENANT_ID, 'e1', 'u1')).toBeNull();
    expect((await dbs.main.db.selectFrom('upstream_tokens').select('status').executeTakeFirstOrThrow()).status).toBe('refresh_failed');
  });

  it('refuses environments that are not oauth_passthrough', async () => {
    await dbs.main.db.updateTable('environments').set({ auth: JSON.stringify({ type: 'none' }) }).execute();
    await expect(svc.authorizeUrl('e1', { id: 'u1' }, undefined)).rejects.toThrow(/per-user OAuth/);
  });
});
