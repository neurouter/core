import { readFileSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { stringify } from 'yaml';
import { api, DEFAULT_CODE_LIMITS, DEFAULT_EVAL_MODEL, SUPPORTED_PROTOCOL_VERSIONS, type ModelProvider, type Settings } from '@neurouter/shared';
import type { CommittedAuditRow } from '../../../kernel/audit/writer.js';
import { pingDatabase } from '../../../kernel/db/index.js';
import { toIso, toIsoOrNull } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { KILL_CHANGED, type UpstreamAuthDescriptor } from '../../../kernel/runtime-config.js';
import { requireUser } from '../../auth/guards.js';
import { parseConfigYaml } from '../../config-sync/reconcile.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';

export const ANTHROPIC_SECRET = { owner: 'settings' as const, ownerId: 'anthropic', name: 'api_key' };
export const ENV_PROVIDER_ID = 'anthropic-env';
export const STORED_PROVIDER_ID = 'anthropic-stored';
const MODELS = ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5'];

/** The Anthropic key the evals use (env wins over the stored, encrypted key) — for the eval workstream too. */
export async function anthropicKey(c: Pick<ApiContext, 'config' | 'settings' | 'namedSecrets' | 'tenantId'>): Promise<{ key: string; source: 'env' | 'stored' } | null> {
  if (c.config.env.ANTHROPIC_API_KEY) return { key: c.config.env.ANTHROPIC_API_KEY, source: 'env' };
  if (!(await c.settings.get('anthropicKeySecretId'))) return null;
  const v = await c.namedSecrets.get(c.tenantId, ANTHROPIC_SECRET.owner, ANTHROPIC_SECRET.ownerId, ANTHROPIC_SECRET.name);
  return v ? { key: v, source: 'stored' } : null;
}

/** Dotted Settings keys set by neurouter.yaml (read-only in the console). */
function fileManagedSettings(c: ApiContext): string[] {
  const path = c.config.env.NEUROUTER_CONFIG;
  if (!path || c.config.configMode === 'console') return [];
  try {
    const p = parseConfigYaml(readFileSync(path, 'utf8'), path);
    const st = p.config?.settings;
    const out: string[] = [];
    if (p.config?.instance?.name) out.push('general.orgName');
    if (st?.codeMode) out.push('codeMode.enabled');
    if (st?.retentionDays) out.push('general.retentionDays');
    if (st?.evals?.model) out.push('models.evalModel');
    if (st?.evals?.judgeModel) out.push('models.judgeModel');
    if (st?.evals?.generatorModel) out.push('models.generatorModel');
    if (st?.evals?.effort) out.push('models.effort');
    if (st?.evals?.fallbacks) out.push('models.fallbacks');
    if (st?.evals?.apiKey) out.push('models.anthropicKey');
    if (st?.discovery) out.push('discovery.nativeSearchClients');
    if (st?.tasks) out.push('models.labelInferredTasks');
    if (st?.audit) out.push('audit.storeOutputs');
    return out;
  } catch {
    return [];
  }
}

async function settingsView(c: ApiContext): Promise<Settings> {
  const s = c.settings;
  const key = await anthropicKey(c);
  const evalModel = (await s.get('evalModel')) ?? c.config.env.NEUROUTER_EVAL_MODEL;
  return {
    general: { orgName: (await s.get('orgName')) ?? c.config.env.ORG_NAME, publicUrl: c.config.publicUrl, retentionDays: (await s.get('retentionDays')) ?? c.config.env.NEUROUTER_RETENTION_DAYS },
    models: {
      anthropicKey: { configured: Boolean(key), source: key?.source ?? null, last4: key ? (key.source === 'env' ? key.key.slice(-4) : await s.get('anthropicKeyLast4')) : null },
      evalModel,
      judgeModel: (await s.get('judgeModel')) ?? evalModel,
      generatorModel: (await s.get('generatorModel')) ?? evalModel,
      effort: await s.get('evalEffort'),
      fallbacks: await s.get('evalFallbacks'),
      labelInferredTasks: await s.get('labelInferredTasks'),
    },
    codeMode: { enabled: await s.get('codeModeEnabled'), executor: c.ports.executorStatus(), defaults: DEFAULT_CODE_LIMITS },
    retention: { auditDays: await s.get('auditRetentionDays'), taskDays: (await s.get('retentionDays')) ?? c.config.env.NEUROUTER_RETENTION_DAYS },
    telemetry: { otelEnabled: !c.config.env.OTEL_SDK_DISABLED, metricsEnabled: c.config.env.METRICS_ENABLED, otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null },
    discovery: { nativeSearchClients: await s.get('nativeSearchClients') },
    audit: { storeOutputs: await s.get('auditStoreFullOutput') },
    fileManaged: fileManagedSettings(c),
  };
}

async function providers(c: ApiContext): Promise<ModelProvider[]> {
  const s = c.settings;
  const last = await s.get('modelProviderLastTest');
  const defaultModel = (await s.get('evalModel')) ?? c.config.env.NEUROUTER_EVAL_MODEL;
  const base = { kind: 'anthropic' as const, defaultModel, models: MODELS.includes(defaultModel) ? MODELS : [defaultModel, ...MODELS], lastTestAt: last ? toIso(last.at) : null, lastTestOk: last ? last.ok : null };
  const out: ModelProvider[] = [];
  if (c.config.env.ANTHROPIC_API_KEY) out.push({ ...base, id: ENV_PROVIDER_ID, name: 'Anthropic (ANTHROPIC_API_KEY)', keySource: 'env', keyLast4: c.config.env.ANTHROPIC_API_KEY.slice(-4), isDefault: true });
  if (await s.get('anthropicKeySecretId')) out.push({ ...base, id: STORED_PROVIDER_ID, name: await s.get('modelProviderName'), keySource: 'stored', keyLast4: await s.get('anthropicKeyLast4'), isDefault: !c.config.env.ANTHROPIC_API_KEY });
  return out;
}

async function storeKey(c: ApiContext, value: string, by: string): Promise<void> {
  await c.namedSecrets.set(c.tenantId, ANTHROPIC_SECRET.owner, ANTHROPIC_SECRET.ownerId, ANTHROPIC_SECRET.name, value, by);
  await c.settings.set('anthropicKeySecretId', `${ANTHROPIC_SECRET.owner}:${ANTHROPIC_SECRET.ownerId}`, by);
  await c.settings.set('anthropicKeyLast4', value.slice(-4), by);
}

async function clearKey(c: ApiContext, by: string): Promise<void> {
  await c.namedSecrets.delete(c.tenantId, ANTHROPIC_SECRET.owner, ANTHROPIC_SECRET.ownerId, ANTHROPIC_SECRET.name);
  await c.settings.set('anthropicKeySecretId', null, by);
  await c.settings.set('anthropicKeyLast4', null, by);
}

/** One tiny Messages call with the configured key (never in tests: the key is absent there). */
async function testModel(c: ApiContext): Promise<{ ok: boolean; model: string; latencyMs: number | null; error?: string }> {
  const key = await anthropicKey(c);
  const model = (await c.settings.get('evalModel')) ?? c.config.env.NEUROUTER_EVAL_MODEL;
  if (!key) throw new AppError('llm_key_missing', 'Configure an Anthropic API key first (ANTHROPIC_API_KEY or Settings → Models)');
  if (c.config.env.NODE_ENV === 'test') return { ok: false, model, latencyMs: null, error: 'model tests are disabled when NODE_ENV=test' };
  const t0 = c.clock.now();
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key.key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }), signal: AbortSignal.timeout(20_000) });
    const ok = res.ok;
    await c.settings.set('modelProviderLastTest', { at: c.clock.now(), ok });
    return { ok, model, latencyMs: c.clock.now() - t0, ...(ok ? {} : { error: `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}` }) };
  } catch (err) {
    await c.settings.set('modelProviderLastTest', { at: c.clock.now(), ok: false });
    return { ok: false, model, latencyMs: null, error: (err as Error).message };
  }
}

/** settings, modelProviders, telemetry, killSwitches, config, system, users, jobs, events (§14.13, §14.15). */
export async function settingsRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;

  route(app, 'settings.get', api.settings.get, async () => settingsView(c));

  route(app, 'settings.update', api.settings.update, async (req) => {
    const u = requireUser(req);
    const b = req.body;
    const fm = new Set(fileManagedSettings(c));
    const touched: string[] = [];
    for (const [section, obj] of Object.entries(b)) for (const k of Object.keys(obj ?? {})) touched.push(`${section}.${k}`);
    const managed = touched.filter((t) => fm.has(t));
    if (managed.length) throw new AppError('config_managed', `${managed.join(', ')} ${managed.length > 1 ? 'are' : 'is'} set in neurouter.yaml`, { extensions: { configPath: c.config.env.NEUROUTER_CONFIG ?? 'neurouter.yaml', configLine: null } });
    const s = c.settings;
    if (b.general?.orgName !== undefined) await s.set('orgName', b.general.orgName, u.id);
    if (b.general?.retentionDays !== undefined) await s.set('retentionDays', b.general.retentionDays, u.id);
    if (b.models) {
      const m = b.models;
      if (m.anthropicKey) {
        if ('value' in m.anthropicKey) await storeKey(c, m.anthropicKey.value, u.id);
        else await clearKey(c, u.id);
      }
      if (m.evalModel) await s.set('evalModel', m.evalModel, u.id);
      if (m.judgeModel) await s.set('judgeModel', m.judgeModel, u.id);
      if (m.generatorModel) await s.set('generatorModel', m.generatorModel, u.id);
      if (m.effort) await s.set('evalEffort', m.effort, u.id);
      if (m.fallbacks) await s.set('evalFallbacks', m.fallbacks, u.id);
      if (m.labelInferredTasks !== undefined) await s.set('labelInferredTasks', m.labelInferredTasks, u.id);
    }
    if (b.codeMode?.enabled !== undefined) {
      await s.set('codeModeEnabled', b.codeMode.enabled, u.id);
      c.runtime.invalidate();
      await c.coord.publish(KILL_CHANGED, {});
    }
    if (b.codeMode?.defaults) await s.set('codeLimitsCap', { ...(await s.get('codeLimitsCap')), ...b.codeMode.defaults }, u.id);
    if (b.retention?.auditDays !== undefined) await s.set('auditRetentionDays', b.retention.auditDays, u.id);
    if (b.retention?.taskDays !== undefined) await s.set('retentionDays', b.retention.taskDays, u.id);
    if (b.discovery?.nativeSearchClients) await s.set('nativeSearchClients', b.discovery.nativeSearchClients, u.id);
    if (b.audit?.storeOutputs !== undefined) await s.set('auditStoreFullOutput', b.audit.storeOutputs, u.id);
    return settingsView(c);
  });

  route(app, 'settings.testModel', api.settings.testModel, async () => testModel(c));

  route(app, 'modelProviders.list', api.modelProviders.list, async () => ({ items: await providers(c) }));
  route(app, 'modelProviders.create', api.modelProviders.create, async (req, reply) => {
    const u = requireUser(req);
    if ((await providers(c)).length) throw AppError.conflict('An Anthropic provider is already configured (the MVP allows one)');
    await storeKey(c, req.body.apiKey, u.id);
    await c.settings.set('modelProviderName', req.body.name, u.id);
    await c.settings.set('evalModel', req.body.defaultModel, u.id);
    reply.status(201);
    return (await providers(c)).find((p) => p.id === STORED_PROVIDER_ID)!;
  });
  const providerOr404 = async (id: string) => {
    const p = (await providers(c)).find((x) => x.id === id);
    if (!p) throw AppError.notFound('Model provider');
    return p;
  };
  route(app, 'modelProviders.update', api.modelProviders.update, async (req) => {
    const u = requireUser(req);
    const p = await providerOr404(req.params.id);
    if (p.keySource === 'env' && req.body.apiKey) throw AppError.validation('This provider uses ANTHROPIC_API_KEY; change the environment variable', [{ path: ['apiKey'], message: 'env-managed', code: 'env_managed' }]);
    if (req.body.apiKey) await storeKey(c, req.body.apiKey, u.id);
    if (req.body.name && p.keySource === 'stored') await c.settings.set('modelProviderName', req.body.name, u.id);
    if (req.body.defaultModel) await c.settings.set('evalModel', req.body.defaultModel, u.id);
    return providerOr404(req.params.id);
  });
  route(app, 'modelProviders.delete', api.modelProviders.delete, async (req) => {
    const u = requireUser(req);
    const p = await providerOr404(req.params.id);
    if (p.keySource === 'env') throw AppError.conflict('A provider from ANTHROPIC_API_KEY cannot be deleted from the console');
    await clearKey(c, u.id);
  });
  route(app, 'modelProviders.test', api.modelProviders.test, async (req) => {
    await providerOr404(req.params.id);
    return testModel(c);
  });

  route(app, 'telemetry.test', api.telemetry.test, async (req) => {
    const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null;
    if (c.config.env.OTEL_SDK_DISABLED || req.webAuth?.user.anonymous) return { ok: false, otlpEndpoint: endpoint, detail: c.config.env.OTEL_SDK_DISABLED ? 'The OpenTelemetry SDK is disabled (OTEL_SDK_DISABLED=true)' : 'No-op in the public demo' };
    const { trace } = await import('@opentelemetry/api');
    const span = trace.getTracer('neurouter').startSpan('neurouter.telemetry.test');
    span.setAttribute('neurouter.test', true);
    span.end();
    c.logger.info({ telemetryTest: true }, 'telemetry test log record');
    return { ok: true, otlpEndpoint: endpoint, detail: 'Emitted one span (neurouter.telemetry.test) and one log record' };
  });

  /* ---------------------------------------------------------------- kill switches */
  const ksRow = async (k: { scope: 'global' | 'server' | 'environment' | 'tool'; target: string; kind: 'all' | 'writes' | 'code_mode'; reason: string; created_by: string | null; created_at: number }) => ({ scope: k.scope, target: k.target, kind: k.kind, reason: k.reason, createdBy: await c.views.userRef(k.created_by), createdAt: toIso(k.created_at) });
  route(app, 'killSwitches.list', api.killSwitches.list, async () => ({ items: await Promise.all((await db.selectFrom('kill_switches').selectAll().where('tenant_id', '=', c.tenantId).orderBy('created_at', 'desc').execute()).map(ksRow)) }));
  route(app, 'killSwitches.set', api.killSwitches.set, async (req) => {
    const u = requireUser(req);
    const b = req.body;
    const row = { tenant_id: c.tenantId, scope: b.scope, target: b.scope === 'global' ? '*' : b.target, kind: b.kind, reason: b.reason, created_by: u.id, created_at: c.clock.now() };
    await db.insertInto('kill_switches').values(row).onConflict((oc) => oc.columns(['tenant_id', 'scope', 'target', 'kind']).doUpdateSet({ reason: row.reason, created_by: row.created_by, created_at: row.created_at })).execute();
    c.runtime.invalidate();
    await c.coord.publish(KILL_CHANGED, {});
    return ksRow(row);
  });
  route(app, 'killSwitches.clear', api.killSwitches.clear, async (req) => {
    const q = req.query;
    const res = await db.deleteFrom('kill_switches').where('tenant_id', '=', c.tenantId).where('scope', '=', q.scope).where('target', '=', q.scope === 'global' ? '*' : q.target).where('kind', '=', q.kind).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw AppError.notFound('Kill switch');
    c.runtime.invalidate();
    await c.coord.publish(KILL_CHANGED, {});
  });

  /* ---------------------------------------------------------------- config (neurouter.yaml) */
  const configStatus = async () => {
    const st = await c.configSync.state();
    const [srv, env] = await Promise.all([
      db.selectFrom('servers').select((eb) => eb.fn.countAll<number>().as('n')).where('managed_by', '=', 'file').where('status', '!=', 'removed_from_config').executeTakeFirst(),
      db.selectFrom('environments').select((eb) => eb.fn.countAll<number>().as('n')).where('managed_by', '=', 'file').where('status', '!=', 'removed_from_config').executeTakeFirst(),
    ]);
    return { mode: c.config.configMode, path: st.path ?? c.config.env.NEUROUTER_CONFIG ?? null, hash: st.hash, appliedAt: toIsoOrNull(st.appliedAt), status: st.status ?? ('none' as const), diagnostics: st.diagnostics, managed: { servers: Number(srv?.n ?? 0), environments: Number(env?.n ?? 0) } };
  };
  route(app, 'config.status', api.config.status, async () => configStatus());
  route(app, 'config.reload', api.config.reload, async () => {
    const path = c.config.env.NEUROUTER_CONFIG;
    if (!path || c.config.configMode === 'console') throw AppError.validation('No neurouter.yaml is configured (NEUROUTER_CONFIG) or NEUROUTER_CONFIG_MODE=console', [{ path: ['NEUROUTER_CONFIG'], message: 'not set', code: 'no_config' }]);
    const r = await c.configSync.loadFile(path);
    if (!r.ok) throw new AppError('validation_failed', 'neurouter.yaml has errors', { extensions: { diagnostics: r.diagnostics } });
    return configStatus();
  });
  route(app, 'config.validate', api.config.validate, async (req) => {
    const p = parseConfigYaml(req.body.yaml);
    return { ok: p.ok, diagnostics: p.diagnostics };
  });
  route(app, 'config.export', api.config.export, async (_req, reply) => {
    const servers = await db.selectFrom('servers').selectAll().where('tenant_id', '=', c.tenantId).where('status', '!=', 'removed_from_config').orderBy('slug').execute();
    const out: Record<string, unknown> = { version: 1, instance: { name: (await c.settings.get('orgName')) ?? c.config.env.ORG_NAME }, settings: { codeMode: { enabled: await c.settings.get('codeModeEnabled') } }, servers: [] as unknown[] };
    for (const s of servers) {
      const src = parseJsonColumn<{ url?: string; path?: string }>(s.spec_source) ?? {};
      const envs = await db.selectFrom('environments').selectAll().where('server_id', '=', s.id).where('status', '!=', 'removed_from_config').orderBy('created_at').execute();
      (out.servers as unknown[]).push({
        slug: s.slug,
        name: s.name,
        ...(s.description ? { description: s.description } : {}),
        spec: src.url ? { url: src.url } : src.path ? { path: src.path } : { path: `./specs/${s.slug}.yaml` },
        ...(s.overlay_path ? { overlay: s.overlay_path } : {}),
        exposure: parseJsonColumn(s.exposure),
        opsTools: parseJsonColumn(s.ops_tools),
        publicReport: s.public_report === 1,
        environments: envs
          .filter((e) => e.builtin !== 1)
          .map((e) => {
            const a = parseJsonColumn<UpstreamAuthDescriptor>(e.auth) ?? { type: 'none' };
            const auth = a.type === 'header' ? { type: 'header', header: a.header } : a.type === 'query' ? { type: 'query', query: a.query } : a.type === 'oauth_client_credentials' ? { type: a.type, oauth_client_credentials: { tokenUrl: a.tokenUrl, clientId: a.clientId, clientSecret: a.clientSecret, scopes: a.scopes ?? [] } } : a.type === 'oauth_passthrough' ? { type: a.type, ...(a.forwardInboundToken ? { forwardInboundToken: true, upstreamAudience: a.upstreamAudience } : { oauth_passthrough: { authorizationUrl: a.authorizationUrl, tokenUrl: a.tokenUrl, clientId: a.clientId, ...(a.clientSecret ? { clientSecret: a.clientSecret } : {}), scopes: a.scopes ?? [] } }) } : a;
            const limits = parseJsonColumn<Record<string, unknown>>(e.limits) ?? {};
            const hosts = parseJsonColumn<string[]>(e.allowed_hosts) ?? [];
            const pol = parseJsonColumn<unknown[]>(e.policies) ?? [];
            const headers = parseJsonColumn<Record<string, string>>(e.headers) ?? {};
            return { slug: e.slug, name: e.name, kind: e.kind, baseUrl: e.base_url, auth, ...(Object.keys(headers).length ? { headers } : {}), writes: parseJsonColumn(e.writes), codeMode: e.code_mode === 1, ...(Object.keys(limits).length ? { limits } : {}), ...(pol.length ? { policies: pol } : {}), ...(hosts.length ? { allowedHosts: hosts } : {}) };
          }),
      });
    }
    return reply.header('content-type', 'text/yaml; charset=utf-8').header('content-disposition', 'attachment; filename="neurouter.yaml"').send(`# Exported by Neurouter ${c.version} (secret references only)\n${stringify(out)}`);
  });

  route(app, 'system.info', api.system.info, async () => {
    const ping = await pingDatabase(c.dbs.main);
    return {
      version: c.version,
      commit: process.env.NEUROUTER_COMMIT ?? process.env.GIT_COMMIT ?? null,
      nodeVersion: process.version,
      db: { dialect: c.dbs.main.dialect, version: ping.ok ? (ping.version ?? null) : null },
      executor: c.ports.executorStatus(),
      embedder: { status: c.embedderStatus(), model: c.embedderModel },
      coordination: c.coordinationBackend,
      instanceId: c.instanceId,
      publicUrl: c.config.publicUrl,
      protocolVersions: [...SUPPORTED_PROTOCOL_VERSIONS],
    };
  });

  /* ---------------------------------------------------------------- users, jobs */
  const userRow = (u: { id: string; email: string; name: string; role: 'admin' | 'viewer'; role_source: 'local' | 'oidc' | 'bootstrap'; status: 'active' | 'disabled'; last_login_at: number | null; created_at: number }) => ({ id: u.id, email: u.email, name: u.name, role: u.role, roleSource: u.role_source, status: u.status, lastLoginAt: toIsoOrNull(u.last_login_at), createdAt: toIso(u.created_at) });
  route(app, 'users.list', api.users.list, async (req) => {
    const limit = clampLimit(req.query.limit);
    const key = decodeCursor(req.query.cursor);
    let qb = db.selectFrom('users').selectAll().where('tenant_id', '=', c.tenantId).where('email', '!=', 'anonymous@demo.invalid');
    if (req.query.q) qb = qb.where((eb) => eb.or([eb('email', 'like', `%${req.query.q}%`), eb('name', 'like', `%${req.query.q}%`)]));
    if (key) qb = qb.where('email', '>', String(key[0]));
    const rows = await qb.orderBy('email').limit(limit + 1).execute();
    return toPage(rows, limit, userRow, (r) => [r.email]);
  });
  route(app, 'users.update', api.users.update, async (req) => userRow(await c.users.update(req.params.id, req.body, requireUser(req).id)));
  route(app, 'jobs.get', api.jobs.get, async (req) => c.jobs.get(req.params.id, requireUser(req)));

  /* ---------------------------------------------------------------- SSE events (§12.3) */
  const listeners = new Set<(event: string, data: unknown) => void>();
  const emit = (event: string, data: unknown) => {
    for (const l of listeners) l(event, data);
  };
  c.coord.subscribe('events.task', (p) => emit('task.updated', { taskId: (p as { taskId?: string })?.taskId ?? null }));
  c.coord.subscribe('events.inbox', () => emit('inbox.changed', {}));
  c.coord.subscribe('events.eval', (p) => emit('eval.progress', p));
  c.postCommit.push((rows: readonly CommittedAuditRow[]) => {
    if (!listeners.size) return;
    for (const r of rows) if (r.kind === 'tool_call' || r.kind === 'script_run') emit('call.recorded', { auditId: r.id, taskId: r.task_id });
  });
  const TOPIC_OF: Record<string, string> = { 'task.updated': 'tasks', 'call.recorded': 'calls', 'eval.progress': 'evals', 'inbox.changed': 'inbox' };

  route(app, 'events.stream', api.events.stream, async (req, reply) => {
    const topics = new Set((req.query.topics ?? 'tasks,calls,evals,inbox').split(',').map((t) => t.trim()));
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const l = (event: string, data: unknown) => {
      if (topics.has(TOPIC_OF[event] ?? '')) res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    };
    listeners.add(l);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref();
    req.raw.on('close', () => {
      clearInterval(ping);
      listeners.delete(l);
    });
  });
  void DEFAULT_EVAL_MODEL;
}
