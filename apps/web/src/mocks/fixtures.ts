/**
 * Endpoint fixtures over the in-memory mock db: one resolver per `@neurouter/shared` endpoint key.
 * `createContractHandlers` validates every value against the endpoint's response schema, so the
 * mocks cannot drift from the contract.
 */
import { HttpResponse } from 'msw';
import {
  LLM_PROVIDER_KINDS, Me, PROBLEM_CONTENT_TYPE, PROVIDER_ENV_KEYS, PROVIDER_LABELS, PROVIDER_MODELS, capabilitiesFor, providerForModel, problemType, readinessBand, type Badges, type EnvironmentDetail, type EvalRunRow, type OverlayDraft, type OverlayPatchOp, type ReadinessComponent,
  type SpecPreview, type UpstreamAuthIn, type UpstreamAuthOut,
} from '@neurouter/shared';
import {
  DAY, HOUR, MIN, auditRows, buildRow, createDb, draftChanges, effectiveEntry, entryYaml, generateTask, keyOf, matrixFrom, overlayYaml, parseToolId, readinessFor, serverDetail, serverRow, shapingPreview,
  taskDetail, taskResults, tickRun, tokens, toolDetail, toolId, toolName, toolRow, toolVisible, visibleCount, type Entry, type MockDb, type RunState, type ServerState, type SuggestionState,
} from './db';
import { ACME_BASELINE_BREAKDOWN, ACME_BREAKDOWN, ACME_LINT, BLUEFIN_LINT, EVAL_TASK_PROMPTS, INSTANCE, MODELS, PEOPLE, iso, type RUNS, type ToolSeed } from './demo-data';

type Ctx = { request: Request; params: Record<string, string | readonly string[] | undefined> };
export type Resolver = (ctx: Ctx) => unknown | Response | Promise<unknown | Response>;
export type ContractFixtures = Partial<Record<string, Resolver | object | null>>;

export function problem(status: number, code: string, title: string, detail: string, ext: Record<string, unknown> = {}): Response {
  return HttpResponse.json({ type: problemType(code), title, status, code, detail, requestId: `req_mock_${code}`, ...ext }, { status, headers: { 'content-type': PROBLEM_CONTENT_TYPE } });
}
const notFound = (what: string) => problem(404, 'not_found', 'Not found', `${what} not found`);

const p = (ctx: Ctx, k: string) => String(ctx.params[k] ?? '');
const q = (ctx: Ctx) => new URL(ctx.request.url).searchParams;
async function body<T>(ctx: Ctx): Promise<T> {
  try {
    return (await ctx.request.clone().json()) as T;
  } catch {
    return {} as T;
  }
}

/** Offset cursor pagination over an array. */
function page<T>(items: T[], ctx: Ctx, def = 50) {
  const sp = q(ctx);
  const limit = Math.min(200, Number(sp.get('limit') ?? def) || def);
  const offset = Number(sp.get('cursor') ?? 0) || 0;
  return { items: items.slice(offset, offset + limit), nextCursor: offset + limit < items.length ? String(offset + limit) : null, totalEstimate: items.length };
}

/* ================================================================== people */

export type PersonKey = 'admin' | 'admin2' | 'viewer';
const PERSON = { admin: PEOPLE.maya, admin2: PEOPLE.jon, viewer: PEOPLE.priya };

export function meFixture(who: PersonKey = 'admin', patch: { demoReadOnly?: boolean; badges?: Partial<Badges>; features?: Partial<Me['features']> } = {}): Me {
  const person = PERSON[who];
  return Me.parse({
    user: { id: person.id, email: person.email, name: person.name, role: person.role, anonymous: false },
    capabilities: capabilitiesFor(person.role),
    csrfToken: 'csrf-test-token',
    features: { codeMode: true, embeddings: 'ready', evals: true, oauthBroker: true, externalAs: false, events: false, configMode: 'hybrid', ...patch.features },
    badges: { inboxOpen: 6, evalsRunning: 0, ...patch.badges },
    instance: { name: INSTANCE.name, version: INSTANCE.version, demoReadOnly: patch.demoReadOnly ?? false },
  });
}

/* ================================================================== overlay draft */

/** Finds the seed tool for an overlay selector (`operationId:x`, `"GET /p"`, `graphql:Query.f`). */
function toolBySelector(s: ServerState, selector: string): ToolSeed | undefined {
  return s.tools.find((t) => keyOf(t) === selector || `${t.method} ${t.path}` === selector || t.orig === selector);
}

export function applyOps(s: ServerState, ops: OverlayPatchOp[]): Response | null {
  for (const op of ops) {
    if (op.op !== 'set' && op.op !== 'unset') continue;
    const seed = toolBySelector(s, op.selector);
    if (!seed) return problem(422, 'overlay_invalid', 'Invalid overlay', `No tool matches selector ${op.selector}`, { diagnostics: [{ severity: 'error', code: 'unknown_selector', message: `No tool matches ${op.selector}` }] });
    const key = keyOf(seed);
    const d: Entry = { ...(s.draft[key] ?? {}) };
    if (op.op === 'unset') {
      delete (d as Record<string, unknown>)[op.field];
    } else if (op.field === 'name') {
      const name = String(op.value);
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(name)) return problem(422, 'validation_failed', 'Validation failed', 'Use snake_case: lowercase letters, digits and underscores.', { errors: [{ path: ['name'], message: 'Use snake_case: lowercase letters, digits and underscores', code: 'invalid_string' }] });
      const clash = s.tools.find((t) => t !== seed && toolName(s, t, true) === name);
      if (clash) return problem(422, 'overlay_invalid', 'Invalid overlay', `${name} is already used by another tool.`, { errors: [{ path: ['name'], message: `${name} is already used by another tool`, code: 'name_collision' }] });
      d.name = name;
    } else if (op.field === 'response') {
      d.response = { ...(d.response ?? {}), ...(op.value as object) };
    } else {
      (d as Record<string, unknown>)[op.field] = op.value;
    }
    // drop fields equal to the published value (a draft holds differences only)
    const pub = s.published[key] ?? {};
    const baseOf = (k: keyof Entry) => (k === 'name' ? (pub.name ?? seed.name) : k === 'description' ? (pub.description ?? seed.description) : k === 'hidden' ? (pub.hidden ?? !!seed.hidden) : k === 'pinned' ? (pub.pinned ?? !!seed.pinned) : pub[k]);
    for (const k of Object.keys(d) as (keyof Entry)[]) if (k !== 'response' && JSON.stringify(d[k]) === JSON.stringify(baseOf(k))) delete d[k];
    if (d.response) {
      const pr = pub.response ?? {};
      for (const k of Object.keys(d.response) as (keyof NonNullable<Entry['response']>)[]) if (JSON.stringify(d.response[k]) === JSON.stringify(pr[k])) delete d.response[k];
      if (!Object.keys(d.response).length) delete d.response;
    }
    if (Object.keys(d).length) s.draft[key] = d;
    else delete s.draft[key];
  }
  s.draftRev++;
  s.draftUpdatedAt = Date.now();
  return null;
}

export function draftOf(s: ServerState): OverlayDraft {
  const changes = draftChanges(s);
  return {
    yaml: overlayYaml(s, true),
    basedOnRev: s.versions[0]?.rev ?? null,
    changeCount: changes.length,
    changes,
    etag: `W/"${s.seed.id}-${s.draftRev}"`,
    validation: { ok: true, diagnostics: [] },
    preview: { toolCount: s.tools.length, visibleCount: visibleCount(s, true), lintScore: 76 },
    fileManaged: false,
    updatedAt: changes.length ? iso(s.draftUpdatedAt) : null,
    updatedBy: changes.length ? { id: PEOPLE.maya.id, name: PEOPLE.maya.name } : null,
  };
}

function publish(s: ServerState, message: string, pinTo?: string[], source: 'console' | 'revert' | 'suggestion' = 'console') {
  const changed = new Set(draftChanges(s).map((c) => c.target));
  for (const [k, d] of Object.entries(s.draft)) s.published[k] = { ...(s.published[k] ?? {}), ...d, ...(d.response || s.published[k]?.response ? { response: { ...(s.published[k]?.response ?? {}), ...(d.response ?? {}) } } : {}) };
  s.draft = {};
  s.draftRev++;
  const rev = (s.versions[0]?.rev ?? 0) + 1;
  const row = { id: `ovl_${s.seed.slug}_${rev}`, rev, hash: `h${rev}${Date.now().toString(16).slice(-6)}`, message, source, basedOnRev: rev - 1 || null, createdBy: { id: PEOPLE.maya.id, name: PEOPLE.maya.name }, createdAt: iso(Date.now()), toolChanges: changed.size };
  s.versions.unshift({ ...row, yaml: overlayYaml(s, false) });
  const pins = pinTo ?? s.envs.filter((e) => e.kind !== 'prod').map((e) => e.id);
  const build = buildRow(s, rev, []);
  for (const e of s.envs) {
    if (!pins.includes(e.id)) continue;
    e.buildId = build.id;
    e.build = { ...build, environments: [e.slug] };
  }
  const pinned = s.envs.filter((e) => pins.includes(e.id));
  return { revision: row, build: { ...build, environments: pinned.map((e) => e.slug) }, pinnedEnvironments: pinned.map((e) => ({ id: e.id, slug: e.slug })) };
}

/* ================================================================== spec previews (wizard) */

const STAGES = ['fetch', 'parse', 'validate', 'normalize', 'generate'] as const;
const STAGE_MS = 280;

function emptyPreview(id: string): SpecPreview {
  return {
    id, status: 'compiling', stages: STAGES.map((name) => ({ name, status: 'pending', durationMs: null })), kind: null, format: null, title: null, suggestedSlug: null, name: null, slug: null, operationCount: 0,
    counts: { tools: 0, writeTools: 0, hiddenByDefault: 0 }, diagnostics: [], tools: [], lint: null, preliminaryScore: null, overlayDraftYaml: 'overlay: 1\ntools: {}\n', diff: null, expiresAt: iso(Date.now() + DAY),
  };
}

function previewFromAcme(id: string): SpecPreview {
  const acme = createDb().servers[0]!;
  return {
    ...emptyPreview(id), kind: 'openapi', format: 'openapi-3.1', title: 'Acme Orders API', suggestedSlug: 'acme-orders', name: 'Acme Orders API', slug: 'acme-orders', operationCount: 46, counts: { tools: 46, writeTools: 9, hiddenByDefault: 15 },
    diagnostics: [
      { severity: 'warning', code: 'missing_description', message: '17 operations have no description', pointer: '/paths/~1v2~1orders~1{id}~1cancel/post', excerpt: '  /v2/orders/{id}/cancel:\n    post:\n      operationId: cancelOrder\n      responses: …' },
      { severity: 'warning', code: 'missing_example', message: '`POST /v2/refunds` has no example', pointer: '/paths/~1v2~1refunds/post/requestBody', excerpt: '  /v2/refunds:\n    post:\n      operationId: postRefund\n      requestBody: { $ref: "#/components/requestBodies/Refund" }' },
      { severity: 'info', code: 'generated_name', message: '`operationId` missing on 4 operations, names were generated', pointer: '/paths/~1v2~1warehouses/get' },
    ],
    tools: acme.tools.map((t) => ({ name: t.name, title: t.orig, method: t.method ?? null, path: t.path ?? null, field: t.field ?? null, write: !!t.write, hidden: !!t.hidden, descriptionQuality: t.quality, suggestedHide: t.suggestHide ? [t.suggestHide] : [] })),
    lint: ACME_LINT, preliminaryScore: 48,
  };
}

/** Minimal "compiler" for pasted or uploaded specs: counts operations in OpenAPI YAML or GraphQL SDL. */
function previewFromContent(id: string, content: string, filename?: string): SpecPreview | Response {
  const text = content.trim();
  if (/^\s*["']?swagger["']?\s*:\s*["']?2/m.test(text)) return problem(422, 'spec_unsupported', 'Unsupported spec', 'Swagger 2.0 is not supported. Convert it to OpenAPI 3.x first (for example with swagger2openapi), then import it again.');
  const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').replace(/[^a-zA-Z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();
  if (/(^|\n)\s*(type\s+(Query|Mutation)|schema\s*\{)/.test(text) || /\.(graphql|gql)$/.test(filename ?? '')) {
    const block = (name: string) => text.match(new RegExp(`type\\s+${name}\\s*\\{([\\s\\S]*?)\\}`))?.[1] ?? '';
    const fields = (name: string) => [...block(name).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*[(:]/gm)].map((m) => m[1]!);
    const queries = fields('Query');
    const mutations = fields('Mutation');
    if (!queries.length && !mutations.length) return problem(422, 'spec_invalid', 'Invalid spec', 'The schema defines no Query or Mutation fields.', { diagnostics: [{ severity: 'error', code: 'no_operations', message: 'No Query or Mutation fields' }] });
    const tools = [...queries.map((f) => ({ f, w: false, t: 'Query' })), ...mutations.map((f) => ({ f, w: true, t: 'Mutation' }))].map(({ f, w, t }) => ({
      name: snake(f), title: f, method: null, path: null, field: `${t}.${f}`, write: w, hidden: false, descriptionQuality: 'none' as const, suggestedHide: [],
    }));
    const title = filename?.replace(/\.(graphql|gql)$/, '') ?? 'GraphQL API';
    return finish(id, 'graphql', 'graphql-sdl', title, tools);
  }
  if (!/^\s*["']?openapi["']?\s*:\s*["']?3/m.test(text)) return problem(422, 'spec_invalid', 'Invalid spec', 'This does not look like an OpenAPI 3.x or GraphQL SDL document.', { diagnostics: [{ severity: 'error', code: 'not_a_spec', message: 'Missing `openapi: 3.x` or GraphQL type definitions' }] });
  const format = /openapi["']?\s*:\s*["']?3\.0/.test(text) ? 'openapi-3.0' : 'openapi-3.1';
  const title = text.match(/title["']?\s*:\s*["']?([^"'\n,}]+)/)?.[1]?.trim() ?? 'Imported API';
  const ops: { method: string; path: string; opId: string | null }[] = [];
  let currentPath = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const pm = l.match(/^\s{2}["']?(\/[^"':]*)["']?\s*:/);
    if (pm) currentPath = pm[1]!;
    const mm = l.match(/^\s{4}(get|post|put|patch|delete)\s*:/);
    if (mm && currentPath) ops.push({ method: mm[1]!.toUpperCase(), path: currentPath, opId: lines.slice(i + 1, i + 6).join('\n').match(/operationId\s*:\s*["']?([A-Za-z0-9_]+)/)?.[1] ?? null });
  }
  if (!ops.length) return problem(422, 'spec_invalid', 'Invalid spec', 'The spec has no operations under `paths`.', { diagnostics: [{ severity: 'error', code: 'no_operations', message: 'No operations under paths', pointer: '/paths' }] });
  const tools = ops.map((o) => ({
    name: snake(o.opId ?? `${o.method.toLowerCase()} ${o.path.replace(/[{}]/g, '')}`), title: o.opId ?? `${o.method} ${o.path}`, method: o.method, path: o.path, field: null, write: o.method !== 'GET', hidden: false,
    descriptionQuality: 'none' as const, suggestedHide: /\/admin\//.test(o.path) ? ['admin-only path'] : [],
  }));
  return finish(id, 'openapi', format, title, tools);
}

function finish(id: string, kind: 'openapi' | 'graphql', format: SpecPreview['format'], title: string, tools: SpecPreview['tools']): SpecPreview {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'my-api';
  return {
    ...emptyPreview(id), kind, format, title, suggestedSlug: slug.length >= 3 ? slug : `${slug}-api`, name: title, slug: slug.length >= 3 ? slug : `${slug}-api`, operationCount: tools.length,
    counts: { tools: tools.length, writeTools: tools.filter((t) => t.write).length, hiddenByDefault: 0 },
    diagnostics: [{ severity: 'warning', code: 'missing_description', message: `${tools.length} operations have no description`, ...(kind === 'openapi' ? { pointer: '/paths' } : {}) }],
    tools, lint: { ...BLUEFIN_LINT, score: 35 }, preliminaryScore: 35,
  };
}

function previewState(db: MockDb, id: string): SpecPreview | null {
  const entry = db.previews.get(id);
  if (!entry) return null;
  const elapsed = db.speed === 0 ? Infinity : (Date.now() - entry.createdMs) / db.speed;
  const done = Math.floor(elapsed / STAGE_MS);
  const pv = entry.preview;
  pv.stages = STAGES.map((name, i) => ({ name, status: i < done ? 'ok' : i === done ? 'running' : 'pending', durationMs: i < done ? STAGE_MS - 40 + i * 13 : null }));
  pv.status = done >= STAGES.length ? 'ready' : 'compiling';
  const selectorOf = (t: SpecPreview['tools'][number]) => (t.field ? `graphql:${t.field}` : `${t.method} ${t.path}`);
  const tools = pv.tools.map((t) => {
    const d = entry.draftOps[selectorOf(t)];
    return { ...t, name: d?.name ?? t.name, hidden: d?.hidden ?? t.hidden };
  });
  const ops = Object.entries(entry.draftOps);
  return {
    ...pv, tools, counts: { ...pv.counts, hiddenByDefault: tools.filter((t) => t.hidden).length },
    overlayDraftYaml: ops.length ? ['overlay: 1', 'tools:', ...ops.flatMap(([k, e]) => entryYaml(k, e))].join('\n') + '\n' : pv.overlayDraftYaml,
  };
}

/* ================================================================== auth in / out */

function toAuthOut(a: UpstreamAuthIn): UpstreamAuthOut {
  const secret = { hasSecret: false, secretUpdatedAt: null };
  if (a.type === 'oauth_passthrough') return { ...a, scopes: a.scopes ?? [], mode: a.mode ?? 'broker', connected: false, connectUrl: null, ...secret };
  if (a.type === 'oauth_client_credentials') return { ...a, scopes: a.scopes ?? [], ...secret };
  return { ...a, ...secret } as UpstreamAuthOut;
}

/* ================================================================== suggestions / runs */

function tickSuggestions(db: MockDb) {
  for (const sg of db.suggestions) {
    if (sg.status !== 'verifying' || !sg.verifyStartedMs) continue;
    if (db.speed === 0 || Date.now() - sg.verifyStartedMs > 3000 * db.speed) {
      sg.status = 'verified';
      sg.verifiedDelta = sg.kind === 'hide' ? 3 : sg.kind === 'example' ? 5 : (sg.predictedDelta || 2);
      sg.updatedAt = iso(Date.now());
    }
  }
}
const stripSug = ({ verifyStartedMs: _v, title: _t, ops: _o, ...s }: SuggestionState) => s;

/** One provider per kind with a key, like the server (`<kind>-env` | `<kind>-stored`). */
function mockProviders(db: MockDb) {
  const defaultKind = providerForModel(db.settings.evalModel);
  return LLM_PROVIDER_KINDS.filter((k) => db.settings.keys[k].configured).map((k) => {
    const key = db.settings.keys[k];
    const source = key.source ?? 'stored';
    const defaultModel = defaultKind === k ? db.settings.evalModel : PROVIDER_MODELS[k][0]!;
    return { id: `${k}-${source}`, kind: k, name: source === 'env' ? `${PROVIDER_LABELS[k]} (${PROVIDER_ENV_KEYS[k]})` : PROVIDER_LABELS[k], keySource: source, keyLast4: key.last4, defaultModel, models: [...new Set([defaultModel, ...PROVIDER_MODELS[k]])], isDefault: defaultKind === k, lastTestAt: iso(Date.now() - DAY), lastTestOk: true };
  });
}

function settingsView(db: MockDb) {
  const st = db.settings;
  return {
    general: { orgName: st.orgName, publicUrl: 'https://mcp.acme.test', retentionDays: st.taskDays },
    models: { anthropicKey: st.keys.anthropic, keys: st.keys, evalModel: st.evalModel, judgeModel: st.judgeModel, generatorModel: st.generatorModel, effort: st.effort, fallbacks: st.fallbacks },
    codeMode: { enabled: st.codeModeEnabled, executor: { mode: 'embedded' as const, ok: true, montyVersion: '0.4.2', poolMax: 8, busy: 1, detail: null }, defaults: { maxToolCalls: 200, wallTimeSec: 30, cpuTimeSec: 10, maxMemoryMb: 64, maxConcurrentCalls: 8, maxResultBytes: 1_048_576 }, cap: { maxToolCalls: 1000, wallTimeSec: 120, cpuTimeSec: 60, maxMemoryMb: 512, maxConcurrentCalls: 32, maxResultBytes: 4_194_304 } },
    retention: { auditDays: st.auditDays, taskDays: st.taskDays },
    telemetry: { otelEnabled: true, metricsEnabled: true, otlpEndpoint: 'http://otel-collector:4318' },
    discovery: { nativeSearchClients: ['claude-code'] },
    audit: { storeOutputs: st.storeOutputs, export: { webhookUrl: null, webhookEnabled: false, webhookSecret: null, otelLogsEnabled: false, sinks: [] } },
    fileManaged: ['telemetry.otlpEndpoint', 'general.publicUrl'],
  };
}

/* ================================================================== the fixtures */

export function contractFixtures(db: MockDb, opts: { demo?: boolean; me?: Me } = {}): ContractFixtures {
  const srv = (ctx: Ctx, key = 'id') => db.servers.find((s) => s.seed.id === p(ctx, key) || s.seed.slug === p(ctx, key));
  const envById = (id: string): { s: ServerState; e: EnvironmentDetail } | null => {
    for (const s of db.servers) for (const e of s.envs) if (e.id === id) return { s, e };
    return null;
  };
  const tool = (id: string) => {
    const parsed = parseToolId(id);
    const s = parsed ? db.servers.find((x) => x.seed.id === parsed.serverId) : undefined;
    const t = s?.tools.find((x) => x.orig === parsed!.orig);
    return s && t ? { s, t } : null;
  };
  const me = opts.me ?? meFixture('admin', { demoReadOnly: !!opts.demo });
  const badges = (): Badges => ({
    inboxOpen: db.needGroups.filter((g) => g.status === 'open' || g.status === 'planned').length + db.issues.filter((i) => i.status === 'open').length,
    evalsRunning: db.runs.filter((r) => (tickRun(db, r), r.row.status === 'running')).length,
  });
  const runRows = (serverId?: string | null): EvalRunRow[] => {
    for (const r of db.runs) tickRun(db, r);
    return db.runs.filter((r) => !serverId || r.row.server.id === serverId).sort((a, b) => b.number - a.number).map((r) => r.row);
  };
  const runOf = (id: string) => db.runs.find((x) => x.row.id === id);
  const sref = (s: ServerState) => ({ id: s.seed.id, slug: s.seed.slug, name: s.name });

  const fixtures: ContractFixtures = {
    /* ---------------------------------------------------------------- auth, me */
    'auth.config': { oidc: { enabled: true, displayName: 'Acme SSO' }, localLink: true, demoReadOnly: !!opts.demo, orgName: INSTANCE.name },
    'auth.link': async (ctx) => (/expired/.test((await body<{ token?: string }>(ctx)).token ?? '') ? problem(401, 'unauthenticated', 'Link expired', 'This sign-in link has expired or was already used. Run `neurouter console-link` for a new one.') : me),
    'auth.logout': { endSessionUrl: null },
    'me.get': () => ({ ...me, badges: badges() }),
    'me.badges': () => badges(),

    /* ---------------------------------------------------------------- metrics */
    'metrics.overview': (ctx) => {
      const sid = q(ctx).get('serverId');
      const to = Date.parse(q(ctx).get('to') ?? '') || Date.now();
      const from = Date.parse(q(ctx).get('from') ?? '') || to - 7 * DAY;
      const span = to - from;
      const kpis = (a: number, b: number) => {
        const rows = db.tasks.filter((t) => (!sid || t.server.id === sid) && Date.parse(t.startedAt) >= a && Date.parse(t.startedAt) < b);
        const closed = rows.filter((t) => t.outcome);
        const calls = rows.reduce((x, t) => x + t.callCount * 4, 0);
        const errs = rows.reduce((x, t) => x + t.errorCount, 0);
        return {
          tasks: rows.length, taskSuccessRate: closed.length ? closed.filter((t) => t.outcome === 'success').length / closed.length : null, calls, errorRate: calls ? errs / calls : null,
          blockedCalls: rows.reduce((x, t) => x + t.blockedCount, 0), scriptRuns: rows.reduce((x, t) => x + t.scriptCount, 0),
          unmetNeedsOpen: db.needGroups.filter((g) => (!sid || g.server.id === sid) && (g.status === 'open' || g.status === 'planned')).length,
          issuesOpen: db.issues.filter((i) => (!sid || i.server.id === sid) && i.status === 'open').length,
        };
      };
      const servers = db.servers.filter((s) => !sid || s.seed.id === sid);
      const topTools = servers.flatMap((s) => s.tools.filter((t) => t.calls7d > 0).map((t) => ({ tool: toolName(s, t), serverId: s.seed.id, calls: t.calls7d, errorRate: t.err, p95Ms: 180 + Math.round(t.err * 9000) })));
      return {
        kpis: kpis(from, to), previous: kpis(from - span, from), readiness: servers.map((s) => ({ ...readinessFor(db, s.seed.id), serverId: s.seed.id, serverSlug: s.seed.slug, serverName: s.name })),
        topTools: topTools.sort((a, b) => b.calls - a.calls).slice(0, 5), topErrors: [{ code: 'upstream_500', count: 41 }, { code: 'invalid_args', count: 22 }, { code: 'rate_limited', count: 9 }],
        recentTasks: db.tasks.filter((t) => !sid || t.server.id === sid).slice(0, 5), from: iso(from), to: iso(to),
      };
    },
    'metrics.timeseries': (ctx) => {
      const sid = q(ctx).get('serverId');
      const tool = [700, 760, 820, 790, 880, 910, 860, 940, 980, 1010, 1050, 1080, 1120, 1160];
      const code = [200, 240, 300, 330, 420, 480, 520, 600, 690, 760, 850, 930, 1060, 1240];
      const f = !sid || sid === 'srv_acme_orders' ? 1 : sid === 'srv_lumen' ? 0.3 : 0;
      const start = new Date(Date.now() - 13 * DAY);
      start.setUTCHours(0, 0, 0, 0);
      const pts = (vals: number[]) => vals.map((v, i) => ({ t: iso(start.getTime() + i * DAY), v: Math.round(v * f) }));
      return { metric: (q(ctx).get('metric') ?? 'calls') as 'calls', bucket: 'day', series: [{ key: 'tool', points: pts(tool) }, { key: 'code', points: pts(code) }] };
    },
    'metrics.toolUsage': (ctx) => {
      const x = tool(p(ctx, 'id'));
      if (!x) return notFound('Tool');
      const calls = x.t.calls7d;
      const errors = Math.round(calls * x.t.err);
      return {
        calls, errors, p50Ms: calls ? 90 : null, p95Ms: calls ? 180 + Math.round(x.t.err * 9000) : null, byStatus: { ok: calls - errors, upstream_error: Math.round(errors * 0.6), invalid_args: errors - Math.round(errors * 0.6) },
        byEnvironment: { prod: Math.round(calls * 0.6), qa: Math.round(calls * 0.15), dev: Math.round(calls * 0.2), mock: calls - Math.round(calls * 0.95) }, byMode: { tool: Math.round(calls * 0.7), code: calls - Math.round(calls * 0.7) },
        recentErrors: errors ? [{ errorId: 'err_7f21aa', code: 'upstream_500', ts: iso(Date.now() - 2 * HOUR) }, { errorId: 'err_7f1c02', code: 'invalid_args', ts: iso(Date.now() - 9 * HOUR) }] : [],
      };
    },

    /* ---------------------------------------------------------------- servers */
    'servers.list': (ctx) => {
      const term = q(ctx).get('q')?.toLowerCase();
      const kind = q(ctx).get('kind');
      return page(db.servers.filter((s) => (!term || s.name.toLowerCase().includes(term) || s.seed.slug.includes(term)) && (!kind || s.seed.kind === kind)).map((s) => serverRow(db, s)), ctx);
    },
    'servers.get': (ctx) => {
      const s = srv(ctx);
      return s ? serverDetail(db, s) : notFound('Server');
    },
    'servers.create': async (ctx) => {
      const b = await body<{ previewId?: string; slug?: string; name?: string; description?: string; environments?: { slug: string; kind: 'dev' | 'qa' | 'prod'; baseUrl: string; auth?: UpstreamAuthIn }[] }>(ctx);
      const entry = b.previewId ? db.previews.get(b.previewId) : null;
      if (!entry) return problem(422, 'validation_failed', 'Validation failed', 'Unknown or expired preview. Import the spec again.');
      // the sample spec maps onto the existing Acme Orders API server (demo allow-list, spec §12)
      if (entry.preview.title === 'Acme Orders API' && (opts.demo || b.slug === 'acme-orders')) return HttpResponse.json(serverDetail(db, db.servers[0]!), { status: 201 });
      if (opts.demo) return problem(403, 'forbidden', 'Read-only demo', 'The demo creates only the sample server. Run Neurouter yourself to import your own API.', { reason: 'demo_read_only' });
      if (db.servers.some((s) => s.seed.slug === b.slug)) return problem(409, 'conflict', 'Slug taken', `A server with the slug ${b.slug} already exists.`, { errors: [{ path: ['slug'], message: 'This slug is taken', code: 'taken' }] });
      const slug = b.slug ?? 'new-api';
      const id = `srv_${slug.replaceAll('-', '_')}`;
      const pv = previewState(db, entry.preview.id)!;
      const tools: ToolSeed[] = pv.tools.map((t) => ({ name: t.name, orig: t.title.replace(/[^A-Za-z0-9_]/g, '') || t.name, method: t.method ?? undefined, path: t.path ?? undefined, field: t.field ?? undefined, write: t.write, hidden: t.hidden, quality: t.descriptionQuality, calls7d: 0, err: 0, description: '' }));
      const seed = { id, slug, name: b.name ?? pv.name ?? 'Imported API', description: b.description ?? '', kind: pv.kind ?? 'openapi', specFormat: (pv.format ?? 'openapi-3.1') as 'openapi-3.1', specTitle: pv.title ?? '', operations: pv.operationCount, specRev: 1, overlayRev: 1, envs: ['mock'], importedDaysAgo: 0 };
      const tpl = db.servers[0]!;
      const s: ServerState = { ...tpl, seed, name: seed.name, description: seed.description, tools, published: {}, draft: {}, draftRev: 1, draftUpdatedAt: Date.now(), versions: [], specs: [], envs: [], publicReport: false, exposure: { mode: 'auto', discovery: 'auto', pinned: [] }, opsTools: { ...tpl.opsTools } };
      s.versions = [{ id: `ovl_${slug}_1`, rev: 1, hash: 'h1', message: 'Initial import', source: 'console', basedOnRev: null, createdBy: { id: PEOPLE.maya.id, name: PEOPLE.maya.name }, createdAt: iso(Date.now()), toolChanges: Object.keys(entry.draftOps).length, yaml: '' }];
      s.specs = [{ id: `spec_${slug}_1`, rev: 1, format: seed.specFormat, title: seed.specTitle, apiVersion: null, operationCount: seed.operations, contentHash: 'c1', contentBytes: 12_000, sourceUrl: null, createdAt: iso(Date.now()), createdBy: { id: PEOPLE.maya.id, name: PEOPLE.maya.name } }];
      const build = buildRow(s, 1, []);
      const mk = (slugE: string, kind: 'dev' | 'qa' | 'prod', isMock: boolean, baseUrl: string, auth: UpstreamAuthIn): EnvironmentDetail => ({
        ...tpl.envs[isMock ? 0 : 1]!, id: `env_${slug}_${slugE}`, serverId: id, slug: slugE, name: isMock ? 'Mock' : slugE.toUpperCase(), kind, isMock, builtin: isMock, baseUrl, auth: toAuthOut(auth),
        writes: { enabled: isMock, tools: null, confirm: kind === 'prod' ? 'elicit' : 'none', writeToolCount: tools.filter((t) => t.write).length, enabledToolNames: isMock ? tools.filter((t) => t.write).map((t) => t.name) : [] },
        health: { status: isMock ? 'up' : 'unknown', checkedAt: null, latencyMs: null, error: null }, mcpUrl: `https://mcp.acme.test/mcp/${slug}/${slugE}`, managedBy: 'console', config: null, buildId: build.id, build: { ...build, environments: [slugE] }, createdAt: iso(Date.now()), updatedAt: iso(Date.now()),
      });
      s.envs = [mk('mock', 'dev', true, 'mock:', { type: 'none' }), ...(b.environments ?? []).map((e) => mk(e.slug, e.kind, false, e.baseUrl, e.auth ?? { type: 'none' }))];
      s.published = { ...entry.draftOps };
      s.versions[0]!.yaml = overlayYaml(s, false);
      db.servers.push(s);
      db.previews.delete(entry.preview.id);
      return HttpResponse.json(serverDetail(db, s), { status: 201 });
    },
    'servers.update': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const b = await body<{ name?: string; description?: string; exposure?: Partial<ServerState['exposure']>; opsTools?: Partial<ServerState['opsTools']>; publicReport?: boolean }>(ctx);
      if (s.seed.id === 'srv_lumen' && (b.name !== undefined || b.description !== undefined || b.exposure)) return problem(409, 'config_managed', 'Managed by neurouter.yaml', 'This server is defined in neurouter.yaml. Edit the file to change it.', { configPath: 'neurouter.yaml', configLine: 42 });
      if (b.name !== undefined) s.name = b.name;
      if (b.description !== undefined) s.description = b.description;
      if (b.exposure) s.exposure = { ...s.exposure, ...b.exposure };
      if (b.opsTools) s.opsTools = { ...s.opsTools, ...b.opsTools };
      if (b.publicReport !== undefined) s.publicReport = b.publicReport;
      return serverDetail(db, s);
    },
    'servers.delete': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      if (q(ctx).get('confirm') !== s.seed.slug) return problem(422, 'validation_failed', 'Validation failed', 'Type the server slug to confirm.');
      db.servers = db.servers.filter((x) => x !== s);
      return null;
    },
    'servers.connect': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const env = s.envs.find((e) => e.id === q(ctx).get('environmentId')) ?? s.envs.find((e) => e.kind === 'qa' && !e.isMock) ?? s.envs.find((e) => !e.isMock) ?? s.envs[0]!;
      const name = `${s.seed.slug}-${env.slug}`;
      const url = env.mcpUrl;
      const code = `${url}?tools=code`;
      return {
        mcpUrl: url, resourceMetadataUrl: `https://mcp.acme.test/.well-known/oauth-protected-resource/mcp/${s.seed.slug}/${env.slug}`, environment: { id: env.id, slug: env.slug, kind: env.kind },
        auth: { apiKey: true, oauth: true, externalAs: null },
        summary: { exposure: s.exposure.mode, discovery: s.exposure.discovery, listedTools: visibleCount(s), codeMode: env.codeMode && s.exposure.mode !== 'tools', writesEnabled: env.writes.enabledToolNames.length > 0 },
        clients: [
          { id: 'claude-code', name: 'Claude Code', snippet: `claude mcp add --transport http ${name} ${url} \\\n  --header "Authorization: Bearer $NEUROUTER_API_KEY"`, codeModeOnlySnippet: `claude mcp add --transport http ${name} "${code}" \\\n  --header "Authorization: Bearer $NEUROUTER_API_KEY"` },
          { id: 'cursor', name: 'Cursor', snippet: JSON.stringify({ mcpServers: { [name]: { url, headers: { Authorization: 'Bearer ${env:NEUROUTER_API_KEY}' } } } }, null, 2), codeModeOnlySnippet: JSON.stringify({ mcpServers: { [name]: { url: code, headers: { Authorization: 'Bearer ${env:NEUROUTER_API_KEY}' } } } }, null, 2) },
          { id: 'vscode', name: 'VS Code', snippet: JSON.stringify({ servers: { [name]: { type: 'http', url, headers: { Authorization: 'Bearer ${input:neurouter-key}' } } } }, null, 2), codeModeOnlySnippet: JSON.stringify({ servers: { [name]: { type: 'http', url: code } } }, null, 2) },
          { id: 'http', name: 'Generic HTTP', snippet: `POST ${url}\nAuthorization: Bearer <NEUROUTER_API_KEY>\nContent-Type: application/json\nAccept: application/json, text/event-stream\n\n{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}`, codeModeOnlySnippet: `POST ${code}` },
        ],
      };
    },
    'opsTools.list': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const meta: Record<string, [string, string, 'pinned' | 'search' | 'hint', number]> = {
        begin_task: ['Begin task', 'Frames a task with a goal so task success can be measured.', 'pinned', 1204],
        end_task: ['End task', 'Closes the task with an outcome and a note.', 'pinned', 1180],
        report_unmet_need: ['Report unmet need', 'Tells you what the agent wanted but could not do.', 'pinned', 61],
        log_decision: ['Log decision', 'Records a choice and its reason.', 'search', 640],
        report_issue: ['Report issue', 'Reports a broken or confusing tool.', 'search', 18],
        explain_error: ['Explain error', 'Explains an error id and how to recover.', 'search', 96],
        get_examples: ['Get examples', 'Returns example calls and scripts for a tool.', 'search', 210],
        whoami: ['Who am I', 'Shows the key, environment and permissions.', 'search', 33],
      };
      const rows = Object.entries(meta).map(([name, [title, description, visibility, calls]]) => ({ name: `neurouter_${name}`, pyName: `ops.${name}`, title, description, enabled: s.opsTools[name as keyof ServerState['opsTools']] ?? true, toggleable: true, visibility, calls7d: calls }));
      rows.push({ name: 'neurouter_read_result', pyName: null as unknown as string, title: 'Read result', description: 'Pages through a truncated result by handle.', enabled: true, toggleable: false, visibility: 'hint', calls7d: 72 });
      return { items: rows };
    },
    'opsTools.set': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      s.opsTools = { ...s.opsTools, ...(await body<Partial<ServerState['opsTools']>>(ctx)) };
      return (fixtures['opsTools.list'] as Resolver)(ctx);
    },

    /* ---------------------------------------------------------------- specs, builds */
    'specs.list': (ctx) => {
      const s = srv(ctx);
      return s ? page(s.specs, ctx) : notFound('Server');
    },
    'specs.get': (ctx) => {
      for (const s of db.servers) {
        const sp = s.specs.find((x) => x.id === p(ctx, 'id'));
        if (!sp) continue;
        const latest = sp.rev === s.specs[0]!.rev;
        return {
          ...sp,
          summary: sp.rev === 1
            ? { added: [], removed: [], changed: [], orphanedOverlayKeys: [] }
            : {
                added: [
                  { key: 'operationId:listOrderReturns', method: 'GET', path: '/v2/orders/{id}/returns', operationId: 'listOrderReturns', toolName: 'list_order_returns' },
                  { key: 'operationId:createReturn', method: 'POST', path: '/v2/returns', operationId: 'createReturn', toolName: 'create_return' },
                  { key: 'operationId:getReturn', method: 'GET', path: '/v2/returns/{id}', operationId: 'getReturn', toolName: 'get_return' },
                ],
                removed: [{ key: 'operationId:listOrdersV1', method: 'GET', path: '/v1/orders', operationId: 'listOrdersV1', toolName: 'list_orders_v1' }],
                changed: [
                  { op: { key: 'operationId:postRefund', method: 'POST', path: '/v2/refunds', operationId: 'postRefund', toolName: 'create_refund' }, fields: ['requestBody', 'description'] },
                  { op: { key: 'operationId:getOrdersV2', method: 'GET', path: '/v2/orders', operationId: 'getOrdersV2', toolName: 'list_orders' }, fields: ['parameters'] },
                ],
                orphanedOverlayKeys: latest ? ['operationId:listOrdersV1'] : [],
              },
        };
      }
      return notFound('Spec revision');
    },
    'specs.reimport': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const rev = s.specs[0]!.rev + 1;
      s.specs.unshift({ ...s.specs[0]!, id: `spec_${s.seed.slug}_${rev}`, rev, operationCount: s.specs[0]!.operationCount + 2, contentHash: `c${rev}`, createdAt: iso(Date.now()) });
      return { jobId: `job_reimport_${s.seed.slug}_${rev}`, status: 'succeeded' };
    },
    'specs.download': () => new HttpResponse('openapi: 3.1.0\ninfo: { title: Acme Orders API, version: 2.3.0 }\npaths: {}\n', { headers: { 'content-type': 'application/yaml' } }),
    'specs.diff': () => ({ added: [], removed: [], changed: [], orphanedOverlayKeys: [] }),
    'specs.preview': async (ctx) => {
      const b = await body<{ source?: { url?: string; content?: string; filename?: string; graphqlEndpoint?: string } }>(ctx);
      const id = `pv_${++db.seq}`;
      const src = b.source ?? {};
      let pv: SpecPreview | Response;
      if (src.url !== undefined || src.graphqlEndpoint !== undefined) {
        const url = src.url ?? src.graphqlEndpoint ?? '';
        if (opts.demo && !/acme/.test(url)) return problem(403, 'forbidden', 'Read-only demo', 'The demo imports only the sample spec. Paste or upload a file, or run Neurouter yourself.', { reason: 'demo_read_only' });
        if (/unreachable|\.invalid/.test(url)) return problem(502, 'spec_fetch_failed', 'Could not fetch the spec', `${url} did not respond.`, { reason: 'unreachable' });
        if (/169\.254|metadata\.google|\/\/10\.|\/\/192\.168/.test(url)) return problem(502, 'spec_fetch_failed', 'Could not fetch the spec', 'That host is blocked (private or metadata address).', { reason: 'blocked_host' });
        if (/\.html?$|example\.com\/?$/.test(url)) return problem(502, 'spec_fetch_failed', 'Could not fetch the spec', 'The URL returned HTML, not an OpenAPI or GraphQL document.', { reason: 'not_a_spec' });
        pv = /acme|sample/.test(url)
          ? previewFromAcme(id)
          : finish(id, src.graphqlEndpoint ? 'graphql' : 'openapi', src.graphqlEndpoint ? 'graphql-introspection' : 'openapi-3.1', 'Imported API', Array.from({ length: 12 }, (_, i) => ({ name: `operation_${i + 1}`, title: `operation${i + 1}`, method: 'GET', path: `/items/${i + 1}`, field: null, write: i % 4 === 0, hidden: false, descriptionQuality: 'short' as const, suggestedHide: [] })));
      } else if (src.content !== undefined) {
        if (src.content.length > 10 * 1024 * 1024) return problem(502, 'spec_fetch_failed', 'Could not fetch the spec', 'The file is larger than 10 MB.', { reason: 'too_large' });
        pv = /title:\s*Acme Orders API/.test(src.content) ? previewFromAcme(id) : previewFromContent(id, src.content, src.filename);
      } else return problem(422, 'validation_failed', 'Validation failed', 'Give a URL, a file or pasted content.');
      if (pv instanceof Response) return pv;
      db.previews.set(id, { preview: pv, createdMs: Date.now(), draftOps: {} });
      return { jobId: `job_${id}`, status: 'running', previewId: id };
    },
    'specs.draft': (ctx) => previewState(db, p(ctx, 'id')) ?? problem(404, 'not_found', 'Import draft expired', 'This import draft has expired. Start again.'),
    'specs.draftUpdate': async (ctx) => {
      const entry = db.previews.get(p(ctx, 'id'));
      if (!entry) return notFound('Preview');
      const b = await body<{ name?: string; slug?: string; overlayOps?: OverlayPatchOp[] }>(ctx);
      if (b.slug !== undefined && b.slug !== 'acme-orders' && db.servers.some((s) => s.seed.slug === b.slug)) return problem(409, 'conflict', 'Slug taken', 'This slug is taken.', { errors: [{ path: ['slug'], message: 'This slug is taken', code: 'taken' }] });
      if (b.name !== undefined) entry.preview.name = b.name;
      if (b.slug !== undefined) entry.preview.slug = b.slug;
      for (const op of b.overlayOps ?? []) {
        if (op.op === 'set') entry.draftOps[op.selector] = { ...(entry.draftOps[op.selector] ?? {}), [op.field]: op.value };
        if (op.op === 'unset' && entry.draftOps[op.selector]) {
          delete (entry.draftOps[op.selector] as Record<string, unknown>)[op.field];
          if (!Object.keys(entry.draftOps[op.selector]!).length) delete entry.draftOps[op.selector];
        }
      }
      return previewState(db, entry.preview.id);
    },
    'specs.cancelPreview': (ctx) => (db.previews.delete(p(ctx, 'id')), null),
    'builds.list': (ctx) => {
      const s = srv(ctx);
      return s ? page(s.versions.map((v) => buildRow(s, v.rev)), ctx) : notFound('Server');
    },
    'builds.get': (ctx) => {
      const s = db.servers.find((x) => p(ctx, 'id').startsWith(`bld_${x.seed.slug}_`));
      if (!s) return notFound('Build');
      return { ...buildRow(s, Number(p(ctx, 'id').split('_').pop())), diagnostics: previewFromAcme('x').diagnostics, lint: s.seed.id === 'srv_bluefin' ? BLUEFIN_LINT : ACME_LINT, orphanedOverlayKeys: [] };
    },
    'builds.stubs': (ctx) => {
      const s = db.servers.find((x) => p(ctx, 'id').startsWith(`bld_${x.seed.slug}_`)) ?? db.servers[0]!;
      return { namespaces: [{ name: s.seed.slug.replaceAll('-', '_'), pyi: s.tools.filter((t) => toolVisible(s, t)).map((t) => toolDetail(s, t).pySignature + ' ...').join('\n') }] };
    },

    /* ---------------------------------------------------------------- tools, overlays */
    'tools.list': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const sp = q(ctx);
      const term = sp.get('q')?.toLowerCase();
      const vis = sp.get('visibility') ?? 'all';
      const kind = sp.get('kind');
      let rows = s.tools.map((t) => toolRow(s, t));
      if (term) rows = rows.filter((r) => r.name.includes(term) || (r.path ?? '').toLowerCase().includes(term) || r.key.toLowerCase().includes(term));
      if (vis === 'visible') rows = rows.filter((r) => !r.hidden);
      if (vis === 'hidden') rows = rows.filter((r) => r.hidden);
      if (kind) rows = rows.filter((r) => (kind === 'write' ? r.write : !r.write));
      if (sp.get('pinned') === 'true') rows = rows.filter((r) => r.pinned);
      if (sp.get('modified') === 'true') rows = rows.filter((r) => r.overlayModified);
      return page(rows, ctx, 100);
    },
    'tools.get': (ctx) => {
      const x = tool(p(ctx, 'id'));
      if (!x) return notFound('Tool');
      const d = toolDetail(x.s, x.t);
      return { ...d, overlayEntry: x.s.draft[keyOf(x.t)] ? effectiveEntry(x.s, keyOf(x.t), true) : d.overlayEntry };
    },
    'tools.search': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const term = (q(ctx).get('q') ?? '').toLowerCase();
      const words = term.split(/\s+/).filter(Boolean);
      const visible = s.tools.filter((t) => toolVisible(s, t));
      const hits = visible
        .map((t) => {
          const e = effectiveEntry(s, keyOf(t), false);
          const name = e.name ?? t.name;
          const description = e.description ?? t.description;
          const hay = `${name.replaceAll('_', ' ')} ${description}`.toLowerCase();
          const score = words.reduce((a, w) => a + (name.includes(w) ? 2 : 0) + (hay.includes(w) ? 1 : 0) + (hay.includes(w.replace(/s$/, '')) ? 0.5 : 0), 0) / Math.max(1, words.length * 3.5);
          return { name, title: name.replaceAll('_', ' '), description, readOnly: !t.write, write: !!t.write, score: Math.round(Math.min(1, score) * 100) / 100 };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      return { tools: hits, totalVisible: visible.length, mode: 'hybrid' };
    },
    'tools.searchAll': (ctx) => {
      const term = (q(ctx).get('q') ?? '').toLowerCase().replaceAll(' ', '_');
      const items = db.servers.flatMap((s) => s.tools.filter((t) => toolVisible(s, t)).map((t) => ({ id: toolId(s.seed.id, t.orig), name: toolName(s, t), title: toolName(s, t).replaceAll('_', ' '), server: sref(s) }))).filter((t) => t.name.includes(term));
      return { items: items.slice(0, Number(q(ctx).get('limit') ?? 8)) };
    },
    'tools.diff': (ctx) => {
      const x = tool(p(ctx, 'id'));
      if (!x) return notFound('Tool');
      return { before: toolDetail(x.s, x.t, false).agentView, after: toolDetail(x.s, x.t, true).agentView, changedFields: Object.keys(x.s.draft[keyOf(x.t)] ?? {}) };
    },
    'overlays.getDraft': (ctx) => {
      const s = srv(ctx);
      return s ? draftOf(s) : notFound('Server');
    },
    'overlays.updateDraft': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const ifMatch = ctx.request.headers.get('if-match');
      if (ifMatch && ifMatch !== draftOf(s).etag) return problem(409, 'draft_conflict', 'Draft changed', 'The draft changed since you loaded it.');
      const b = await body<{ ops?: OverlayPatchOp[] }>(ctx);
      return applyOps(s, b.ops ?? []) ?? draftOf(s);
    },
    'overlays.discardDraft': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      s.draft = {};
      s.draftRev++;
      return null;
    },
    'overlays.publish': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      if (!draftChanges(s).length) return problem(409, 'conflict', 'Nothing to publish', 'The draft has no changes.');
      const b = await body<{ message: string; pinTo?: string[] }>(ctx);
      return publish(s, b.message, b.pinTo);
    },
    'overlays.versions': (ctx) => {
      const s = srv(ctx);
      return s ? page(s.versions.map(({ yaml: _y, ...r }) => r), ctx) : notFound('Server');
    },
    'overlays.getVersion': (ctx) => {
      for (const s of db.servers) {
        const v = s.versions.find((x) => x.id === p(ctx, 'id'));
        if (v) return v;
      }
      return notFound('Overlay version');
    },
    'overlays.diff': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const yamlOf = (r: string | null) => (r === 'draft' ? overlayYaml(s, true) : (s.versions.find((v) => String(v.rev) === r)?.yaml ?? overlayYaml(s, false)));
      const changes = draftChanges(s);
      const name = (key: string) => {
        const t = toolBySelector(s, key);
        return t ? toolName(s, t, true) : key;
      };
      const tools = [...new Set(changes.map((c) => c.target))];
      return { fromYaml: yamlOf(q(ctx).get('from')), toYaml: yamlOf(q(ctx).get('to')), toolChanges: tools.map((k) => ({ toolName: name(k), fields: changes.filter((c) => c.target === k).map((c) => c.field ?? '') })) };
    },
    'overlays.revert': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const b = await body<{ toRev: number; message?: string }>(ctx);
      if (!s.versions.find((v) => v.rev === b.toRev)) return notFound('Overlay version');
      s.draft = { 'operationId:customersSearch': { description: 'Search customers.' } };
      return publish(s, b.message ?? `Revert to v${b.toRev}`, undefined, 'revert');
    },
    'overlays.download': (ctx) => {
      const s = srv(ctx);
      return new HttpResponse(s ? overlayYaml(s, false) : '', { headers: { 'content-type': 'text/yaml', 'content-disposition': 'attachment; filename="overlay.yaml"' } });
    },
    'overlays.validate': () => ({ ok: true, diagnostics: [], preview: { toolCount: 46, visibleCount: 31, lintScore: 76 } }),
    'overlays.preview': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const b = await body<{ toolName: string; ops?: OverlayPatchOp[] }>(ctx);
      const t = s.tools.find((x) => x.orig === b.toolName || toolName(s, x, true) === b.toolName || toolName(s, x) === b.toolName || keyOf(x) === b.toolName);
      if (!t) return notFound('Tool');
      let e = effectiveEntry(s, keyOf(t), true);
      for (const op of b.ops ?? []) if (op.op === 'set') e = op.field === 'response' ? { ...e, response: { ...(e.response ?? {}), ...(op.value as object) } } : { ...e, [op.field]: op.value };
      const sh = shapingPreview(t, e);
      const detail = toolDetail(s, t, true);
      const mcp = { ...detail.agentView.mcp, name: `${s.seed.slug.replaceAll('-', '_')}__${e.name ?? t.name}`, description: e.description ?? t.description };
      return { agentView: { mcp, python: detail.agentView.python }, sample: { before: sh.before, after: sh.after, source: 'mock' }, tokens: { definition: tokens(mcp), sampleBefore: sh.tokensBefore, sampleAfter: sh.tokensAfter, estimated: true }, diagnostics: [] };
    },

    /* ---------------------------------------------------------------- environments */
    'environments.list': (ctx) => {
      const s = srv(ctx);
      return s ? { items: s.envs } : notFound('Server');
    },
    'environments.get': (ctx) => envById(p(ctx, 'id'))?.e ?? notFound('Environment'),
    'environments.create': async (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const b = await body<{ slug: string; kind: 'dev' | 'qa' | 'prod'; baseUrl: string; auth?: UpstreamAuthIn }>(ctx);
      if (s.envs.some((e) => e.slug === b.slug)) return problem(409, 'conflict', 'Name taken', `An environment named ${b.slug} already exists.`, { errors: [{ path: ['slug'], message: 'This name is taken', code: 'taken' }] });
      const tpl = s.envs.find((e) => !e.isMock) ?? db.servers[0]!.envs[1]!;
      const env: EnvironmentDetail = {
        ...tpl, id: `env_${s.seed.slug}_${b.slug}`, serverId: s.seed.id, slug: b.slug, name: b.slug.toUpperCase(), kind: b.kind, isMock: false, builtin: false, baseUrl: b.baseUrl, auth: toAuthOut(b.auth ?? { type: 'none' }),
        writes: { enabled: false, tools: [], confirm: b.kind === 'prod' ? 'elicit' : 'none', writeToolCount: tpl.writes.writeToolCount, enabledToolNames: [] },
        health: { status: 'unknown', checkedAt: null, latencyMs: null, error: null }, credential: b.auth && b.auth.type !== 'none' ? 'ok' : 'not_required',
        mcpUrl: `https://mcp.acme.test/mcp/${s.seed.slug}/${b.slug}`, managedBy: 'console', config: null, createdAt: iso(Date.now()), updatedAt: iso(Date.now()),
      };
      s.envs.push(env);
      return HttpResponse.json(env, { status: 201 });
    },
    'environments.update': async (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      if (x.e.managedBy === 'file') return problem(409, 'config_managed', 'Managed by neurouter.yaml', 'This environment is defined in neurouter.yaml. Edit the file to change it.', { configPath: 'neurouter.yaml', configLine: 58 });
      const b = await body<{ baseUrl?: string; auth?: UpstreamAuthIn; limits?: Partial<EnvironmentDetail['limits']>; codeMode?: boolean; name?: string }>(ctx);
      if (b.baseUrl !== undefined) x.e.baseUrl = b.baseUrl;
      if (b.auth) {
        x.e.auth = toAuthOut(b.auth);
        x.e.credential = b.auth.type === 'none' ? 'not_required' : 'ok';
      }
      if (b.limits) x.e.limits = { ...x.e.limits, ...b.limits, code: { ...x.e.limits.code, ...(b.limits.code ?? {}) } };
      if (b.codeMode !== undefined) x.e.codeMode = b.codeMode;
      if (b.name) x.e.name = b.name;
      x.e.updatedAt = iso(Date.now());
      return x.e;
    },
    'environments.delete': (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      if (x.e.builtin) return problem(409, 'conflict', 'Built-in environment', 'The mock environment cannot be deleted.');
      const keys = db.keys.filter((k) => k.environment.id === x.e.id && k.status === 'active');
      if (keys.length) return problem(409, 'conflict', 'Environment in use', `Revoke these keys first: ${keys.map((k) => k.name).join(', ')}.`, { keys: keys.map((k) => k.name) });
      x.s.envs = x.s.envs.filter((e) => e !== x.e);
      return null;
    },
    'environments.setWrites': async (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      const b = await body<{ enabled: boolean; tools?: string[] | null; confirm: 'none' | 'elicit' | 'deny_without_elicitation'; confirmEnvironmentSlug?: string }>(ctx);
      if (x.e.kind === 'prod' && b.enabled && b.confirmEnvironmentSlug !== x.e.slug) return problem(422, 'validation_failed', 'Confirmation required', `Type ${x.e.slug} to enable writes in this environment.`);
      x.e.writes.enabled = b.enabled;
      x.e.writes.confirm = b.confirm;
      const all = x.s.tools.filter((t) => t.write && toolVisible(x.s, t)).map((t) => toolName(x.s, t));
      x.e.writes.tools = b.tools ?? null;
      x.e.writes.enabledToolNames = b.enabled ? (b.tools ?? all) : [];
      return x.e;
    },
    'environments.setToolWrite': async (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      const b = await body<{ enabled: boolean; confirmEnvironmentSlug?: string }>(ctx);
      const name = p(ctx, 'toolName');
      // frontend G4: a prod cell needs the typed confirmation too
      if (x.e.kind === 'prod' && b.enabled && b.confirmEnvironmentSlug !== x.e.slug) return problem(422, 'validation_failed', 'Confirmation required', `Type ${x.e.slug} to enable ${name} in this environment.`);
      const set = new Set(x.e.writes.enabledToolNames);
      if (b.enabled) set.add(name);
      else set.delete(name);
      x.e.writes.enabledToolNames = [...set];
      x.e.writes.tools = [...set];
      x.e.writes.enabled = set.size > 0;
      if (x.e.kind === 'prod') x.e.writes.confirm = 'elicit';
      return x.e;
    },
    'environments.pinBuild': async (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      const b = await body<{ buildId: string }>(ctx);
      x.e.buildId = b.buildId;
      x.e.build = { ...buildRow(x.s, Number(b.buildId.split('_').pop())), environments: [x.e.slug] };
      return x.e;
    },
    'environments.setSecret': (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      const name = p(ctx, 'name');
      return { name, ref: `secret:${name}`, updatedAt: iso(Date.now()) };
    },
    'environments.deleteSecret': () => null,
    'environments.test': (ctx) => {
      const x = envById(p(ctx, 'id'));
      if (!x) return notFound('Environment');
      if (x.e.health.status === 'down') return { ok: false, latencyMs: null, credential: 'ok', detail: x.e.health.error ?? 'Unreachable' };
      x.e.health = { ...x.e.health, checkedAt: iso(Date.now()), status: 'up' };
      const credential = x.e.auth.type === 'none' || x.e.auth.type === 'oauth_passthrough' ? 'not_required' : 'ok';
      return { ok: true, latencyMs: x.e.health.latencyMs ?? 84, status: 200, credential, detail: x.e.isMock ? 'Mock environment (seeded data)' : `GET ${x.e.baseUrl}/health → 200` };
    },
    'environments.resetMock': () => null,
    'environments.testDraft': async (ctx) => {
      const b = await body<{ baseUrl: string; auth: UpstreamAuthIn }>(ctx);
      if (/unreachable|\.invalid/.test(b.baseUrl)) return { ok: false, latencyMs: null, credential: 'ok', detail: `${b.baseUrl} did not respond (timeout after 5 s).` };
      const hasSecret = 'secretRef' in b.auth || 'clientSecretRef' in b.auth;
      return { ok: true, latencyMs: 112, status: 200, credential: b.auth.type === 'none' ? 'not_required' : hasSecret ? 'ok' : 'missing', detail: `GET ${b.baseUrl} → 200` };
    },
    'writeSwitches.get': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      const writes = s.tools.filter((t) => t.write && toolVisible(s, t));
      return {
        environments: s.envs.map((e) => ({ id: e.id, slug: e.slug, kind: e.kind, writesEnabled: e.writes.enabled, confirm: e.writes.confirm, managedBy: e.managedBy })),
        tools: writes.map((t) => {
          const name = toolName(s, t);
          return { name, title: name.replaceAll('_', ' '), destructive: !!t.destructive, cells: Object.fromEntries(s.envs.map((e) => [e.slug, e.writes.enabledToolNames.includes(name)])) };
        }),
      };
    },

    /* ---------------------------------------------------------------- keys */
    'keys.list': (ctx) => {
      const sp = q(ctx);
      return page(db.keys.filter((k) => (!sp.get('serverId') || k.server.id === sp.get('serverId')) && (!sp.get('environmentId') || k.environment.id === sp.get('environmentId')) && (!sp.get('status') || k.status === sp.get('status'))), ctx);
    },
    'keys.create': async (ctx) => {
      const b = await body<{ name: string; serverId: string; environmentId: string; scopes?: ('tools:read' | 'tools:write' | 'code:run')[]; expiresInDays?: number | null }>(ctx);
      const s = db.servers.find((x) => x.seed.id === b.serverId);
      const env = s?.envs.find((e) => e.id === b.environmentId);
      if (!s || !env) return problem(422, 'validation_failed', 'Validation failed', 'Pick an environment of this server.', { errors: [{ path: ['environmentId'], message: 'Pick an environment of this server', code: 'invalid' }] });
      if (db.keys.some((k) => k.name === b.name && k.status === 'active')) return problem(409, 'conflict', 'Name taken', 'An active key already has this name.', { errors: [{ path: ['name'], message: 'An active key already has this name', code: 'taken' }] });
      const kid = Math.random().toString(16).slice(2, 10);
      const scopes = b.scopes?.length ? b.scopes : ['tools:read' as const];
      const row = {
        id: `key_${++db.seq}`, name: b.name, displayPrefix: `nrk_live_${kid}…`, server: sref(s), environment: { id: env.id, slug: env.slug, name: env.name, kind: env.kind }, scopes, profile: null, rateLimit: null,
        owner: { id: PEOPLE.maya.id, name: PEOPLE.maya.name }, expiresAt: b.expiresInDays === null ? null : iso(Date.now() + (b.expiresInDays ?? 90) * DAY), revokedAt: null, lastUsedAt: null, status: 'active' as const, createdAt: iso(Date.now()),
      };
      db.keys.unshift(row);
      const connect = await (fixtures['servers.connect'] as Resolver)({ params: { id: s.seed.id }, request: new Request(`http://mock/api/servers/${s.seed.id}/connect?environmentId=${env.id}`) });
      const warnings = scopes.includes('tools:write') && !env.writes.enabled ? [`Writes are off in ${env.slug}, so tools:write has no effect until you enable write tools there.`] : [];
      return HttpResponse.json({ key: row, token: `nrk_live_${kid}_k7Qm2xR9vTb4LpW8sN3cYh6Ej1Za5Ud0`, connect, warnings }, { status: 201 });
    },
    'keys.update': async (ctx) => {
      const k = db.keys.find((x) => x.id === p(ctx, 'id'));
      if (!k) return notFound('Key');
      const b = await body<{ name?: string }>(ctx);
      if (b.name) k.name = b.name;
      return k;
    },
    'keys.revoke': (ctx) => {
      const k = db.keys.find((x) => x.id === p(ctx, 'id'));
      if (!k) return notFound('Key');
      k.status = 'revoked';
      k.revokedAt = iso(Date.now());
      return k;
    },
    'oauthClients.list': (ctx) =>
      page(
        [
          { id: 'oc_claude', clientId: 'https://claude.ai/oauth/mcp-client', name: 'Claude Code', clientUri: 'https://claude.ai', logoUri: null, registrationType: 'cimd', redirectUris: ['claude-code://oauth/callback'], status: 'active', environments: [{ id: 'env_acme-orders_prod', slug: 'prod', name: 'PROD', serverSlug: 'acme-orders', kind: 'prod', activeTokens: 2 }], lastUsedAt: iso(Date.now() - 3 * MIN), createdAt: iso(Date.now() - 20 * DAY) },
          { id: 'oc_cursor', clientId: 'mcp-client-41af', name: 'Cursor', clientUri: null, logoUri: null, registrationType: 'dcr', redirectUris: ['cursor://anysphere.cursor-mcp/oauth/callback'], status: 'active', environments: [{ id: 'env_acme-orders_dev', slug: 'dev', name: 'DEV', serverSlug: 'acme-orders', kind: 'dev', activeTokens: 1 }], lastUsedAt: iso(Date.now() - 2 * HOUR), createdAt: iso(Date.now() - 12 * DAY) },
        ],
        ctx,
      ),
    'oauthClients.block': (ctx) => ({ id: p(ctx, 'id'), clientId: 'x', name: 'Client', clientUri: null, logoUri: null, registrationType: 'dcr', redirectUris: [], status: 'blocked', environments: [], lastUsedAt: null, createdAt: iso(Date.now()) }),
    'oauthClients.unblock': (ctx) => ({ id: p(ctx, 'id'), clientId: 'x', name: 'Client', clientUri: null, logoUri: null, registrationType: 'dcr', redirectUris: [], status: 'active', environments: [], lastUsedAt: null, createdAt: iso(Date.now()) }),
    'oauthGrants.list': () => ({ items: [{ id: 'og_1', user: { id: PEOPLE.jon.id, name: PEOPLE.jon.name, email: PEOPLE.jon.email }, client: { id: 'oc_claude', name: 'Claude Code' }, environment: { id: 'env_acme-orders_prod', slug: 'prod', name: 'PROD', serverSlug: 'acme-orders', kind: 'prod' }, scopes: ['mcp:tools', 'mcp:write'], lastUsedAt: iso(Date.now() - 3 * MIN), createdAt: iso(Date.now() - 9 * DAY) }] }),
    'oauthGrants.revoke': () => null,

    /* ---------------------------------------------------------------- tasks */
    'tasks.list': (ctx) => {
      const sp = q(ctx);
      const outcomes = sp.getAll('outcome');
      const term = sp.get('q')?.toLowerCase();
      const from = Date.parse(sp.get('from') ?? '') || 0;
      const to = Date.parse(sp.get('to') ?? '') || Infinity;
      const rows = db.tasks.filter((t) => {
        if (sp.get('serverId') && t.server.id !== sp.get('serverId')) return false;
        if (sp.get('environmentId') && t.environment.id !== sp.get('environmentId')) return false;
        if (sp.get('principal') && t.principal.id !== sp.get('principal')) return false;
        if (sp.get('client') && t.client.name !== sp.get('client')) return false;
        if (sp.get('status') && t.status !== sp.get('status')) return false;
        if (sp.get('hasErrors') === 'true' && !t.errorCount) return false;
        if (sp.get('hasWrites') === 'true' && !t.writeCount) return false;
        if (sp.getAll('framing').length && !sp.getAll('framing').includes(t.framing)) return false;
        if ((sp.get('origin') ?? 'agent') !== t.origin) return false;
        if (outcomes.length && !outcomes.includes(t.outcome ?? '') && !(outcomes.includes('inferred') && t.framing === 'inferred')) return false;
        if (term && !(t.goal ?? t.inferredLabel?.goal ?? '').toLowerCase().includes(term) && !t.id.includes(term)) return false;
        const st = Date.parse(t.startedAt);
        return st >= from && st <= to;
      });
      return page(rows, ctx);
    },
    'tasks.get': (ctx) => taskDetail(db, p(ctx, 'id')) ?? (p(ctx, 'id') === 'task_pruned' ? problem(410, 'gone', 'Removed by retention', 'This task is older than the 30-day retention and was removed.') : notFound('Task')),
    'tasks.events': (ctx) => {
      const d = taskDetail(db, p(ctx, 'id'));
      return d ? page(d.timeline, ctx, 200) : notFound('Task');
    },
    'calls.get': (ctx) => {
      if (!db.calls.has(p(ctx, 'auditId'))) auditRows(db);
      return db.calls.get(p(ctx, 'auditId')) ?? notFound('Call');
    },
    'scripts.get': (ctx) => db.scripts.get(p(ctx, 'id')) ?? notFound('Script run'),

    /* ---------------------------------------------------------------- inbox */
    'inbox.summary': (ctx) => {
      const sid = q(ctx).get('serverId');
      const needs = db.needGroups.filter((g) => !sid || g.server.id === sid);
      const issues = db.issues.filter((i) => !sid || i.server.id === sid);
      return { needs: { open: needs.filter((g) => g.status === 'open' || g.status === 'planned').length, new7d: 2 }, issues: { open: issues.filter((i) => i.status === 'open' || i.status === 'acknowledged').length, new7d: 1 } };
    },
    'inbox.list': (ctx) => {
      const name = q(ctx).get('toolName');
      return page(
        [
          ...db.issues.filter((i) => !name || i.tool === name).map((i) => ({ kind: 'issue' as const, id: i.id, title: i.problem, status: i.status, createdAt: i.createdAt })),
          ...db.needGroups.filter((g) => !name || g.attemptedTools.some((t) => t.tool === name)).map((g) => ({ kind: 'need' as const, id: g.id, title: g.label, status: g.status, createdAt: g.firstSeenAt, groupId: g.id })),
        ],
        ctx,
      );
    },
    'inbox.needGroups': (ctx) => {
      const sp = q(ctx);
      const statuses = sp.getAll('status');
      let rows = db.needGroups.filter((g) => (!sp.get('serverId') || g.server.id === sp.get('serverId')) && (!statuses.length || statuses.includes(g.status)));
      if (sp.get('q')) rows = rows.filter((g) => g.label.toLowerCase().includes(sp.get('q')!.toLowerCase()));
      rows = [...rows].sort((a, b) => (sp.get('sort') === 'recent' ? Date.parse(b.lastSeenAt) - Date.parse(a.lastSeenAt) : b.count - a.count));
      return page(rows.map(({ reports: _r, attemptedTools: _a, daily14: _d, ...row }) => row), ctx);
    },
    'inbox.needGroup': (ctx) => {
      const g = db.needGroups.find((x) => x.id === p(ctx, 'groupId'));
      if (!g) return notFound('Unmet-need group');
      const { reports, daily14, ...row } = g;
      const today = new Date();
      const daily = Array.from({ length: 30 }, (_, i) => {
        const d = new Date(today.getTime() - (29 - i) * DAY);
        return { day: d.toISOString().slice(0, 10), count: i >= 16 ? (daily14[i - 16] ?? 0) : 0 };
      });
      return { ...row, reports: { items: reports, nextCursor: null }, daily };
    },
    'inbox.triageNeedGroup': async (ctx) => {
      const g = db.needGroups.find((x) => x.id === p(ctx, 'groupId'));
      if (!g) return notFound('Unmet-need group');
      const b = await body<{ status?: typeof g.status; note?: string | null }>(ctx);
      if (b.status) g.status = b.status;
      if (b.note !== undefined) g.note = b.note;
      const { reports: _r, attemptedTools: _a, daily14: _d, ...row } = g;
      return row;
    },
    'inbox.mergeNeedGroups': async (ctx) => {
      const g = db.needGroups.find((x) => x.id === p(ctx, 'groupId'));
      const b = await body<{ intoGroupId: string }>(ctx);
      const target = db.needGroups.find((x) => x.id === b.intoGroupId);
      if (!g || !target) return notFound('Unmet-need group');
      target.count += g.count;
      target.reports.push(...g.reports.map((r) => ({ ...r, groupId: target.id })));
      db.needGroups = db.needGroups.filter((x) => x !== g);
      const { reports: _r, attemptedTools: _a, daily14: _d, ...row } = target;
      return row;
    },
    'inbox.splitNeed': (ctx) => {
      for (const g of db.needGroups) {
        const r = g.reports.find((x) => x.id === p(ctx, 'reportId'));
        if (!r) continue;
        g.reports = g.reports.filter((x) => x !== r);
        g.count--;
        const ng = { ...g, id: `need_split_${++db.seq}`, label: r.intent, count: 1, distinctPrincipals: 1, status: 'open' as const, note: null, sampleIntents: [r.intent], reports: [{ ...r }], firstSeenAt: r.createdAt, lastSeenAt: r.createdAt };
        db.needGroups.push(ng);
        const { reports: _r, attemptedTools: _a, daily14: _d, ...row } = ng;
        return row;
      }
      return notFound('Report');
    },
    'inbox.issues': (ctx) => {
      const sp = q(ctx);
      const statuses = sp.getAll('status');
      return page(db.issues.filter((i) => (!sp.get('serverId') || i.server.id === sp.get('serverId')) && (!statuses.length || statuses.includes(i.status)) && (!sp.get('tool') || i.tool === sp.get('tool'))).map(({ evidence: _e, note: _n, ...row }) => row), ctx);
    },
    'inbox.issue': (ctx) => {
      const i = db.issues.find((x) => x.id === p(ctx, 'id'));
      if (!i) return notFound('Issue');
      const task = i.taskId ? taskDetail(db, i.taskId) : null;
      const callId = task?.timeline.find((t) => t.kind === 'call')?.auditId;
      const call = callId ? db.calls.get(callId) : null;
      const failingCall = call ? { ...call, tool: i.tool, status: 'tool_error' as const, outputPreview: i.tool === 'get_order' ? { id: 'ORD-55120', total: '129.90', currency: 'EUR' } : { items: ['… 50 orders …'], next: 'cursor_p3' } } : null;
      let taskRow = null;
      if (task) {
        const { timeline: _t, notes: _n, traceId: _tr, truncated: _tc, unmetNeeds: _u, issues: _is, evalRunId: _e, ...rest } = task;
        taskRow = rest;
      }
      return { ...i, errorId: 'err_7f21aa', failingCall, task: taskRow };
    },
    'inbox.triageIssue': async (ctx) => {
      const i = db.issues.find((x) => x.id === p(ctx, 'id'));
      if (!i) return notFound('Issue');
      const b = await body<{ status?: typeof i.status; note?: string | null }>(ctx);
      if (b.status) i.status = b.status;
      if (b.note !== undefined) i.note = b.note;
      i.updatedAt = iso(Date.now());
      const { evidence: _e, note: _n, ...row } = i;
      return row;
    },
    'inbox.exportNeedMarkdown': (ctx) => {
      const g = db.needGroups.find((x) => x.id === p(ctx, 'groupId'));
      if (!g) return notFound('Unmet-need group');
      return {
        markdown: `## ${g.label}\n\n${g.count} reports from ${g.distinctPrincipals} agent keys (${g.server.name}).\n\n### Reports\n${g.reports.map((r) => `- “${r.intent}” (attempted: ${r.attempted.join(', ') || 'nothing'}), ${r.principal?.name ?? 'unknown'}`).join('\n')}\n\n### What agents tried\n${g.attemptedTools.map((t) => `- \`${t.tool}\` × ${t.count}`).join('\n')}\n`,
      };
    },
    'inbox.exportIssueMarkdown': (ctx) => {
      const i = db.issues.find((x) => x.id === p(ctx, 'id'));
      return i ? { markdown: `## ${i.problem}\n\nTool: \`${i.tool}\` · ${i.environment.slug}\n\n${i.evidence}\n` } : notFound('Issue');
    },

    /* ---------------------------------------------------------------- evals */
    'evals.suites': (ctx) => {
      const s = srv(ctx);
      if (!s) return notFound('Server');
      if (s.seed.id === 'srv_bluefin') return { items: [] };
      const lumen = s.seed.id === 'srv_lumen';
      return {
        items: [
          { id: `suite_${s.seed.slug}_2`, serverId: s.seed.id, version: 2, status: 'frozen', taskCount: lumen ? 30 : 40, byCategory: lumen ? { single: 12, multi: 10, ambiguous: 4, impossible: 4 } : { single: 16, multi: 12, ambiguous: 6, impossible: 6 }, generatedFromBuild: { id: `bld_${s.seed.slug}_1`, hash: 'a1b2c3' }, generator: { model: 'claude-sonnet-5-5', promptVersion: 'gen-2', seed: 7 }, createdAt: iso(Date.now() - 6 * DAY), frozenAt: iso(Date.now() - 5 * DAY) },
          { id: `suite_${s.seed.slug}_1`, serverId: s.seed.id, version: 1, status: 'draft', taskCount: 24, byCategory: { single: 8, multi: 8, ambiguous: 4, impossible: 4 }, generatedFromBuild: { id: `bld_${s.seed.slug}_1`, hash: 'a1b2c3' }, generator: { model: 'claude-sonnet-5-5', promptVersion: 'gen-2', seed: 3 }, createdAt: iso(Date.now() - 9 * DAY), frozenAt: null },
        ],
      };
    },
    'evals.generateSuite': () => ({ jobId: `job_suite_${++db.seq}`, status: 'queued' }),
    'evals.suite': (ctx) => ({
      id: p(ctx, 'id'), serverId: 'srv_acme_orders', version: 2, status: 'frozen', taskCount: EVAL_TASK_PROMPTS.length, byCategory: { single: 6, multi: 6, ambiguous: 3, impossible: 3 }, generatedFromBuild: null, generator: null, createdAt: iso(Date.now() - 6 * DAY), frozenAt: iso(Date.now() - 5 * DAY),
      tasks: EVAL_TASK_PROMPTS.map((t) => ({ id: `etask_${t.key}`, key: t.key, category: t.category, prompt: t.prompt, rubric: '', assertions: t.category === 'impossible' ? [{ type: 'unmet_need_reported_or_declined' }] : [{ type: 'called', tool: 'get_order' }, { type: 'max_calls', n: 8 }], referenceCalls: [], seedState: null, tags: [], enabled: true, source: 'generated' })),
      diagnostics: [],
    }),
    'evals.updateTask': () => problem(409, 'conflict', 'Suite frozen', 'Frozen suites cannot be edited.'),
    'evals.createTask': () => problem(409, 'conflict', 'Suite frozen', 'Frozen suites cannot be edited.'),
    'evals.freezeSuite': (ctx) => ({ id: p(ctx, 'id'), serverId: 'srv_acme_orders', version: 1, status: 'frozen', taskCount: 24, byCategory: { single: 8, multi: 8, ambiguous: 4, impossible: 4 }, generatedFromBuild: null, generator: null, createdAt: iso(Date.now() - 9 * DAY), frozenAt: iso(Date.now()) }),
    'evals.runs': (ctx) => {
      const sp = q(ctx);
      const statuses = sp.getAll('status');
      return page(runRows(sp.get('serverId')).filter((r) => !statuses.length || statuses.includes(r.status)), ctx);
    },
    'evals.createRun': async (ctx) => {
      const b = await body<{ serverId: string; environmentId?: string; models?: string[]; modes?: ('tool' | 'code')[]; repeats?: number; preset?: 'quick' }>(ctx);
      const s = db.servers.find((x) => x.seed.id === b.serverId);
      if (!s) return problem(422, 'validation_failed', 'Validation failed', 'Unknown server.');
      if (!Object.values(db.settings.keys).some((k) => k.configured)) return problem(412, 'llm_key_missing', 'Model provider key missing', 'Add an OpenAI, Anthropic or Gemini API key in Settings › Models to run evals.');
      if (db.runs.some((r) => r.row.server.id === s.seed.id && (tickRun(db, r), r.row.status === 'running'))) return problem(409, 'job_running', 'A run is already in progress', 'One eval run per server at a time. Wait for it to finish or cancel it.');
      const env = s.envs.find((e) => e.id === b.environmentId) ?? s.envs.find((e) => e.isMock)!;
      if (env.kind === 'prod') return problem(422, 'validation_failed', 'Evals never run against prod', 'Pick the mock, dev or qa environment.');
      const quick = b.preset === 'quick';
      const models = quick ? [db.settings.evalModel] : b.models?.length ? b.models : [db.settings.evalModel];
      const modes = quick ? (['tool', 'code'] as const) : b.modes?.length ? b.modes : (['tool', 'code'] as const);
      const repeats = quick ? 1 : (b.repeats ?? 3);
      const taskCount = quick ? 12 : 40;
      const number = db.nextRunNumber++;
      const prevRun = runRows(s.seed.id).find((r) => r.status === 'succeeded');
      const matrix = matrixFrom({ matrix: Object.fromEntries(models.map((m) => [m, { tool: modes.includes('tool') ? [quick ? 0.5 : 0.89, quick ? 6.8 : 2.9, quick ? 9400 : 4000] : null, code: modes.includes('code') ? [quick ? 0.75 : 0.94, 1.0, quick ? 3600 : 2600] : null }])) as (typeof RUNS)[number]['matrix'] });
      const run: RunState = {
        number,
        row: {
          id: `run_${number}`, server: sref(s), suite: { id: `suite_${s.seed.slug}_${quick ? 'quick' : '2'}`, version: quick ? 1 : 2 }, environment: { id: env.id, slug: env.slug, name: env.name },
          build: { id: `bld_${s.seed.slug}_${s.versions[0]?.rev ?? 1}`, hash: 'h' }, overlayRev: s.versions[0]?.rev ?? 1, temporaryBuild: false, models, modes: [...modes], repeats, status: 'running',
          progress: { done: 0, total: taskCount * models.length * modes.length * repeats }, headline: null, recommendedMode: null, confidence: null, trigger: 'console', baseRunId: prevRun?.id ?? null, error: null,
          createdAt: iso(Date.now()), startedAt: iso(Date.now()), endedAt: null, usage: {},
        },
        matrix, breakdown: (quick ? ACME_BASELINE_BREAKDOWN : ACME_BREAKDOWN).map((x) => ({ ...x })) as ReadinessComponent[], startedMs: Date.now(), durationMs: quick ? 9_000 : 15_000, finalScore: quick ? 52 : s.seed.id === 'srv_acme_orders' ? 89 : 77,
        recommendation: 'Use both modes: code mode is +18 pts and −62% tokens on multi-step tasks; tool mode is better for single lookups.',
      };
      db.runs.unshift(run);
      return HttpResponse.json(run.row, { status: 202 });
    },
    'evals.compare': (ctx) => {
      const base = runOf(q(ctx).get('base') ?? '');
      const head = runOf(q(ctx).get('head') ?? '');
      if (!base || !head) return notFound('Eval run');
      if (base.row.server.id !== head.row.server.id) return problem(422, 'validation_failed', 'Different servers', 'Both runs must belong to the same server.');
      const bt = taskResults(base);
      const ht = taskResults(head);
      const best = (row: (typeof bt)[number]) => `${row.cells.reduce((a, c) => Math.max(a, c.passes), 0)}/${base.row.repeats}`;
      const launch = base.number === 14 && head.number === 18;
      const flipped = new Set(['t07', 't08', 't02', 't09', 't16', 't10', 't11', 't12', 't13', 't14', 't15', 't17', 't18', 't03']);
      const tasks = bt.map((b, i) => ({
        taskKey: b.key, category: b.category,
        base: launch ? (flipped.has(b.key) ? '0/3' : '3/3') : best(b),
        head: launch ? (b.key === 't01' ? '1/3' : '3/3') : ht[i] ? best(ht[i]!) : null,
      }));
      const avg = (r: RunState, f: (c: RunState['matrix'][number]) => number, mode?: string) => {
        const cells = r.matrix.filter((c) => !mode || c.mode === mode);
        return cells.reduce((a, c) => a + f(c), 0) / Math.max(1, cells.length);
      };
      return {
        base: base.row, head: head.row, scoreDelta: head.finalScore - base.finalScore,
        components: base.breakdown.map((c) => ({ key: c.key, label: c.label, base: c.score, head: head.breakdown.find((x) => x.key === c.key)?.score ?? null })),
        matrix: head.matrix.map((c) => ({ model: c.model, mode: c.mode, base: base.matrix.find((x) => x.model === c.model && x.mode === c.mode) ?? null, head: c })),
        tasks, tokensDelta: launch ? -0.62 : (avg(head, (c) => c.avgTokens) - avg(base, (c) => c.avgTokens)) / Math.max(1, avg(base, (c) => c.avgTokens)),
        callsDelta: launch ? 2.4 - 7.1 : avg(head, (c) => c.avgCalls) - avg(base, (c) => c.avgCalls, 'tool'),
      };
    },
    'evals.run': (ctx) => {
      const r = runOf(p(ctx, 'id'));
      if (!r) return notFound('Eval run');
      tickRun(db, r);
      const done = r.row.status === 'succeeded';
      const score = done
        ? { headline: r.finalScore, band: readinessBand(r.finalScore), confidence: 'measured' as const, recommendedMode: r.row.recommendedMode, recommendation: r.recommendation, primaryModel: r.row.models[0] ?? 'claude-sonnet-5-5',
            modeScores: { tool: Math.round((r.matrix.filter((c) => c.mode === 'tool').reduce((a, c) => a + c.successRate, 0) / Math.max(1, r.matrix.filter((c) => c.mode === 'tool').length)) * 100) || undefined, code: Math.round((r.matrix.filter((c) => c.mode === 'code').reduce((a, c) => a + c.successRate, 0) / Math.max(1, r.matrix.filter((c) => c.mode === 'code').length)) * 100) || undefined },
            breakdown: r.breakdown, cells: r.matrix.map((c) => ({ model: c.model, mode: c.mode, score: c.score, components: r.breakdown })) }
        : null;
      return { ...r.row, score, matrix: done ? r.matrix : [], tasks: done ? taskResults(r) : [], suggestionsCount: db.suggestions.filter((x) => x.runId === r.row.id).length, correctness: null };
    },
    'evals.runTasks': (ctx) => {
      const r = runOf(p(ctx, 'id'));
      return r ? page(taskResults(r), ctx) : notFound('Eval run');
    },
    'evals.taskRun': (ctx) => {
      const r = runOf(p(ctx, 'id'));
      if (!r) return notFound('Eval run');
      const [, , key, model, mode] = p(ctx, 'taskRunId').split('.');
      const rows = taskResults(r);
      const t = rows.find((x) => x.key === key) ?? rows[0]!;
      const cell = t.cells.find((c) => c.model === model && c.mode === mode) ?? t.cells[0]!;
      const passed = cell.passes > 0;
      const task = { id: t.taskId, key: t.key, category: t.category, prompt: t.prompt, rubric: 'The final state matches and no forbidden call was made.', assertions: [{ type: 'called' as const, tool: 'get_order' }, { type: 'not_called' as const, tool: 'cancel_order' }, { type: 'max_calls' as const, n: 8 }], referenceCalls: [{ tool: 'get_order', arguments: { id: 'ORD-55120' } }], seedState: null, tags: [], enabled: true, source: 'generated' as const };
      return {
        id: p(ctx, 'taskRunId'), runId: r.row.id, task, model: cell.model, mode: cell.mode, attempt: 1, passed,
        assertionResults: [{ assertion: task.assertions[0]!, passed: true, detail: 'called once' }, { assertion: task.assertions[1]!, passed: true, detail: 'not called' }, { assertion: task.assertions[2]!, passed, detail: passed ? `${Math.round(cell.avgCalls)} calls` : '11 calls (budget 8)' }],
        judge: t.category === 'ambiguous' ? { score: passed ? 0.9 : 0.3, verdict: passed ? 'pass' : 'fail', reasons: [passed ? 'Asked which Maya before acting.' : 'Picked the first match without asking.'] } : null,
        failureCause: cell.failureCause, toolCalls: Math.round(cell.avgCalls), scripts: cell.mode === 'code' ? 1 : 0, tokens: { inputTokens: cell.avgTokens, outputTokens: Math.round(cell.avgTokens / 8) }, latencyMs: 8400, servedByModel: cell.model, fallbackUsed: false,
        neurouterTaskId: 'task_flag_unpaid', finalAnswer: passed ? 'Done.' : 'I could not complete this.',
        transcript: [{ type: 'user', text: t.prompt }, { type: 'tool_call', id: 'c1', tool: 'get_order', arguments: { id: 'ORD-55120' } }, { type: 'tool_result', id: 'c1', tool: 'get_order', isError: false, content: '{"id":"ORD-55120","status":"unpaid"}' }, { type: 'assistant', text: passed ? 'Done.' : 'I could not complete this.' }],
        createdAt: r.row.endedAt ?? iso(Date.now()),
      };
    },
    'evals.cancelRun': (ctx) => {
      const r = runOf(p(ctx, 'id'));
      if (!r) return notFound('Eval run');
      r.row.status = 'cancelled';
      r.row.endedAt = iso(Date.now());
      return r.row;
    },
    'readiness.get': (ctx) => {
      const s = srv(ctx);
      return s ? readinessFor(db, s.seed.id) : notFound('Server');
    },
    'suggestions.list': (ctx) => {
      tickSuggestions(db);
      return { items: db.suggestions.filter((x) => x.runId === p(ctx, 'id')).map(stripSug) };
    },
    'suggestions.search': (ctx) => {
      tickSuggestions(db);
      const sp = q(ctx);
      const name = sp.get('toolName');
      const statuses = sp.getAll('status');
      return page(db.suggestions.filter((x) => (!sp.get('serverId') || x.serverId === sp.get('serverId')) && (!name || x.tools.includes(name)) && (!statuses.length || statuses.includes(x.status))).map(stripSug), ctx);
    },
    'suggestions.get': (ctx) => {
      tickSuggestions(db);
      const sg = db.suggestions.find((x) => x.id === p(ctx, 'id'));
      if (!sg) return notFound('Suggestion');
      const run = runOf(sg.runId)!;
      return { ...stripSug(sg), verifyRun: null, affectedTasks: taskResults(run).filter((t) => sg.affectedTaskKeys.includes(t.key)) };
    },
    'suggestions.verify': (ctx) => {
      const sg = db.suggestions.find((x) => x.id === p(ctx, 'id'));
      if (!sg) return notFound('Suggestion');
      sg.status = 'verifying';
      sg.verifyStartedMs = Date.now();
      sg.verifyRunId = `run_verify_${sg.id}`;
      tickSuggestions(db);
      return HttpResponse.json(stripSug(sg), { status: 202 });
    },
    'suggestions.apply': async (ctx) => {
      const sg = db.suggestions.find((x) => x.id === p(ctx, 'id'));
      if (!sg) return notFound('Suggestion');
      const s = db.servers.find((x) => x.seed.id === sg.serverId) ?? db.servers[0]!;
      const b = await body<{ mode?: 'draft' | 'publish'; message?: string }>(ctx);
      if (sg.ops.length) {
        const err = applyOps(s, sg.ops.map((o) => ({ op: 'set' as const, selector: o.selector, field: o.field, value: o.value })));
        if (err) return err;
      }
      sg.status = 'applied';
      sg.updatedAt = iso(Date.now());
      if (b.mode === 'publish') return { suggestion: stripSug(sg), publish: publish(s, b.message ?? `Apply fix: ${sg.title}`, undefined, 'suggestion') };
      return { suggestion: stripSug(sg), draft: draftOf(s) };
    },
    'suggestions.dismiss': (ctx) => {
      const sg = db.suggestions.find((x) => x.id === p(ctx, 'id'));
      if (!sg) return notFound('Suggestion');
      sg.status = 'dismissed';
      return stripSug(sg);
    },

    /* ---------------------------------------------------------------- audit */
    'audit.list': (ctx) => {
      const sp = q(ctx);
      const decisions = sp.getAll('decision');
      const kinds = sp.getAll('kind');
      const statuses = sp.getAll('status');
      const term = sp.get('q')?.toLowerCase();
      const from = Date.parse(sp.get('from') ?? '') || 0;
      const rows = auditRows(db).filter((r) => {
        if (sp.get('serverId') && r.server?.id !== sp.get('serverId')) return false;
        if (sp.get('environmentId') && r.environment?.id !== sp.get('environmentId')) return false;
        if (decisions.length && !decisions.includes(r.decision)) return false;
        if (kinds.length && !kinds.includes(r.kind)) return false;
        if (statuses.length && !statuses.includes(r.status)) return false;
        if (sp.get('via') && r.via !== sp.get('via')) return false;
        if (sp.get('tool') && r.tool !== sp.get('tool')) return false;
        if (sp.get('taskId') && r.taskId !== sp.get('taskId')) return false;
        if (Date.parse(r.ts) < from) return false;
        if (term && !`${r.tool ?? ''} ${r.action ?? ''} ${r.decisionReason ?? ''} ${r.principal?.name ?? ''}`.toLowerCase().includes(term)) return false;
        return true;
      });
      return page(rows, ctx);
    },
    'audit.export': () => new HttpResponse('ts,principal,tool,decision,status\n', { headers: { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="neurouter-audit.csv"' } }),
    'audit.verify': () => HttpResponse.json({ jobId: 'job_audit_verify', status: 'running' }, { status: 202 }),
    'audit.get': (ctx) => {
      const row = auditRows(db).find((r) => r.id === p(ctx, 'id'));
      if (!row) return notFound('Audit event');
      const call = db.calls.get(row.id);
      return {
        ...row, params: call?.arguments ?? null, outputPreview: call?.outputPreview ?? null, outputSize: call?.outputSize ?? null, outputHash: call?.outputHash ?? null, upstreamStatus: call?.upstreamStatus ?? null, upstreamLatencyMs: call?.upstreamLatencyMs ?? null,
        policyTrail: call?.policyTrail ?? [], changes: row.kind === 'admin_action' ? { before: { enabled: false }, after: { enabled: true } } : null, target: row.action ? { type: row.action.split('.')[0]!, id: row.server?.id ?? '' } : null,
        ip: row.kind === 'admin_action' ? '10.20.4.17' : null, userAgent: row.client?.name ?? null, spanId: call?.spanId ?? null, protocolVersion: call ? '2025-11-25' : null, chain: { seq: row.seq, prevHash: 'a91f0c2e7d4b9c11', hash: '3be04d61f2a8e090' },
      };
    },

    /* ---------------------------------------------------------------- settings */
    'settings.get': () => settingsView(db),
    'settings.update': async (ctx) => {
      const b = await body<{ general?: { orgName?: string }; models?: Record<string, unknown>; codeMode?: { enabled?: boolean }; retention?: { auditDays?: number; taskDays?: number }; audit?: { storeOutputs?: boolean } }>(ctx);
      const writes = { ...((b.models?.apiKeys ?? {}) as Record<string, { value?: string; clear?: boolean }>), ...(b.models?.anthropicKey ? { anthropic: b.models.anthropicKey as { value?: string; clear?: boolean } } : {}) };
      for (const [kind, k] of Object.entries(writes)) if (kind === 'openai' || kind === 'anthropic' || kind === 'gemini') db.settings.keys[kind] = k.clear ? { configured: false, source: null, last4: null } : { configured: true, source: 'stored', last4: (k.value ?? '').slice(-4) };
      for (const key of ['evalModel', 'judgeModel', 'generatorModel', 'effort', 'fallbacks'] as const) if (b.models?.[key] !== undefined) (db.settings as Record<string, unknown>)[key] = b.models[key];
      if (b.codeMode?.enabled !== undefined) db.settings.codeModeEnabled = b.codeMode.enabled;
      if (b.retention?.auditDays) db.settings.auditDays = b.retention.auditDays;
      if (b.retention?.taskDays) db.settings.taskDays = b.retention.taskDays;
      if (b.audit?.storeOutputs !== undefined) db.settings.storeOutputs = b.audit.storeOutputs;
      if (b.general?.orgName) db.settings.orgName = b.general.orgName;
      return settingsView(db);
    },
    'settings.testModel': () => {
      const kind = providerForModel(db.settings.evalModel);
      return kind && db.settings.keys[kind].configured ? { ok: true, model: db.settings.evalModel, latencyMs: 640 } : problem(412, 'llm_key_missing', 'Model provider key missing', 'Add a key for the eval model provider first.');
    },
    'modelProviders.list': () => ({ items: mockProviders(db) }),
    'modelProviders.create': () => problem(409, 'conflict', 'Provider exists', 'One provider per kind. Update the existing one.'),
    'modelProviders.update': (ctx) => mockProviders(db).find((x) => x.id === p(ctx, 'id')) ?? problem(404, 'not_found', 'Not found', 'No such model provider.'),
    'modelProviders.delete': () => null,
    'modelProviders.test': (ctx) => {
      const mp = mockProviders(db).find((x) => x.id === p(ctx, 'id'));
      return mp ? { ok: true, model: mp.defaultModel, latencyMs: 640 } : problem(404, 'not_found', 'Not found', 'No such model provider.');
    },
    'telemetry.test': () => ({ ok: true, otlpEndpoint: 'http://otel-collector:4318', detail: 'Sent 1 span and 1 log record.' }),
    'killSwitches.list': () => ({ items: db.killSwitches }),
    'killSwitches.set': async (ctx) => {
      const b = await body<{ scope: 'global' | 'server' | 'environment' | 'tool'; target: string; kind: 'all' | 'writes' | 'code_mode'; reason: string }>(ctx);
      const row = { ...b, createdBy: { id: PEOPLE.maya.id, name: PEOPLE.maya.name }, createdAt: iso(Date.now()) };
      db.killSwitches.push(row);
      return row;
    },
    'killSwitches.clear': (ctx) => {
      const sp = q(ctx);
      db.killSwitches = db.killSwitches.filter((k) => !(k.scope === sp.get('scope') && k.kind === sp.get('kind') && k.target === sp.get('target')));
      return null;
    },
    'config.status': { mode: 'hybrid', path: '/etc/neurouter/neurouter.yaml', hash: 'b41c09e2', appliedAt: iso(Date.now() - 2 * HOUR), status: 'ok', diagnostics: [{ severity: 'info', code: 'unused_secret', message: 'Secret ACME_LEGACY_TOKEN is defined but not used', line: 12 }], managed: { servers: 1, environments: 2 } },
    'config.reload': () => ({ mode: 'hybrid', path: '/etc/neurouter/neurouter.yaml', hash: 'b41c09e2', appliedAt: iso(Date.now()), status: 'ok', diagnostics: [], managed: { servers: 1, environments: 2 } }),
    'config.export': () => new HttpResponse('# neurouter.yaml (effective, secrets as refs)\nservers: []\n', { headers: { 'content-type': 'text/yaml' } }),
    'config.validate': () => ({ ok: true, diagnostics: [] }),
    'system.info': { version: INSTANCE.version, commit: '3f2a9c1', nodeVersion: 'v24.11.0', db: { dialect: 'sqlite', version: '3.51.0' }, executor: { mode: 'embedded', ok: true, montyVersion: '0.4.2', poolMax: 8, busy: 1, detail: null }, embedder: { status: 'ready', model: 'local-minilm' }, coordination: 'memory', instanceId: 'nr-acme-01', publicUrl: 'https://mcp.acme.test', protocolVersions: ['2025-11-25', '2025-06-18'] },
    'users.list': (ctx) => page(db.users, ctx),
    'users.update': async (ctx) => {
      const u = db.users.find((x) => x.id === p(ctx, 'id'));
      if (!u) return notFound('User');
      const b = await body<{ role?: 'admin' | 'viewer' }>(ctx);
      if (b.role === 'viewer' && u.role === 'admin' && db.users.filter((x) => x.role === 'admin').length === 1) return problem(409, 'conflict', 'Last admin', 'The last admin cannot be demoted.');
      if (b.role) u.role = b.role;
      return u;
    },
    'jobs.get': (ctx) => {
      const id = p(ctx, 'id');
      if (id === 'job_audit_verify') return { id, kind: 'audit_verify', status: 'succeeded', progress: 1, result: { ok: true, checked: 18_442, fromSeq: 1, toSeq: 18_442, checkpointsVerified: 18, firstBrokenSeq: null, reason: null }, error: null, problem: null, createdAt: iso(Date.now() - 2000), finishedAt: iso(Date.now()) };
      const pv = id.startsWith('job_pv_') ? previewState(db, id.slice(4)) : null;
      return { id, kind: pv ? 'spec_preview' : 'spec_reimport', status: pv && pv.status !== 'ready' ? 'running' : 'succeeded', progress: 1, result: pv ? { previewId: pv.id } : null, error: null, problem: null, createdAt: iso(Date.now() - MIN), finishedAt: iso(Date.now()) };
    },
    'public.report': (ctx) => {
      const s = db.servers.find((x) => x.seed.slug === p(ctx, 'slug'));
      if (!s || !s.publicReport) return notFound('Report');
      const r = readinessFor(db, s.seed.id);
      return { server: { name: s.name, slug: s.seed.slug, description: s.description }, score: r.score, band: r.band, confidence: r.confidence, recommendedMode: r.recommendedMode, modeScores: r.modeScores, models: MODELS.map((m) => ({ model: m, toolScore: 80, codeScore: 90 })), measuredAt: r.measuredAt ?? iso(Date.now()), specTitle: s.seed.specTitle, toolCount: visibleCount(s) };
    },
  };
  return fixtures;
}

/* ================================================================== simulator hooks */

/** Adds a live (in-progress) task, used by the demo simulator. */
export function addLiveTask(db: MockDb, idx: number) {
  const row = generateTask(db, 10_000 + idx, Date.now(), { open: true, seed: idx * 104729 + 7 });
  db.tasks.unshift(row);
  return row;
}

export function closeTask(db: MockDb, id: string): void {
  const t = db.tasks.find((x) => x.id === id);
  if (!t || t.status !== 'open') return;
  t.status = 'closed';
  t.outcome = Math.random() < 0.75 ? 'success' : 'partial';
  t.endedAt = iso(Date.now());
  t.durationMs = Date.now() - Date.parse(t.startedAt);
  db.taskDetails.delete(id);
}

export function addUnmetNeedReport(db: MockDb): void {
  const g = db.needGroups[Math.floor(Math.random() * db.needGroups.length)]!;
  g.count++;
  g.lastSeenAt = iso(Date.now());
  g.daily14[g.daily14.length - 1] = (g.daily14[g.daily14.length - 1] ?? 0) + 1;
}

export { createDb };
