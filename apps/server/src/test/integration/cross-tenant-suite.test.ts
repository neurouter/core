/**
 * Cross-tenant suite (multi-tenancy spec §4.8, P1 acceptance). Tenants A (the default tenant) and B
 * ("beta") are built by the same seed with the **same slugs** (server `petstore`, env `mock`, an eval
 * suite with a run, inbox needs and issues, a task, a script run, an API key, an OAuth grant, an
 * invite, a job). Users: alice (A owner), bob (B owner), carol (A viewer + B admin). Tenancy comes from
 * the multi-tenant test double, so this runs without the private cloud build: on SQLite always, on
 * Postgres when NEUROUTER_TEST_PG_URL is set (CI).
 *
 * 1. Contract sweep, generated from the `api` registry: every endpoint with path ids, called as alice
 *    with B's ids, answers 404 with the body of an unknown id; list endpoints never show a B id; a
 *    coverage check fails when an endpoint has no fixture id mapping.
 * 2. Body-supplied foreign ids → 404/422 and nothing written.
 * 3. MCP (3-segment route, PRM, legacy route). 4. OAuth (consent, code exchange). 5. Events: see
 *    cross-tenant.test.ts › G4. 6. Audit chains. 7. Mock state. 8. Search. 9. Settings and model keys
 *    (also cross-tenant.test.ts › G12). 10. Rate limits. Plus memberships: per-tenant roles, invites, switching.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_ENDPOINTS, DEFAULT_TENANT_ID, buildPath, pathParamNames, type EndpointDef } from '@neurouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer } from '../../server.js';
import { hmacSha256 } from '../../kernel/lib/crypto.js';
import { newId } from '../../kernel/lib/ids.js';
import { resolveResource } from '../../controlplane/oauth/resource.js';
import { consoleOn, PETSTORE, type TestContext, type TestUser } from '../fakes/app-context.js';
import { FakeMultiTenantResolver, seedMember, seedTenant } from '../fakes/extensions.js';
import { resetPg } from '../fakes/server.js';

const PG = process.env.NEUROUTER_TEST_PG_URL;
const A = DEFAULT_TENANT_ID;
const B = '00000000-0000-7000-8000-0000000000b2';
const PEPPER = 'x'.repeat(40);
const PUBLIC = 'http://console.test';

type Kind =
  | 'server' | 'spec' | 'preview' | 'build' | 'tool' | 'overlay' | 'environment' | 'apiKey' | 'grant' | 'task' | 'call' | 'script' | 'needGroup' | 'unmetNeed'
  | 'issue' | 'suite' | 'evalTask' | 'run' | 'taskRun' | 'suggestion' | 'audit' | 'member' | 'invite' | 'job';
type Fixture = Record<Kind, string> & { keyToken: string; oauthToken: string };

/** Which fixture id a path's `:param` stands for (by the path prefix it follows). */
const KIND_BY_PATH: Array<[RegExp, Kind]> = [
  [/^\/api\/servers\/:id\b/, 'server'],
  [/^\/api\/specs\/:id\b/, 'spec'],
  [/^\/api\/spec-previews\/:id\b/, 'preview'],
  [/^\/api\/builds\/:id\b/, 'build'],
  [/^\/api\/tools\/:id\b/, 'tool'],
  [/^\/api\/overlays\/:id\b/, 'overlay'],
  [/^\/api\/environments\/:id\b/, 'environment'],
  [/^\/oauth\/upstream\/:environmentId\b/, 'environment'],
  [/^\/api\/keys\/:id\b/, 'apiKey'],
  [/^\/api\/oauth\/grants\/:id\b/, 'grant'],
  [/^\/api\/tasks\/:id\b/, 'task'],
  [/^\/api\/calls\/:auditId\b/, 'call'],
  [/^\/api\/scripts\/:id\b/, 'script'],
  [/^\/api\/inbox\/needs\/reports\/:reportId\b/, 'unmetNeed'],
  [/^\/api\/inbox\/needs\/:groupId\b/, 'needGroup'],
  [/^\/api\/inbox\/issues\/:id\b/, 'issue'],
  [/^\/api\/eval-suites\/:id\b/, 'suite'],
  [/^\/api\/eval-tasks\/:id\b/, 'evalTask'],
  [/^\/api\/eval-runs\/:id\b/, 'run'],
  [/^\/api\/suggestions\/:id\b/, 'suggestion'],
  [/^\/api\/audit\/:id\b/, 'audit'],
  [/^\/api\/members\/invites\/:id\b/, 'invite'],
  [/^\/api\/members\/:id\b/, 'member'],
  [/^\/api\/jobs\/:id\b/, 'job'],
];
/** Params that are not ids of the tenant's rows: fixed values valid in both tenants. */
const PLAIN_PARAMS: Record<string, (f: Fixture) => string> = { taskRunId: (f) => f.taskRun, toolName: () => 'add_pet', name: () => 'API_TOKEN' };

/** Endpoints whose path params don't name a tenant's row, with the reason (reviewed: adding one needs a reason). */
const EXEMPT: Record<string, string> = {
  'oauthClients.block': 'client registrations are global (spec §3.4); a block only affects the blocking tenant (cross-tenant.test.ts › G14)',
  'oauthClients.unblock': 'client registrations are global (spec §3.4); see G14',
  'modelProviders.update': 'the id is a provider name inside the tenant’s own settings',
  'modelProviders.delete': 'the id is a provider name inside the tenant’s own settings',
  'modelProviders.test': 'the id is a provider name inside the tenant’s own settings',
  'public.report': 'public page by slug; the tenant comes from the URL (tenant-less path: the legacy tenant)',
  'public.badge': 'public page by slug; the tenant comes from the URL (tenant-less path: the legacy tenant)',
};

/** Minimal valid bodies, so a request reaches the handler's tenant check instead of failing validation. */
const BODIES: Record<string, (f: Fixture) => unknown> = {
  'overlays.publish': () => ({ message: 'x' }),
  'overlays.revert': () => ({ toRev: 1 }),
  'overlays.preview': () => ({ toolName: 'add_pet' }),
  'environments.create': () => ({ slug: 'xt-env', name: 'xt', kind: 'dev', baseUrl: 'https://api.example.test' }),
  'environments.setWrites': () => ({ enabled: true, confirm: 'none' }),
  'overlays.updateDraft': () => ({ yaml: 'tools: {}' }),
  'environments.setToolWrite': () => ({ enabled: true }),
  'environments.pinBuild': (f) => ({ buildId: f.build }),
  'environments.setSecret': () => ({ value: 'secret-value' }),
  'environments.testDraft': () => ({ baseUrl: 'https://api.example.test', auth: { type: 'none' } }),
  'inbox.mergeNeedGroups': (f) => ({ intoGroupId: f.needGroup }),
  'evals.createTask': () => ({ key: 'xt-task', category: 'single', prompt: 'p' }),
  'members.update': () => ({ role: 'viewer' }),
};

/** Required query params (valid in both tenants; ids are B's, so they can't widen access either). */
const QUERIES: Record<string, (f: Fixture) => Record<string, string>> = {
  'servers.delete': () => ({ confirm: 'petstore' }),
  'environments.delete': () => ({ confirm: 'mock' }),
  'specs.diff': (f) => ({ against: f.spec }),
  'tools.diff': (f) => ({ against: f.build }),
  'tools.search': () => ({ q: 'pet' }),
  'overlays.diff': () => ({ from: '0', to: 'draft' }),
};

/** Idempotent deletes answer 204 for any id (nothing of B is touched; the response equals an unknown id's). */
const IDEMPOTENT = new Set(['specs.cancelPreview']);

const normalize = (body: string, id: string) => body.split(id).join('<id>').replace(/"requestId":"[^"]*"/g, '').replace(/"instance":"[^"]*"/g, '');

/** A stateless JSON-RPC call on an MCP route; the result object (JSON or SSE response). */
async function rpc(t: TestContext, path: string, token: string, method: string, params: Record<string, unknown> = {}) {
  const r = await t.s.app.inject({ method: 'POST', url: path, payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-method': method } });
  let json: { result?: Record<string, unknown>; error?: unknown } | null = null;
  if (r.statusCode === 200) {
    const data = r.body.startsWith('{') ? r.body : r.body.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).pop() ?? 'null';
    json = JSON.parse(data);
  }
  return { status: r.statusCode, body: r.body, headers: r.headers, json };
}

describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('cross-tenant suite (§4.8, %s)', (dialect, pgUrl) => {
  let dir: string | null = null;
  let tenancy: FakeMultiTenantResolver;
  let t: TestContext;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  const fx = {} as Record<'A' | 'B', Fixture>;
  const db = () => t.s.services.dbs.main.db;
  const as = (u: TestUser, tenant: 'default' | 'beta', opts: Parameters<TestContext['as']>[1]) => t.as(u, { ...opts, headers: { ...(opts.headers ?? {}), 'x-neurouter-tenant': tenant } });

  /** The same seed in both tenants (same slugs), as the tenant's owner. */
  async function seed(owner: TestUser, slug: 'default' | 'beta', tenantId: string): Promise<Fixture> {
    const json = async (opts: Parameters<TestContext['as']>[1], status: number) => {
      const r = await as(owner, slug, opts);
      if (r.statusCode !== status) throw new Error(`${opts.method ?? 'GET'} ${opts.url} → ${r.statusCode}: ${r.body.slice(0, 500)}`);
      return JSON.parse(r.body);
    };
    const created = await json({ method: 'POST', url: '/api/servers', payload: { slug: 'petstore', name: `Petstore ${slug}`, source: { content: await readFile(PETSTORE, 'utf8') } } }, 202);
    await t.s.services.jobs.idle();
    const server = created.server.id as string;
    const env = (await db().selectFrom('environments').select('id').where('tenant_id', '=', tenantId).where('server_id', '=', server).where('slug', '=', 'mock').executeTakeFirstOrThrow()).id;
    const build = (await db().selectFrom('builds').select('id').where('tenant_id', '=', tenantId).where('server_id', '=', server).executeTakeFirstOrThrow()).id;
    const spec = (await db().selectFrom('spec_revisions').select('id').where('tenant_id', '=', tenantId).where('server_id', '=', server).executeTakeFirstOrThrow()).id;
    const tool = (await db().selectFrom('tools').select('id').where('tenant_id', '=', tenantId).where('build_id', '=', build).where('name', '=', 'add_pet').executeTakeFirstOrThrow()).id;
    await json({ method: 'PATCH', url: `/api/servers/${server}/overlay/draft`, payload: { tools: { add_pet: { description: `Adds a pet (${slug})` } } } }, 200).catch(() => null);
    await as(owner, slug, { method: 'POST', url: `/api/servers/${server}/overlay/publish`, payload: { message: 'v1' } });
    await t.s.services.jobs.idle();
    const overlay = (await db().selectFrom('overlay_revisions').select('id').where('tenant_id', '=', tenantId).where('server_id', '=', server).executeTakeFirst())?.id;
    const preview = (await json({ method: 'POST', url: '/api/spec-previews', payload: { source: { content: await readFile(PETSTORE, 'utf8') } } }, 202).catch(async () => null))?.id as string | undefined;
    const key = await json({ method: 'POST', url: '/api/keys', payload: { name: 'ci', serverId: server, environmentId: env, scopes: ['tools:read', 'tools:write'] } }, 201);
    const now = Date.now();
    const ids = () => newId();
    const task = ids();
    await db().insertInto('tasks').values({ tenant_id: tenantId, id: task, server_id: server, environment_id: env, principal_type: 'api_key', credential_key: 'k', framing: 'explicit', status: 'open', started_at: now, last_activity_at: now }).execute();
    const needGroup = ids();
    await db().insertInto('need_groups').values({ tenant_id: tenantId, id: needGroup, server_id: server, label: `need ${slug}`, intent_norm_hash: `h-${slug}`, first_seen_at: now, last_seen_at: now }).execute();
    const unmetNeed = ids();
    await db().insertInto('unmet_needs').values({ tenant_id: tenantId, id: unmetNeed, group_id: needGroup, server_id: server, environment_id: env, credential_key: 'k', intent: `wants something (${slug})`, created_at: now }).execute();
    const issue = ids();
    await db().insertInto('issues').values({ id: issue, tenant_id: tenantId, server_id: server, environment_id: env, task_id: null, tool_name: 'add_pet', problem: `problem ${slug}`, evidence: null, related_audit_id: null, note: null, created_at: now, updated_at: now }).execute();
    const suite = ids();
    await db().insertInto('eval_suites').values({ id: suite, tenant_id: tenantId, server_id: server, version: 1, status: 'draft', created_at: now }).execute();
    const evalTask = ids();
    await db().insertInto('eval_tasks').values({ id: evalTask, tenant_id: tenantId, suite_id: suite, key: 'task-1', category: 'single', prompt: `prompt of ${slug}`, rubric: '', assertions: '[]', reference_calls: '[]', tags: '[]', enabled: 1, source: 'manual' }).execute();
    const run = ids();
    await db().insertInto('eval_runs').values({ tenant_id: tenantId, id: run, server_id: server, suite_id: suite, environment_id: env, build_id: build, status: 'succeeded', trigger: 'console', created_at: now }).execute();
    const taskRun = ids();
    await db().insertInto('eval_task_runs').values({ tenant_id: tenantId, id: taskRun, run_id: run, task_id: evalTask, model: 'stub', mode: 'tool', attempt: 1, passed: 1, created_at: now }).execute();
    const suggestion = ids();
    await db().insertInto('suggestions').values({ tenant_id: tenantId, id: suggestion, run_id: run, server_id: server, cause: 'wrong_tool', kind: 'describe', overlay_patch: '{}', created_at: now, updated_at: now }).execute();
    const script = ids();
    await db().insertInto('script_runs').values({ id: script, tenant_id: tenantId, server_id: server, environment_id: env, credential_key: 'k', code: 'print(1)', code_hash: `h-${slug}`, mode: 'execute', status: 'ok', started_at: now }).execute();
    const client = (await db().selectFrom('oauth_clients').select('id').where('client_id', '=', 'nrc_shared').executeTakeFirst())?.id ?? newId();
    await db().insertInto('oauth_clients').values({ id: client, client_id: 'nrc_shared', registration_type: 'preregistered', client_name: 'Shared client', redirect_uris: '["http://127.0.0.1/cb"]', grant_types: '["authorization_code"]', response_types: '["code"]', token_endpoint_auth_method: 'none', status: 'active', created_at: now, updated_at: now }).onConflict((oc) => oc.doNothing()).execute();
    const grant = ids();
    await db().insertInto('oauth_consents').values({ id: grant, tenant_id: tenantId, user_id: owner.id, client_id: client, environment_id: env, scopes: 'mcp:tools', redirect_uri: 'http://127.0.0.1/cb', created_at: now }).execute();
    const oauthToken = `nrk_at_${slug}${'t'.repeat(40)}`;
    const resource = `${PUBLIC}/mcp/${slug}/petstore/mock`;
    await db().insertInto('oauth_tokens').values({ id: newId(), tenant_id: tenantId, token_hash: hmacSha256(PEPPER, oauthToken), kind: 'access', client_id: client, user_id: owner.id, server_id: server, environment_id: env, scopes: 'mcp:tools mcp:write', resource, family_id: newId(), expires_at: now + 3_600_000, created_at: now }).execute();
    const invite = (await json({ method: 'POST', url: '/api/members/invites', payload: { email: `invitee-${slug}@x.test`, role: 'viewer' } }, 201)).invite.id as string;
    // a tool call through the tenant's own MCP endpoint: a call audit row and a task
    const call = await rpc(t, `/mcp/${slug}/petstore/mock`, key.token, 'tools/call', { name: 'add_pet', arguments: { name: `Pet of ${slug}`, photoUrls: [] } });
    if (call.status !== 200) throw new Error(`seed tool call → ${call.status}: ${call.body.slice(0, 300)}`);
    await t.s.services.auditStore.flush();
    const callRow = await t.s.services.dbs.audit.db.selectFrom('audit_log').select('id').where('tenant_id', '=', tenantId).where('kind', '=', 'tool_call').executeTakeFirstOrThrow();
    const auditRow = await t.s.services.dbs.audit.db.selectFrom('audit_log').select('id').where('tenant_id', '=', tenantId).where('kind', '=', 'admin_action').executeTakeFirstOrThrow();
    return {
      server, spec, preview: preview ?? newId(), build, tool, overlay: overlay ?? newId(), environment: env, apiKey: key.key.id, grant, task, call: callRow.id, script, needGroup, unmetNeed, issue, suite, evalTask, run, taskRun, suggestion,
      audit: auditRow.id, member: owner.id, invite, job: created.jobId, keyToken: key.token, oauthToken,
    };
  }

  beforeAll(async () => {
    let url: string;
    if (dialect === 'postgres') url = await resetPg(pgUrl, 'nr_it_cross_tenant');
    else {
      dir = mkdtempSync(join(tmpdir(), 'nr-xts-'));
      url = `sqlite:${join(dir, 'db.sqlite')}`;
    }
    tenancy = new FakeMultiTenantResolver(url);
    const s = await startServer({
      env: { NODE_ENV: 'test', PUBLIC_URL: PUBLIC, DATABASE_URL: url, EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'off', LOG_LEVEL: 'error', NEUROUTER_EVAL_LLM: 'stub', HASH_PEPPER: PEPPER },
      listen: false,
      jobs: false,
      loadDotenv: false,
      services: { defaultMetrics: false },
      extensions: { tenancy },
    });
    t = await consoleOn(s);
    alice = t.admin;
    await seedTenant(db(), B, 'beta', 'Beta');
    await seedMember(db(), { tenantId: B, email: 'bob@beta.test', role: 'owner', name: 'bob' });
    bob = await t.user('bob@beta.test', 'admin');
    await seedMember(db(), { tenantId: A, email: 'carol@both.test', role: 'viewer', name: 'carol' });
    await seedMember(db(), { tenantId: B, email: 'carol@both.test', role: 'admin', name: 'carol' });
    carol = await t.user('carol@both.test', 'viewer');
    fx.A = await seed(alice, 'default', A);
    fx.B = await seed(bob, 'beta', B);
  }, 120_000);

  afterAll(async () => {
    await t?.close();
    await tenancy?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('seeds the same slugs in both tenants', async () => {
    const servers = await db().selectFrom('servers').select(['tenant_id', 'slug']).where('slug', '=', 'petstore').execute();
    expect(servers.map((r) => r.tenant_id).sort()).toEqual([A, B].sort());
    for (const k of Object.keys(fx.A) as Array<keyof Fixture>) expect(fx.A[k], k).not.toBe(fx.B[k]);
  });

  /* ------------------------------------------------------------------ 1. contract sweep */

  const paramsFor = (key: string, def: EndpointDef, f: Fixture): Record<string, string> | null => {
    const names = pathParamNames(def.path);
    const out: Record<string, string> = {};
    for (const n of names) {
      const plain = PLAIN_PARAMS[n];
      if (plain) {
        out[n] = plain(f);
        continue;
      }
      const prefix = def.path.slice(0, def.path.indexOf(`:${n}`) + n.length + 1);
      const kind = KIND_BY_PATH.find(([re]) => re.test(prefix))?.[1];
      if (!kind) return null;
      out[n] = f[kind];
    }
    void key;
    return out;
  };

  it('coverage: every endpoint with path params maps to fixture ids or is exempt with a reason', () => {
    const unmapped = ALL_ENDPOINTS.filter(({ key, def }) => pathParamNames(def.path).length && !EXEMPT[key] && !paramsFor(key, def, fx.B)).map((e) => e.key);
    expect(unmapped).toEqual([]);
  });

  // before the sweep: alice's own audit trail then names B's ids she typed in URLs
  it('1. list endpoints show no B ids', async () => {
    const bIds = Object.entries(fx.B).filter(([k]) => k !== 'keyToken' && k !== 'oauthToken' && k !== 'member').map(([, v]) => v);
    const leaks: string[] = [];
    let checked = 0;
    for (const { key, def } of ALL_ENDPOINTS) {
      if (def.method !== 'GET' || pathParamNames(def.path).length || def.kind === 'sse' || def.kind === 'navigation' || def.access.includes('public')) continue;
      const r = await as(alice, 'default', { url: def.path });
      checked++;
      if (r.statusCode >= 500) leaks.push(`${key}: ${r.statusCode}`);
      for (const id of bIds) if (r.body.includes(id)) leaks.push(`${key} shows ${id}`);
      if (r.body.includes(B)) leaks.push(`${key} shows B's tenant id`);
    }
    expect(leaks).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  it('1. every id-addressed endpoint answers 404 for B’s ids, exactly like an unknown id, and writes nothing in B', async () => {
    const countB = async () => {
      const n: Record<string, number> = {};
      for (const table of ['servers', 'environments', 'api_keys', 'need_groups', 'issues', 'eval_suites', 'eval_tasks', 'eval_runs', 'suggestions', 'memberships', 'invites', 'overlay_drafts', 'secrets'] as const) {
        n[table] = Number((await db().selectFrom(table).select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', B).executeTakeFirst())?.n ?? 0);
      }
      n.invitesRevoked = Number((await db().selectFrom('invites').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', B).where('revoked_at', 'is not', null).executeTakeFirst())?.n ?? 0);
      return n;
    };
    const before = await countB();
    const problems: string[] = [];
    let checked = 0;
    for (const { key, def } of ALL_ENDPOINTS) {
      if (!pathParamNames(def.path).length || EXEMPT[key]) continue;
      const foreign = paramsFor(key, def, fx.B)!;
      const unknown = Object.fromEntries(Object.entries(foreign).map(([k, v]) => [k, PLAIN_PARAMS[k] ? v : newId()]));
      const body = BODIES[key]?.(fx.B) ?? (def.body ? {} : undefined);
      const query = QUERIES[key] ? `?${new URLSearchParams(QUERIES[key](fx.B))}` : '';
      const call = (params: Record<string, string>) => as(alice, 'default', { method: def.method, url: buildPath(def.path, params) + query, ...(body !== undefined ? { payload: body as object } : {}) });
      const rf = await call(foreign);
      const ru = await call(unknown);
      checked++;
      const idOf = (p: Record<string, string>) => Object.values(p).find((v) => !Object.values(PLAIN_PARAMS).some((f) => f(fx.B) === v)) ?? '';
      // a navigation (browser redirect / error page) and an idempotent delete may answer otherwise, but never differently from an unknown id
      const expected = IDEMPOTENT.has(key) ? 204 : def.kind === 'navigation' ? ru.statusCode : 404;
      if (rf.statusCode !== expected || (def.kind === 'navigation' && rf.statusCode < 400)) problems.push(`${key}: ${rf.statusCode} for B's id (${rf.body.slice(0, 160)})`);
      else if (ru.statusCode !== rf.statusCode || normalize(rf.body, idOf(foreign)) !== normalize(ru.body, idOf(unknown))) problems.push(`${key}: differs from an unknown id (${ru.statusCode}: ${ru.body.slice(0, 160)} vs ${rf.body.slice(0, 160)})`);
    }
    expect(problems).toEqual([]);
    expect(checked).toBeGreaterThan(70);
    expect(await countB()).toEqual(before);
  }, 60_000);

  it('1. foreign ids in query strings filter to nothing: no B row, name or id comes back', async () => {
    const field: Record<string, Kind> = { serverId: 'server', environmentId: 'environment', buildId: 'build', taskId: 'task', scriptRunId: 'script' };
    const markers = [...Object.entries(fx.B).filter(([k]) => k !== 'keyToken' && k !== 'oauthToken' && k !== 'member').map(([, v]) => v), 'Petstore beta', 'Pet of beta', '(beta)', 'prompt of beta', 'need beta', 'problem beta'];
    const leaks: string[] = [];
    let checked = 0;
    for (const { key, def } of ALL_ENDPOINTS) {
      if (def.method !== 'GET' || !def.query || def.kind === 'sse') continue;
      const shape = (def.query as unknown as { shape?: Record<string, unknown> }).shape ?? {};
      const ids = Object.keys(shape).filter((k) => field[k] || k === 'against');
      if (!ids.length) continue;
      const params = paramsFor(key, def, fx.A);
      if (!params) continue;
      for (const id of ids) {
        const q: Record<string, string> = { ...(QUERIES[key]?.(fx.A) ?? {}) };
        q[id] = id === 'against' ? (key === 'specs.diff' ? fx.B.spec : fx.B.build) : fx.B[field[id]!];
        const r = await as(alice, 'default', { url: `${buildPath(def.path, params)}?${new URLSearchParams(q)}` });
        checked++;
        if (r.statusCode >= 500) leaks.push(`${key}?${id}: ${r.statusCode}`);
        for (const m of markers) if (r.body.includes(m)) leaks.push(`${key}?${id}= shows ${m}`);
      }
    }
    expect(leaks).toEqual([]);
    expect(checked).toBeGreaterThan(20);
  });

  /* ------------------------------------------------------------------ 2. body-supplied foreign ids */

  it('2. foreign ids in request bodies → 404/422, nothing written', async () => {
    const counts = async () => ({
      runs: Number((await db().selectFrom('eval_runs').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0),
      keys: Number((await db().selectFrom('api_keys').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0),
    });
    const before = await counts();
    const cases: Array<[string, Parameters<TestContext['as']>[1]]> = [
      ['evals.createRun suiteId', { method: 'POST', url: '/api/eval-runs', payload: { serverId: fx.A.server, suiteId: fx.B.suite } }],
      ['evals.createRun buildId', { method: 'POST', url: '/api/eval-runs', payload: { serverId: fx.A.server, buildId: fx.B.build } }],
      ['evals.createRun environmentId', { method: 'POST', url: '/api/eval-runs', payload: { serverId: fx.A.server, environmentId: fx.B.environment } }],
      ['evals.createRun serverId', { method: 'POST', url: '/api/eval-runs', payload: { serverId: fx.B.server } }],
      ['keys.create serverId', { method: 'POST', url: '/api/keys', payload: { name: 'x', serverId: fx.B.server, environmentId: fx.B.environment, scopes: ['tools:read'] } }],
      ['keys.create environmentId', { method: 'POST', url: '/api/keys', payload: { name: 'x', serverId: fx.A.server, environmentId: fx.B.environment, scopes: ['tools:read'] } }],
      ['environments.pinBuild buildId', { method: 'PUT', url: `/api/environments/${fx.A.environment}/build`, payload: { buildId: fx.B.build } }],
      ['overlays.validate serverId', { method: 'POST', url: '/api/overlays/validate', payload: { serverId: fx.B.server, yaml: 'tools: {}' } }],
      ['specs.preview serverId', { method: 'POST', url: '/api/spec-previews', payload: { serverId: fx.B.server, source: { content: await readFile(PETSTORE, 'utf8') } } }],
      ['inbox.mergeNeedGroups intoGroupId', { method: 'POST', url: `/api/inbox/needs/${fx.A.needGroup}/merge`, payload: { intoGroupId: fx.B.needGroup } }],
    ];
    const bad: string[] = [];
    for (const [name, opts] of cases) {
      const r = await as(alice, 'default', opts);
      if (r.statusCode !== 404 && r.statusCode !== 422) bad.push(`${name}: ${r.statusCode} ${r.body.slice(0, 160)}`);
    }
    expect(bad).toEqual([]);
    expect(await counts()).toEqual(before);
    expect((await db().selectFrom('environments').select('build_id').where('id', '=', fx.A.environment).executeTakeFirstOrThrow()).build_id).not.toBe(fx.B.build);
  });

  /* ------------------------------------------------------------------ 3. MCP */

  it('3. MCP: the tenant’s 3-segment URL works; another tenant’s credential reads as invalid; PRM has no oracle', async () => {
    expect((await rpc(t, '/mcp/default/petstore/mock', fx.A.keyToken, 'tools/list')).json?.result).toHaveProperty('tools');
    expect((await rpc(t, '/mcp/beta/petstore/mock', fx.B.oauthToken, 'tools/list')).json?.result).toHaveProperty('tools');
    // A's key on B's URL, B's OAuth token on A's resource → 401 invalid_token (never 403/404)
    const a2b = await rpc(t, '/mcp/beta/petstore/mock', fx.A.keyToken, 'tools/list');
    expect(a2b.status).toBe(401);
    expect(a2b.body).toContain('invalid_token');
    expect(String(a2b.headers['www-authenticate'])).toContain(`resource_metadata="${PUBLIC}/.well-known/oauth-protected-resource/mcp/beta/petstore/mock"`);
    const b2a = await rpc(t, '/mcp/default/petstore/mock', fx.B.oauthToken, 'tools/list');
    expect(b2a.status).toBe(401);
    // an unknown tenant without credentials: the same 401 challenge as a known one
    const anon = (p: string) => t.s.app.inject({ method: 'POST', url: p, payload: '{}', headers: { 'content-type': 'application/json' } });
    expect((await anon('/mcp/nope/petstore/mock')).statusCode).toBe(401);
    expect((await anon('/mcp/beta/petstore/mock')).statusCode).toBe(401);
    // PRM for an unknown tenant has the same shape as for a known one
    const prm = async (p: string) => JSON.parse((await t.s.app.inject({ url: `/.well-known/oauth-protected-resource/mcp/${p}` })).body);
    const known = await prm('beta/petstore/mock');
    const unknown = await prm('nope/petstore/mock');
    expect(known.resource).toBe(`${PUBLIC}/mcp/beta/petstore/mock`);
    expect(Object.keys(unknown).sort()).toEqual(Object.keys(known).sort());
    expect({ ...unknown, resource: '' }).toEqual({ ...known, resource: '' });
  });

  it('3. MCP: the legacy 2-segment route serves the legacy tenant only', async () => {
    const svc = t.s.services;
    svc.authenticator.clearCache();
    expect((await rpc(t, '/mcp/petstore/mock', fx.A.keyToken, 'tools/list')).status).toBe(200);
    expect((await rpc(t, '/mcp/petstore/mock', fx.B.keyToken, 'tools/list')).status).toBe(401);
    // the legacy route mapped to B (cloud: NEUROUTER_LEGACY_MCP_TENANT): A's key no longer fits it
    tenancy.legacySlug = 'beta';
    try {
      svc.authenticator.clearCache();
      expect((await rpc(t, '/mcp/petstore/mock', fx.A.keyToken, 'tools/list')).status).toBe(401);
      expect((await rpc(t, '/mcp/petstore/mock', fx.B.keyToken, 'tools/list')).status).toBe(200);
    } finally {
      tenancy.legacySlug = null;
      svc.authenticator.clearCache();
    }
  });

  /* ------------------------------------------------------------------ 4. OAuth */

  it('4. OAuth: resources resolve inside their tenant; consent needs a membership; codes don’t cross tenants', async () => {
    const svc = t.s.services;
    const base = { publicUrl: PUBLIC, aliases: [], tenancy };
    expect((await resolveResource(db(), base, `${PUBLIC}/mcp/beta/petstore/mock`))?.server.id).toBe(fx.B.server);
    expect((await resolveResource(db(), base, `${PUBLIC}/mcp/default/petstore/mock`))?.server.id).toBe(fx.A.server);
    expect(await resolveResource(db(), base, `${PUBLIC}/mcp/nope/petstore/mock`)).toBeNull();
    const q = (resource: string) => ({ client_id: 'nrc_shared', redirect_uri: 'http://127.0.0.1/cb', response_type: 'code', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256', resource, scope: 'mcp:tools' });
    const user = (u: TestUser, email: string) => ({ id: u.id, email, role: 'admin' as const, csrfToken: 'x' });
    expect(await svc.authorization.authorize(q(`${PUBLIC}/mcp/beta/petstore/mock`), '/oauth/authorize', user(alice, alice.email))).toMatchObject({ kind: 'error_page', status: 403 });
    expect((await svc.authorization.authorize(q(`${PUBLIC}/mcp/beta/petstore/mock`), '/oauth/authorize', user(bob, 'bob@beta.test'))).kind).toBe('consent');
    // carol is a member of both: consent for either
    expect((await svc.authorization.authorize(q(`${PUBLIC}/mcp/default/petstore/mock`), '/oauth/authorize', user(carol, 'carol@both.test'))).kind).toBe('consent');
    // a code issued for A's resource can't be exchanged for B's
    const code = `code-${newId()}`;
    const client = (await db().selectFrom('oauth_clients').selectAll().where('client_id', '=', 'nrc_shared').executeTakeFirstOrThrow());
    const verifier = 'v'.repeat(43);
    const { createHash } = await import('node:crypto');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    await db().insertInto('oauth_codes').values({ code_hash: hmacSha256(PEPPER, code), tenant_id: A, client_id: client.id, user_id: alice.id, server_id: fx.A.server, environment_id: fx.A.environment, redirect_uri: 'http://127.0.0.1/cb', code_challenge: challenge, scopes: 'mcp:tools', resource: `${PUBLIC}/mcp/default/petstore/mock`, expires_at: Date.now() + 60_000, consumed_at: null }).execute();
    const tokensBefore = Number((await db().selectFrom('oauth_tokens').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0);
    await expect(svc.oauthTokens.redeemCode(client, { code, redirectUri: 'http://127.0.0.1/cb', codeVerifier: verifier, resource: `${PUBLIC}/mcp/beta/petstore/mock` })).rejects.toMatchObject({ error: expect.stringMatching(/^invalid_(grant|target)$/) });
    expect(Number((await db().selectFrom('oauth_tokens').select((eb) => eb.fn.countAll<number>().as('n')).executeTakeFirst())?.n ?? 0)).toBe(tokensBefore);
  });

  /* ------------------------------------------------------------------ 6. audit */

  it('6. audit: lists and exports stay in the tenant; each tenant’s chain verifies on its own', async () => {
    await t.s.services.auditStore.flush();
    const list = await as(alice, 'default', { url: '/api/audit?limit=200' });
    expect(list.body).not.toContain(fx.B.call);
    expect(await t.s.services.auditStore.verify(B, {})).toMatchObject({ ok: true });
    expect(await t.s.services.auditStore.verify(A, {}, { includeLegacy: true })).toMatchObject({ ok: true });
    const bRows = await t.s.services.dbs.audit.db.selectFrom('audit_log').select(['prev_hash', 'hash']).where('tenant_id', '=', B).orderBy('seq').execute();
    const aHashes = new Set((await t.s.services.dbs.audit.db.selectFrom('audit_log').select('hash').where('tenant_id', '=', A).execute()).map((r) => r.hash));
    // B's chain never links to one of A's rows
    for (const r of bRows) expect(aHashes.has(r.prev_hash)).toBe(false);
  });

  /* ------------------------------------------------------------------ 7. mock state */

  it('7. mock: a write through A’s mock environment is invisible in B’s environment of the same name', async () => {
    const added = await rpc(t, '/mcp/default/petstore/mock', fx.A.keyToken, 'tools/call', { name: 'add_pet', arguments: { name: 'Only-in-A', photoUrls: [] } });
    expect(added.status).toBe(200);
    const nsA = await db().selectFrom('mock_namespaces').select(['tenant_id', 'environment_id']).where('tenant_id', '=', A).execute();
    const nsB = await db().selectFrom('mock_namespaces').select(['tenant_id', 'environment_id']).where('tenant_id', '=', B).execute();
    expect(nsA.every((n) => n.environment_id === fx.A.environment)).toBe(true);
    expect(nsB.every((n) => n.environment_id === fx.B.environment)).toBe(true);
    const itemsB = await db().selectFrom('mock_items').select('body').where('tenant_id', '=', B).execute();
    expect(JSON.stringify(itemsB)).not.toContain('Only-in-A');
    const itemsA = await db().selectFrom('mock_items').select('body').where('tenant_id', '=', A).execute();
    expect(JSON.stringify(itemsA)).toContain('Only-in-A');
  });

  /* ------------------------------------------------------------------ 8. search */

  it('8. search: tool search inside A never returns B’s tools', async () => {
    const r = await as(alice, 'default', { url: '/api/tools/search?q=pet' });
    expect(r.statusCode).toBe(200);
    expect(r.body).not.toContain(fx.B.server);
    expect(r.body).not.toContain('(beta)');
    const perServer = await as(alice, 'default', { url: `/api/servers/${fx.A.server}/tools/search?q=adds%20a%20pet` });
    expect(perServer.body).not.toContain('(beta)');
  });

  /* ------------------------------------------------------------------ 9. settings and model keys */

  it('9. settings: B’s model key and settings are not visible to or used for A', async () => {
    const r = await as(bob, 'beta', { method: 'PATCH', url: '/api/settings', payload: { models: { keys: { openai: 'sk-beta-only-key-123456' } } } });
    expect([200, 422]).toContain(r.statusCode);
    const a = await as(alice, 'default', { url: '/api/settings' });
    expect(a.body).not.toContain('3456');
    expect(JSON.parse(a.body).models?.keys?.openai?.configured ?? false).toBe(false);
  });

  /* ------------------------------------------------------------------ 10. rate limits */

  it('10. rate limits: exhausting A’s key doesn’t affect B', async () => {
    const mk = async (u: TestUser, slug: 'default' | 'beta', f: Fixture) => JSON.parse((await as(u, slug, { method: 'POST', url: '/api/keys', payload: { name: 'tiny', serverId: f.server, environmentId: f.environment, scopes: ['tools:read'], rateLimit: { perMinute: 1, burst: 1 } } })).body).token as string;
    const ka = await mk(alice, 'default', fx.A);
    const kb = await mk(bob, 'beta', fx.B);
    const call = (slug: string, k: string) => rpc(t, `/mcp/${slug}/petstore/mock`, k, 'tools/call', { name: 'find_pets_by_status', arguments: { status: 'available' } });
    await call('default', ka);
    const limited = await call('default', ka);
    expect(JSON.stringify(limited.json ?? limited.body)).toMatch(/rate|limit|429/i);
    const fresh = await call('beta', kb);
    expect(fresh.status).toBe(200);
    expect(JSON.stringify(fresh.json)).not.toMatch(/rate_limited/i);
  });

  /* ------------------------------------------------------------------ memberships */

  it('roles are per membership: carol is a viewer in A and an admin in B', async () => {
    expect((await as(carol, 'default', { method: 'POST', url: '/api/keys', payload: { name: 'c', serverId: fx.A.server, environmentId: fx.A.environment, scopes: ['tools:read'] } })).statusCode).toBe(403);
    expect((await as(carol, 'beta', { method: 'POST', url: '/api/keys', payload: { name: 'c', serverId: fx.B.server, environmentId: fx.B.environment, scopes: ['tools:read'] } })).statusCode).toBe(201);
    const tenants = JSON.parse((await t.as(carol, { url: '/api/tenants' })).body).items;
    expect(tenants.map((x: { slug: string; role: string }) => `${x.slug}:${x.role}`).sort()).toEqual(['beta:admin', 'default:viewer']);
    // an organization the user isn't in: 403 no_tenant (never a silent fallback), and switching to it is 404
    const r = await as(alice, 'beta', { url: '/api/servers' });
    expect(r.statusCode).toBe(403);
    expect(r.body).toContain('no_tenant');
    expect((await t.as(alice, { method: 'POST', url: '/api/tenants/switch', payload: { slug: 'beta' } })).statusCode).toBe(404);
    // switching remembers the organization for the session (no header needed afterwards)
    const sw = await t.as(carol, { method: 'POST', url: '/api/tenants/switch', payload: { slug: 'beta' } });
    expect(JSON.parse(sw.body).tenant).toMatchObject({ slug: 'beta', role: 'admin' });
    expect(JSON.parse((await t.as(carol, { url: '/api/me' })).body).tenant).toMatchObject({ slug: 'beta' });
    await t.as(carol, { method: 'POST', url: '/api/tenants/switch', payload: { slug: 'default' } });
    expect(JSON.parse((await t.as(carol, { url: '/api/me' })).body).tenant).toMatchObject({ slug: 'default', role: 'viewer' });
    // a stale header for a foreign organization doesn't lock `me` out: it falls back to the session's organization
    const me = JSON.parse((await as(alice, 'beta', { url: '/api/me' })).body);
    expect(me.tenant).toMatchObject({ slug: 'default' });
    expect(me.tenancy).toEqual({ multi: true });
  });

  it('invites: B’s admin can’t see or revoke A’s invites; accepting needs the invited, verified email', async () => {
    const created = JSON.parse((await as(alice, 'default', { method: 'POST', url: '/api/members/invites', payload: { email: 'dave@x.test', role: 'admin' } })).body);
    const token = created.url.split('#t=')[1] as string;
    expect(created.url).toBe(`${PUBLIC}/invite#t=${token}`);
    expect((await as(carol, 'beta', { method: 'DELETE', url: `/api/members/invites/${created.invite.id}` })).statusCode).toBe(404);
    expect((await as(carol, 'beta', { url: '/api/members/invites' })).body).not.toContain('dave@x.test');
    // a viewer can't invite
    expect((await as(carol, 'default', { method: 'POST', url: '/api/members/invites', payload: { email: 'eve@x.test', role: 'viewer' } })).statusCode).toBe(403);
    // inviting an existing member → 409
    expect((await as(alice, 'default', { method: 'POST', url: '/api/members/invites', payload: { email: 'carol@both.test', role: 'admin' } })).statusCode).toBe(409);
    // dave signs in (verified identity), and so does mallory (another email)
    const dave = await t.user('dave@x.test', 'viewer');
    await db().deleteFrom('memberships').where('user_id', '=', dave.id).execute();
    const mallory = await t.user('mallory@x.test', 'viewer');
    await db().deleteFrom('memberships').where('user_id', '=', mallory.id).execute();
    for (const [u, email] of [[dave, 'dave@x.test'], [mallory, 'mallory@x.test']] as const) await db().insertInto('user_identities').values({ id: newId(), user_id: u.id, provider: 'google', subject: `sub-${email}`, email, email_verified: 1, created_at: Date.now(), last_login_at: null }).execute();
    // no membership yet: tenant-scoped endpoints answer 403 no_tenant; tenant-free ones work
    expect((await t.as(dave, { url: '/api/servers' })).body).toContain('no_tenant');
    expect(JSON.parse((await t.as(dave, { url: '/api/me' })).body)).toMatchObject({ tenant: null, tenants: [], capabilities: [] });
    const preview = JSON.parse((await t.as(dave, { method: 'POST', url: '/api/invites/preview', payload: { token } })).body);
    expect(preview).toMatchObject({ tenant: { slug: 'default' }, email: 'dave@x.test', role: 'admin', emailMatches: true, alreadyMember: false });
    const wrong = await t.as(mallory, { method: 'POST', url: '/api/invites/accept', payload: { token } });
    expect(wrong.statusCode).toBe(403);
    expect(wrong.body).toContain('invite_email_mismatch');
    expect(wrong.body).toContain('dave@x.test');
    const ok = JSON.parse((await t.as(dave, { method: 'POST', url: '/api/invites/accept', payload: { token } })).body);
    expect(ok.tenant).toMatchObject({ slug: 'default', role: 'admin' });
    expect((await t.as(dave, { url: '/api/servers' })).statusCode).toBe(200);
    // single use
    expect((await t.as(dave, { method: 'POST', url: '/api/invites/accept', payload: { token } })).statusCode).toBe(404);
    expect((await t.as(dave, { method: 'POST', url: '/api/invites/preview', payload: { token } })).statusCode).toBe(404);
    const members = JSON.parse((await as(alice, 'default', { url: '/api/members' })).body).items;
    expect(members.find((m: { email: string }) => m.email === 'dave@x.test')).toMatchObject({ role: 'admin', roleSource: 'invite' });
    // revoked and expired invites are dead too
    const rev = JSON.parse((await as(alice, 'default', { method: 'POST', url: '/api/members/invites', payload: { email: 'mallory@x.test', role: 'viewer' } })).body);
    expect((await as(alice, 'default', { method: 'DELETE', url: `/api/members/invites/${rev.invite.id}` })).statusCode).toBe(204);
    expect((await t.as(mallory, { method: 'POST', url: '/api/invites/accept', payload: { token: rev.url.split('#t=')[1] } })).statusCode).toBe(404);
    const exp = JSON.parse((await as(alice, 'default', { method: 'POST', url: '/api/members/invites', payload: { email: 'mallory@x.test', role: 'viewer' } })).body);
    await db().updateTable('invites').set({ expires_at: Date.now() - 1 }).where('id', '=', exp.invite.id).where('tenant_id', '=', A).execute();
    expect((await t.as(mallory, { method: 'POST', url: '/api/invites/accept', payload: { token: exp.url.split('#t=')[1] } })).statusCode).toBe(404);
    // every accept attempt is audited as an auth event
    await t.s.services.auditStore.flush();
    const events = await t.s.services.dbs.audit.db.selectFrom('audit_log').select(['action', 'status', 'decision_reason']).where('kind', '=', 'auth_event').where('action', '=', 'auth.invite.accept').execute();
    expect(events.map((e) => e.status).sort()).toEqual(expect.arrayContaining(['ok', 'blocked']));
  });

  it('the last owner can’t be demoted or removed', async () => {
    const r = await as(bob, 'beta', { method: 'PATCH', url: `/api/members/${bob.id}`, payload: { role: 'admin' } });
    expect(r.statusCode).toBe(409);
    expect((await as(bob, 'beta', { method: 'DELETE', url: `/api/members/${bob.id}` })).statusCode).toBe(409);
    // with a second owner, the first can step down
    expect((await as(bob, 'beta', { method: 'PATCH', url: `/api/members/${carol.id}`, payload: { role: 'owner' } })).statusCode).toBe(200);
    expect((await as(bob, 'beta', { method: 'PATCH', url: `/api/members/${bob.id}`, payload: { role: 'admin' } })).statusCode).toBe(200);
    // an admin can't manage members (owner-only)
    expect((await as(bob, 'beta', { method: 'PATCH', url: `/api/members/${carol.id}`, payload: { role: 'viewer' } })).statusCode).toBe(403);
  });
});
