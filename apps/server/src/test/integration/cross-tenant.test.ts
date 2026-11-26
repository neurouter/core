/**
 * Cross-tenant regression tests for the P0 gaps (multi-tenancy spec §4.9, §13 P0 acceptance).
 * Tenant A is the default tenant (alice = its admin); tenant B ("beta", bob = its admin) is seeded
 * next to it with the **same slugs** (server `petstore`). Tenancy comes from the multi-tenant test
 * double (`test/fakes/extensions.ts`), so these run without the private cloud build.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../server.js';
import { newId } from '../../kernel/lib/ids.js';
import { resolveResource } from '../../controlplane/oauth/resource.js';
import { consoleOn, importPetstore, PETSTORE, type TestContext, type TestUser } from '../fakes/app-context.js';
import { FakeMultiTenantResolver, modelKeyPolicy, secretRefPolicy, seedTenant } from '../fakes/extensions.js';

const A = DEFAULT_TENANT_ID;
const B = '00000000-0000-7000-8000-0000000000b2';

describe('cross-tenant isolation (P0 gaps)', () => {
  let dir: string;
  let tenancy: FakeMultiTenantResolver;
  let t: TestContext;
  let alice: TestUser;
  let bob: TestUser;
  let serverA: { id: string };
  let serverB: { id: string };
  let bobJobId: string;
  const db = () => t.s.services.dbs.main.db;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nr-xt-'));
    const url = `sqlite:${join(dir, 'db.sqlite')}`;
    tenancy = new FakeMultiTenantResolver(url);
    process.env.NR_XT_UPSTREAM_TOKEN = 'xt-upstream-token';
    process.env.HASH_PEPPER_COPY_FOR_TEST = 'not-a-gateway-variable';
    const s = await startServer({
      env: { NODE_ENV: 'test', PUBLIC_URL: 'http://console.test', DATABASE_URL: url, EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'off', LOG_LEVEL: 'error', NEUROUTER_EVAL_LLM: 'stub', OPENAI_API_KEY: 'sk-server-level-key' },
      listen: false,
      jobs: false,
      loadDotenv: false,
      services: { defaultMetrics: false },
      extensions: { tenancy, secretRefs: secretRefPolicy({ denyTenants: [B] }), modelKeys: modelKeyPolicy(false) },
    });
    t = await consoleOn(s);
    alice = t.admin;
    await seedTenant(db(), B, 'beta', 'Beta');
    const bobId = newId();
    await db().insertInto('users').values({ id: bobId, tenant_id: B, email: 'bob@beta.test', name: 'bob', role: 'admin', role_source: 'local', created_at: Date.now(), updated_at: Date.now() }).execute();
    bob = await t.user('bob@beta.test', 'admin');
    serverA = await importPetstore(t);
    const { readFile } = await import('node:fs/promises');
    const out = await t.json(bob, { method: 'POST', url: '/api/servers', payload: { slug: 'petstore', name: 'Beta Petstore', source: { content: await readFile(PETSTORE, 'utf8') } } }, 202);
    serverB = out.server;
    bobJobId = out.jobId;
    await t.s.services.jobs.idle();
    await t.s.services.auditStore.flush();
  }, 60_000);

  afterAll(async () => {
    await t?.close();
    await tenancy?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the same server slug in both tenants', async () => {
    expect(serverA.id).not.toBe(serverB.id);
    const rows = await db().selectFrom('servers').select(['tenant_id', 'slug']).where('slug', '=', 'petstore').execute();
    expect(rows.map((r) => r.tenant_id).sort()).toEqual([A, B].sort());
    expect((await t.json(alice, { url: '/api/servers' }, 200)).items.map((x: { id: string }) => x.id)).toEqual([serverA.id]);
    expect(await t.as(alice, { url: `/api/servers/${serverB.id}` }).then((r) => r.statusCode)).toBe(404);
  });

  it('G15: console admin/auth audit events are filed under the actor’s tenant', async () => {
    const rows = await t.s.services.dbs.audit.db.selectFrom('audit_log').select(['tenant_id', 'user_id']).where('action', '=', 'servers.create').execute();
    expect(rows.find((r) => r.user_id === bob.id)?.tenant_id).toBe(B);
    expect(rows.find((r) => r.user_id === alice.id)?.tenant_id).toBe(A);
  });

  it('G3: audit list, get and export never return another tenant’s rows', async () => {
    const bRow = await t.s.services.dbs.audit.db.selectFrom('audit_log').select('id').where('tenant_id', '=', B).executeTakeFirstOrThrow();
    const list = await t.json(alice, { url: '/api/audit?limit=200' }, 200);
    expect(list.items.length).toBeGreaterThan(0);
    const aIds = new Set((await t.s.services.dbs.audit.db.selectFrom('audit_log').select('id').where('tenant_id', '=', A).execute()).map((r) => r.id));
    for (const it of list.items as Array<{ id: string }>) expect(aIds.has(it.id)).toBe(true);
    expect((await t.as(alice, { url: `/api/audit/${bRow.id}` })).statusCode).toBe(404);
    expect((await t.as(bob, { url: `/api/audit/${bRow.id}` })).statusCode).toBe(200);
    const exp = await t.as(alice, { url: '/api/audit/export?format=ndjson' });
    expect(exp.statusCode).toBe(200);
    expect(exp.body).not.toContain(bRow.id);
    expect(exp.body).not.toContain(B);
  });

  it('G4: the SSE stream only carries the subscriber’s tenant events', async () => {
    await t.s.app.listen({ port: 0, host: '127.0.0.1' });
    const addr = t.s.app.server.address() as { port: number };
    const ac = new AbortController();
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/events/stream?topics=inbox,tasks,evals`, { headers: { cookie: alice.cookie }, signal: ac.signal });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    let text = '';
    const pump = (async () => {
      for (;;) {
        const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
        if (done) return;
        text += new TextDecoder().decode(value);
      }
    })();
    await new Promise((r) => setTimeout(r, 100));
    const coord = t.s.services.coord;
    await coord.publish('events.task', { taskId: 'task-of-b', tenantId: B });
    await coord.publish('events.eval', { tenantId: B, runId: 'run-of-b', done: 1, total: 2 });
    await coord.publish('events.inbox', { tenantId: B });
    await coord.publish('events.inbox', {});
    await coord.publish('events.task', { taskId: 'task-of-a', tenantId: A });
    await coord.publish('events.eval', { tenantId: A, runId: 'run-of-a', done: 1, total: 2 });
    await new Promise((r) => setTimeout(r, 300));
    ac.abort();
    await pump;
    expect(text).toContain('task-of-a');
    expect(text).toContain('run-of-a');
    expect(text).not.toContain('task-of-b');
    expect(text).not.toContain('run-of-b');
    expect(text).not.toContain('tenantId');
    expect(text.match(/event: inbox\.changed/g)).toBeNull();
  });

  it('G5: settings are per tenant; instance settings are platform-only on a multi-tenant deployment', async () => {
    await t.json(bob, { method: 'PATCH', url: '/api/settings', payload: { general: { orgName: 'Beta Org' }, models: { evalModel: 'gpt-beta' } } }, 200);
    const a = await t.json(alice, { url: '/api/settings' }, 200);
    expect(a.general.orgName).not.toBe('Beta Org');
    expect(a.models.evalModel).not.toBe('gpt-beta');
    expect((await t.json(bob, { url: '/api/settings' }, 200)).general.orgName).toBe('Beta Org');
    const rows = await db().selectFrom('settings').select(['tenant_id', 'key']).where('key', '=', 'orgName').execute();
    expect(rows).toEqual([{ tenant_id: B, key: 'orgName' }]);
    const r = await t.as(bob, { method: 'PATCH', url: '/api/settings', payload: { retention: { auditDays: 1 } } });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body).reason ?? JSON.parse(r.body).extensions?.reason).toBe('instance_setting');
  });

  it('G6: an eval run with another tenant’s suite id is refused and writes nothing', async () => {
    const suiteB = newId();
    await db().insertInto('eval_suites').values({ id: suiteB, tenant_id: B, server_id: serverB.id, version: 1, status: 'frozen', created_at: Date.now() }).execute();
    await db().insertInto('eval_tasks').values({ id: newId(), tenant_id: B, suite_id: suiteB, key: 'secret-task', category: 'single', prompt: 'B’s private prompt', rubric: '', assertions: '[]', reference_calls: '[]', tags: '[]', enabled: 1, source: 'manual' }).execute();
    const before = await db().selectFrom('eval_runs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    const r = await t.as(alice, { method: 'POST', url: '/api/eval-runs', payload: { serverId: serverA.id, suiteId: suiteB } });
    expect(r.statusCode).toBe(404);
    const after = await db().selectFrom('eval_runs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst();
    expect(Number(after?.n)).toBe(Number(before?.n));
    // the service never hands out a foreign suite's prompts
    expect(await t.s.services.evals.suiteTasks(A, suiteB)).toEqual([]);
    const buildB = (await db().selectFrom('builds').select('id').where('tenant_id', '=', B).executeTakeFirstOrThrow()).id;
    expect((await t.as(alice, { method: 'POST', url: '/api/eval-runs', payload: { serverId: serverA.id, buildId: buildB } })).statusCode).toBe(404);
  });

  it('G7: users are listed and updated per tenant', async () => {
    const list = await t.json(alice, { url: '/api/users' }, 200);
    expect(list.items.map((u: { email: string }) => u.email)).not.toContain('bob@beta.test');
    expect((await t.as(alice, { method: 'PATCH', url: `/api/users/${bob.id}`, payload: { role: 'viewer' } })).statusCode).toBe(404);
    expect((await db().selectFrom('users').select('role').where('id', '=', bob.id).executeTakeFirstOrThrow()).role).toBe('admin');
  });

  it('G8: sidebar badges count only the tenant’s inbox and runs', async () => {
    const envB = (await db().selectFrom('environments').select('id').where('server_id', '=', serverB.id).executeTakeFirstOrThrow()).id;
    await db().insertInto('issues').values({ id: newId(), tenant_id: B, server_id: serverB.id, environment_id: envB, task_id: null, tool_name: 'x', problem: 'B problem', evidence: null, related_audit_id: null, note: null, created_at: Date.now(), updated_at: Date.now() }).execute();
    expect((await t.json(alice, { url: '/api/me/badges' }, 200)).inboxOpen).toBe(0);
    expect((await t.json(bob, { url: '/api/me/badges' }, 200)).inboxOpen).toBe(1);
  });

  it('G9: config export covers the tenant’s servers only', async () => {
    const r = await t.as(alice, { url: '/api/config/export' });
    expect(r.statusCode).toBe(200);
    expect(r.body).toContain('slug: petstore');
    expect(r.body).not.toContain('Beta Petstore');
    expect((await t.as(bob, { url: '/api/config/export' })).body).toContain('Beta Petstore');
  });

  it('G10: a job of another tenant reads as not found', async () => {
    expect((await t.as(alice, { url: `/api/jobs/${bobJobId}` })).statusCode).toBe(404);
    expect((await t.as(bob, { url: `/api/jobs/${bobJobId}` })).statusCode).toBe(200);
  });

  it('G16: the script "recipe" count only counts the tenant’s own runs', async () => {
    const envA = (await db().selectFrom('environments').select('id').where('server_id', '=', serverA.id).executeTakeFirstOrThrow()).id;
    const envB = (await db().selectFrom('environments').select('id').where('server_id', '=', serverB.id).executeTakeFirstOrThrow()).id;
    const run = (tenant: string, server: string, env: string) => ({ id: newId(), tenant_id: tenant, server_id: server, environment_id: env, credential_key: 'k', code: 'print(1)', code_hash: 'same-hash', mode: 'execute' as const, status: 'ok', started_at: Date.now() });
    const a = run(A, serverA.id, envA);
    await db().insertInto('script_runs').values([a, run(B, serverB.id, envB), run(B, serverB.id, envB)]).execute();
    expect((await t.json(alice, { url: `/api/scripts/${a.id}` }, 200)).recipeCount).toBe(1);
  });

  it('G14: blocking an OAuth client revokes only the blocking tenant’s tokens', async () => {
    const now = Date.now();
    const client = newId();
    await db().insertInto('oauth_clients').values({ id: client, client_id: `https://client.test/${client}`, registration_type: 'dcr', client_name: 'Shared client', redirect_uris: '["http://127.0.0.1/cb"]', grant_types: '["authorization_code"]', response_types: '["code"]', token_endpoint_auth_method: 'none', status: 'active', created_at: now, updated_at: now }).execute();
    const envA = (await db().selectFrom('environments').select('id').where('server_id', '=', serverA.id).executeTakeFirstOrThrow()).id;
    const envB = (await db().selectFrom('environments').select('id').where('server_id', '=', serverB.id).executeTakeFirstOrThrow()).id;
    const tok = (tenant: string, user: string, server: string, env: string) => ({ id: newId(), tenant_id: tenant, token_hash: Buffer.from(newId()), kind: 'access' as const, client_id: client, user_id: user, server_id: server, environment_id: env, scopes: 'mcp:tools', resource: 'x', family_id: newId(), expires_at: now + 3_600_000, created_at: now });
    const ta = tok(A, alice.id, serverA.id, envA);
    const tb = tok(B, bob.id, serverB.id, envB);
    await db().insertInto('oauth_tokens').values([ta, tb]).execute();
    await db().insertInto('oauth_consents').values([
      { id: newId(), tenant_id: A, user_id: alice.id, client_id: client, environment_id: envA, scopes: 'mcp:tools', redirect_uri: 'http://127.0.0.1/cb', created_at: now },
      { id: newId(), tenant_id: B, user_id: bob.id, client_id: client, environment_id: envB, scopes: 'mcp:tools', redirect_uri: 'http://127.0.0.1/cb', created_at: now },
    ]).execute();
    // grants and per-client token counts are per tenant
    const grants = await t.json(alice, { url: '/api/oauth/grants' }, 200);
    expect(grants.items.map((g: { user: { id: string } }) => g.user.id)).toEqual([alice.id]);
    await t.json(alice, { method: 'POST', url: `/api/oauth/clients/${client}/block` }, 200);
    const rows = await db().selectFrom('oauth_tokens').select(['id', 'revoked_at']).where('client_id', '=', client).execute();
    expect(rows.find((r) => r.id === ta.id)?.revoked_at).not.toBeNull();
    expect(rows.find((r) => r.id === tb.id)?.revoked_at).toBeNull();
    expect((await db().selectFrom('oauth_clients').select('status').where('id', '=', client).executeTakeFirstOrThrow()).status).toBe('active');
    const asB = (await t.json(bob, { url: '/api/oauth/clients' }, 200)).items.find((c: { id: string }) => c.id === client);
    expect(asB.status).toBe('active');
    const asA = (await t.json(alice, { url: '/api/oauth/clients' }, 200)).items.find((c: { id: string }) => c.id === client);
    expect(asA.status).toBe('blocked');
    // B can't unblock A's block (its own block list is empty), A can
    await t.json(alice, { method: 'POST', url: `/api/oauth/clients/${client}/unblock` }, 200);
    expect(await db().selectFrom('oauth_client_blocks').selectAll().where('client_id', '=', client).execute()).toEqual([]);
  });

  it('G17: runtime config never follows ids into another tenant', async () => {
    const rt = t.s.services.runtime;
    const envB = (await db().selectFrom('environments').select('id').where('server_id', '=', serverB.id).executeTakeFirstOrThrow()).id;
    const envA = (await db().selectFrom('environments').select('id').where('server_id', '=', serverA.id).executeTakeFirstOrThrow()).id;
    expect(await rt.getByEnvironmentId(A, envB)).toBeNull();
    const bundleA = (await rt.getByEnvironmentId(A, envA))!;
    expect(bundleA).not.toBeNull();
    const buildB = (await db().selectFrom('builds').select('id').where('tenant_id', '=', B).executeTakeFirstOrThrow()).id;
    expect(await rt.withBuild(bundleA, buildB)).toBeNull();
    expect(await rt.loadBuild(buildB, A)).toBeNull();
  });

  it('G2: OAuth resources resolve inside the URL’s tenant; consent needs a membership', async () => {
    const svc = t.s.services;
    const base = { publicUrl: 'http://console.test', aliases: [], tenancy };
    // same slug in both tenants: the legacy URL resolves inside the default tenant, never "whichever row comes first"
    expect((await resolveResource(db(), base, 'http://console.test/mcp/petstore/mock'))?.server.id).toBe(serverA.id);
    // a server that exists only in B is not reachable through the default tenant's legacy URL
    const { readFile } = await import('node:fs/promises');
    await t.json(bob, { method: 'POST', url: '/api/servers', payload: { slug: 'bonly', name: 'B only', source: { content: await readFile(PETSTORE, 'utf8') } } }, 202);
    await svc.jobs.idle();
    expect(await db().selectFrom('servers').select('id').where('slug', '=', 'bonly').where('tenant_id', '=', B).executeTakeFirst()).toBeTruthy();
    expect(await resolveResource(db(), base, 'http://console.test/mcp/bonly/mock')).toBeNull();
    // ...and the data plane answers like for an unknown server
    expect((await t.s.app.inject({ method: 'POST', url: '/mcp/bonly/mock', payload: '{}', headers: { 'content-type': 'application/json' } })).statusCode).toBe(401);
    const now = Date.now();
    const client = newId();
    await db().insertInto('oauth_clients').values({ id: client, client_id: `nrc_${client}`, registration_type: 'preregistered', client_name: 'Consent client', redirect_uris: '["http://127.0.0.1/cb"]', grant_types: '["authorization_code"]', response_types: '["code"]', token_endpoint_auth_method: 'none', status: 'active', created_at: now, updated_at: now }).execute();
    const q = { client_id: `nrc_${client}`, redirect_uri: 'http://127.0.0.1/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource: 'http://console.test/mcp/petstore/mock', scope: 'mcp:tools' };
    const asBob = await svc.authorization.authorize(q, '/oauth/authorize', { id: bob.id, email: 'bob@beta.test', role: 'admin', csrfToken: 'x' });
    expect(asBob).toMatchObject({ kind: 'error_page', status: 403, error: 'access_denied' });
    const asAlice = await svc.authorization.authorize(q, '/oauth/authorize', { id: alice.id, email: alice.email, role: 'admin', csrfToken: 'x' });
    expect(asAlice.kind).toBe('consent');
  });

  it('G12: env: references — write-time 422, resolve-time refusal, no presence oracle', async () => {
    const create = (u: TestUser, server: string, slug: string, ref: string) => t.as(u, { method: 'POST', url: `/api/servers/${server}/environments`, payload: { slug, name: slug, kind: 'dev', baseUrl: 'https://api.example.test', auth: { type: 'bearer', secretRef: ref } } });
    // gateway-internal variables are refused for every tenant
    for (const ref of ['env:DATABASE_URL', 'env:NEUROUTER_MASTER_KEYS', 'env:HASH_PEPPER', 'env:OPENAI_API_KEY', 'env:OIDC_CLIENT_SECRET']) {
      const r = await create(alice, serverA.id, `x-${ref.slice(4).toLowerCase().replace(/_/g, '-').slice(0, 20)}`, ref);
      expect(r.statusCode, ref).toBe(422);
      expect(r.body).toContain('unsupported_ref');
    }
    // a normal variable is fine where the policy allows env refs (A) and refused where it doesn't (B)
    expect((await create(alice, serverA.id, 'dev-env-ok', 'env:NR_XT_UPSTREAM_TOKEN')).statusCode).toBe(201);
    const rb = await create(bob, serverB.id, 'dev-env-no', 'env:NR_XT_UPSTREAM_TOKEN');
    expect(rb.statusCode).toBe(422);
    expect(rb.body).toContain('unsupported_ref');
    // resolve time: refs written before the policy (or by neurouter.yaml) read as missing
    const creds = t.s.services.credentials;
    const ctx = (tenantId: string) => ({ tenantId, environmentId: 'e', userId: null, publicUrl: 'http://console.test' });
    expect(await creds.resolve({ type: 'bearer', secret: 'env:NR_XT_UPSTREAM_TOKEN' }, ctx(A))).toMatchObject({ ok: true, headers: { authorization: 'Bearer xt-upstream-token' } });
    expect(await creds.resolve({ type: 'bearer', secret: 'env:NR_XT_UPSTREAM_TOKEN' }, ctx(B))).toMatchObject({ ok: false, code: 'credential_missing' });
    process.env.HASH_PEPPER = process.env.HASH_PEPPER ?? 'p'.repeat(40);
    expect(await creds.resolve({ type: 'bearer', secret: 'env:HASH_PEPPER' }, ctx(A))).toMatchObject({ ok: false, code: 'credential_missing' });
    expect(await creds.presence({ type: 'bearer', secret: 'env:HASH_PEPPER' }, 'e', A)).toBe('missing');
    // the environment view doesn't reveal whether an internal variable exists
    const envA = (await db().selectFrom('environments').selectAll().where('server_id', '=', serverA.id).where('slug', '=', 'dev-env-ok').executeTakeFirstOrThrow());
    await db().updateTable('environments').set({ auth: JSON.stringify({ type: 'bearer', secret: 'env:HASH_PEPPER' }) }).where('id', '=', envA.id).execute();
    const view = await t.json(alice, { url: `/api/environments/${envA.id}` }, 200);
    expect(view.auth.hasSecret).toBe(false);
  });

  it('G12 / §8.8: server-level LLM keys are not used when the ModelKeyPolicy forbids them', async () => {
    // OPENAI_API_KEY is set on this server, but the policy is `allowEnvKeys: false`
    const providers = await t.json(alice, { url: '/api/settings/model-providers' }, 200);
    expect(providers.items.filter((p: { keySource: string }) => p.keySource === 'env')).toEqual([]);
    expect((await t.json(alice, { url: '/api/settings' }, 200)).models.keys.openai.configured).toBe(false);
  });
});
