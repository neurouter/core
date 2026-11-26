import { readFileSync } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { stringify } from 'yaml';
import { createLlmClient } from '@neurouter/evals';
import { api, clampCodeLimits, DEFAULT_CODE_LIMITS, parseSecretRef, LLM_PROVIDER_KINDS, parseModelRef, PROVIDER_ENV_KEYS, PROVIDER_LABELS, PROVIDER_MODELS, providerForModel, SUPPORTED_PROTOCOL_VERSIONS, type AuditExport, type KeyStatus, type LlmProviderKind, type ModelProvider, type Settings } from '@neurouter/shared';
import type { CommittedAuditRow } from '../../../kernel/audit/writer.js';
import { pingDatabase } from '../../../kernel/db/index.js';
import { toIso, toIsoOrNull } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { KILL_CHANGED, type UpstreamAuthDescriptor } from '../../../kernel/runtime-config.js';
import { requireTenant, requireUser, tenantOf } from '../../auth/guards.js';
import type { TenantRef } from '../../../kernel/tenancy/types.js';
import type { InstanceSettingKey } from '../../../kernel/settings/settings.service.js';
import { parseConfigYaml } from '../../config-sync/reconcile.js';
import { clearProviderKey, LAST4_SETTING, providerKey, providerSecret, SECRET_ID_SETTING, storeProviderKey } from '../../evals/model-keys.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';

export const ANTHROPIC_SECRET = providerSecret('anthropic');
/** Provider ids: `<kind>-env` (from the env key; cannot be deleted) and `<kind>-stored` (console key). */
export const envProviderId = (kind: LlmProviderKind) => `${kind}-env`;
export const storedProviderId = (kind: LlmProviderKind) => `${kind}-stored`;
export const ENV_PROVIDER_ID = envProviderId('anthropic');
export const STORED_PROVIDER_ID = storedProviderId('anthropic');

/** Model-key lookup for one tenant: its stored key first; the server's env key only when the ModelKeyPolicy allows it (spec §8.8, G12). */
export const keyDeps = (c: Pick<ApiContext, 'config' | 'settings' | 'namedSecrets' | 'modelKeys'>, t: TenantRef) => ({ env: c.config.env as unknown as Record<string, string | undefined>, settings: c.settings, namedSecrets: c.namedSecrets, tenantId: t.id, allowEnvKeys: c.modelKeys.allowEnvKeys(t) });

/** The Anthropic key the evals use for a tenant (stored key first, then the env key when allowed). */
export async function anthropicKey(c: Pick<ApiContext, 'config' | 'settings' | 'namedSecrets' | 'modelKeys'>, t: TenantRef): Promise<{ key: string; source: 'env' | 'stored' } | null> {
  return providerKey(keyDeps(c, t), 'anthropic');
}

/**
 * Instance settings (spec §4.6) are shared by every tenant: on a multi-tenant deployment a tenant
 * admin can't change them (platform settings); single-tenant installs keep editing them in Settings.
 */
function assertInstanceWritable(c: ApiContext, key: InstanceSettingKey): void {
  if (c.tenancy.multi) throw new AppError('forbidden', `${key} is a platform setting on this deployment`, { extensions: { reason: 'instance_setting' } });
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
    // applied at boot only for env:NAME references (file-env.ts); other references are ignored with a warning
    if (st?.evals?.apiKey && parseSecretRef(st.evals.apiKey)?.kind === 'env') out.push('models.anthropicKey', 'models.apiKeys');
    if (st?.discovery) out.push('discovery.nativeSearchClients');
    if (st?.audit?.storeOutputs !== undefined) out.push('audit.storeOutputs');
    if (st?.audit?.webhook !== undefined || st?.audit?.otelLogs !== undefined) out.push('audit.export');
    return out;
  } catch {
    return [];
  }
}

/** Named secret holding the console-set webhook signing secret (owner settings/audit). */
export const WEBHOOK_SECRET = 'webhook_secret';

async function auditExportView(c: ApiContext, tenantId: string): Promise<AuditExport> {
  const cfg = await c.settings.get('auditSinks', tenantId);
  const cursors = await c.dbs.audit.db.selectFrom('audit_sink_cursors').selectAll().execute();
  const enabled = [...(cfg.webhook.enabled && cfg.webhook.url ? ['webhook' as const] : []), ...(cfg.otelLogs.enabled ? ['otel_logs' as const] : [])];
  return {
    webhookUrl: cfg.webhook.url,
    webhookEnabled: cfg.webhook.enabled,
    webhookSecret: cfg.webhook.secretRef === 'stored' ? 'stored' : cfg.webhook.secretRef?.startsWith('env:') ? 'env' : null,
    otelLogsEnabled: cfg.otelLogs.enabled,
    sinks: enabled.map((name) => {
      const r = cursors.find((x) => x.sink === name);
      return { name, lastSeq: r ? Number(r.last_seq) : 0, lastError: r?.last_error ?? null, updatedAt: r ? toIso(Number(r.updated_at)) : null };
    }),
  };
}

async function keyStatus(c: ApiContext, t: TenantRef, kind: LlmProviderKind): Promise<KeyStatus> {
  const key = await providerKey(keyDeps(c, t), kind);
  return { configured: Boolean(key), source: key?.source ?? null, last4: key ? (key.source === 'env' ? key.key.slice(-4) : await c.settings.get(LAST4_SETTING[kind], t.id)) : null };
}

async function settingsView(c: ApiContext, t: TenantRef): Promise<Settings> {
  const s = c.settings;
  const tid = t.id;
  const keys = { openai: await keyStatus(c, t, 'openai'), anthropic: await keyStatus(c, t, 'anthropic'), gemini: await keyStatus(c, t, 'gemini') };
  const evalModel = (await s.get('evalModel', tid)) ?? c.config.env.NEUROUTER_EVAL_MODEL;
  return {
    general: { orgName: (await s.get('orgName', tid)) ?? c.config.env.ORG_NAME, publicUrl: c.config.publicUrl, retentionDays: (await s.get('retentionDays', tid)) ?? c.config.env.NEUROUTER_RETENTION_DAYS },
    models: {
      anthropicKey: keys.anthropic,
      keys,
      evalModel,
      judgeModel: (await s.get('judgeModel', tid)) ?? evalModel,
      generatorModel: (await s.get('generatorModel', tid)) ?? evalModel,
      effort: await s.get('evalEffort', tid),
      fallbacks: await s.get('evalFallbacks', tid),
    },
    codeMode: { enabled: await s.get('codeModeEnabled', tid), executor: c.ports.executorStatus(), defaults: clampCodeLimits(DEFAULT_CODE_LIMITS, await s.get('codeLimitsCap')).limits, cap: await s.get('codeLimitsCap') },
    retention: { auditDays: await s.get('auditRetentionDays'), taskDays: (await s.get('retentionDays', tid)) ?? c.config.env.NEUROUTER_RETENTION_DAYS },
    telemetry: { otelEnabled: !c.config.env.OTEL_SDK_DISABLED, metricsEnabled: c.config.env.METRICS_ENABLED, otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? null },
    discovery: { nativeSearchClients: await s.get('nativeSearchClients') },
    audit: { storeOutputs: await s.get('auditStoreFullOutput', tid), export: await auditExportView(c, tid) },
    fileManaged: fileManagedSettings(c),
  };
}

async function lastTest(c: ApiContext, tid: string, kind: LlmProviderKind): Promise<{ at: number; ok: boolean } | null> {
  return (await c.settings.get('modelProviderLastTests', tid))[kind] ?? (kind === 'anthropic' ? await c.settings.get('modelProviderLastTest', tid) : null);
}

async function providerName(c: ApiContext, tid: string, kind: LlmProviderKind): Promise<string> {
  return (await c.settings.get('modelProviderNames', tid))[kind] ?? (kind === 'anthropic' ? await c.settings.get('modelProviderName', tid) : PROVIDER_LABELS[kind]);
}

/**
 * One provider per kind that has a key: the tenant's stored key → `<kind>-stored`, else the server's
 * env key → `<kind>-env` (only when the ModelKeyPolicy lets this tenant use server keys; spec §8.8).
 */
async function providers(c: ApiContext, t: TenantRef): Promise<ModelProvider[]> {
  const tid = t.id;
  const evalModel = (await c.settings.get('evalModel', tid)) ?? c.config.env.NEUROUTER_EVAL_MODEL;
  const defaultKind = providerForModel(evalModel);
  const env = c.config.env as unknown as Record<string, string | undefined>;
  const out: ModelProvider[] = [];
  for (const kind of LLM_PROVIDER_KINDS) {
    const list = [...PROVIDER_MODELS[kind]];
    const defaultModel = defaultKind === kind ? evalModel : list[0]!;
    const last = await lastTest(c, tid, kind);
    const base = { kind, defaultModel, models: list.includes(defaultModel) ? list : [defaultModel, ...list], lastTestAt: last ? toIso(last.at) : null, lastTestOk: last ? last.ok : null, isDefault: defaultKind === kind };
    const envKey = c.modelKeys.allowEnvKeys(t) ? env[PROVIDER_ENV_KEYS[kind]] : undefined;
    if (await c.settings.get(SECRET_ID_SETTING[kind], tid)) out.push({ ...base, id: storedProviderId(kind), name: await providerName(c, tid, kind), keySource: 'stored', keyLast4: await c.settings.get(LAST4_SETTING[kind], tid) });
    else if (envKey) out.push({ ...base, id: envProviderId(kind), name: `${PROVIDER_LABELS[kind]} (${PROVIDER_ENV_KEYS[kind]})`, keySource: 'env', keyLast4: envKey.slice(-4) });
  }
  return out;
}

/** One tiny call through the provider's SDK client (never in tests: keys are absent there). */
async function testModel(c: ApiContext, t: TenantRef, kind?: LlmProviderKind): Promise<{ ok: boolean; model: string; latencyMs: number | null; error?: string }> {
  const evalModel = (await c.settings.get('evalModel', t.id)) ?? c.config.env.NEUROUTER_EVAL_MODEL;
  const ref = parseModelRef(evalModel);
  const k = kind ?? ref.provider;
  if (!k) throw AppError.validation(`Cannot tell which provider serves ${evalModel}; prefix it with openai:, anthropic: or gemini:`, [{ path: ['evalModel'], message: 'unknown provider', code: 'unknown_provider' }]);
  const model = ref.provider === k ? ref.model : PROVIDER_MODELS[k][0]!;
  const key = await providerKey(keyDeps(c, t), k);
  if (!key) throw new AppError('llm_key_missing', `Configure a ${PROVIDER_LABELS[k]} API key first (${PROVIDER_ENV_KEYS[k]} or Settings → Models)`);
  if (c.config.env.NODE_ENV === 'test') return { ok: false, model, latencyMs: null, error: 'model tests are disabled when NODE_ENV=test' };
  const t0 = c.clock.now();
  const record = async (ok: boolean) => {
    await c.settings.set('modelProviderLastTests', { ...(await c.settings.get('modelProviderLastTests', t.id)), [k]: { at: c.clock.now(), ok } }, null, t.id);
    if (k === 'anthropic') await c.settings.set('modelProviderLastTest', { at: c.clock.now(), ok }, null, t.id);
  };
  try {
    await createLlmClient({ provider: k, apiKey: key.key }).create({ model, max_tokens: 64, messages: [{ role: 'user', content: 'Reply with OK.' }] }, { signal: AbortSignal.timeout(20_000) });
    await record(true);
    return { ok: true, model, latencyMs: c.clock.now() - t0 };
  } catch (err) {
    await record(false);
    return { ok: false, model, latencyMs: null, error: (err as Error).message.slice(0, 300) };
  }
}

/** settings, modelProviders, telemetry, killSwitches, config, system, users, jobs, events (§14.13, §14.15). */
export async function settingsRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;

  route(app, 'settings.get', api.settings.get, async (req) => settingsView(c, requireTenant(req).tenant));

  route(app, 'settings.update', api.settings.update, async (req) => {
    const u = requireUser(req);
    const b = req.body;
    const fm = new Set(fileManagedSettings(c));
    const touched: string[] = [];
    for (const [section, obj] of Object.entries(b)) for (const k of Object.keys(obj ?? {})) touched.push(`${section}.${k}`);
    const managed = touched.filter((t) => fm.has(t));
    if (managed.length) throw new AppError('config_managed', `${managed.join(', ')} ${managed.length > 1 ? 'are' : 'is'} set in neurouter.yaml`, { extensions: { configPath: c.config.env.NEUROUTER_CONFIG ?? 'neurouter.yaml', configLine: null } });
    const s = c.settings;
    const t = requireTenant(req).tenant;
    const tid = t.id;
    if (b.general?.orgName !== undefined) await s.set('orgName', b.general.orgName, u.id, tid);
    if (b.general?.retentionDays !== undefined) await s.set('retentionDays', b.general.retentionDays, u.id, tid);
    if (b.models) {
      const m = b.models;
      const writes: Array<[LlmProviderKind, { value: string } | { clear: true }]> = Object.entries(m.apiKeys ?? {}).filter((e): e is [LlmProviderKind, { value: string } | { clear: true }] => e[1] !== undefined);
      if (m.anthropicKey && !m.apiKeys?.anthropic) writes.push(['anthropic', m.anthropicKey]);
      for (const [kind, w] of writes) {
        if ('value' in w) await storeProviderKey(keyDeps(c, t), kind, w.value, u.id);
        else await clearProviderKey(keyDeps(c, t), kind, u.id);
      }
      if (m.evalModel) await s.set('evalModel', m.evalModel, u.id, tid);
      if (m.judgeModel) await s.set('judgeModel', m.judgeModel, u.id, tid);
      if (m.generatorModel) await s.set('generatorModel', m.generatorModel, u.id, tid);
      if (m.effort) await s.set('evalEffort', m.effort, u.id, tid);
      if (m.fallbacks) await s.set('evalFallbacks', m.fallbacks, u.id, tid);
      // m.labelInferredTasks: deprecated, accepted and ignored
    }
    if (b.codeMode?.enabled !== undefined) {
      await s.set('codeModeEnabled', b.codeMode.enabled, u.id, tid);
      c.runtime.invalidate();
      await c.coord.publish(KILL_CHANGED, {});
    }
    if (b.codeMode?.defaults) {
      // `codeMode.defaults` sets the instance cap on per-environment code limits (enforced at runtime)
      assertInstanceWritable(c, 'codeLimitsCap');
      await s.set('codeLimitsCap', { ...(await s.get('codeLimitsCap')), ...b.codeMode.defaults }, u.id);
      c.runtime.invalidate();
      await c.coord.publish(KILL_CHANGED, {});
    }
    if (b.retention?.auditDays !== undefined) {
      assertInstanceWritable(c, 'auditRetentionDays');
      await s.set('auditRetentionDays', b.retention.auditDays, u.id);
    }
    if (b.retention?.taskDays !== undefined) await s.set('retentionDays', b.retention.taskDays, u.id, tid);
    if (b.discovery?.nativeSearchClients) {
      assertInstanceWritable(c, 'nativeSearchClients');
      await s.set('nativeSearchClients', b.discovery.nativeSearchClients, u.id);
    }
    if (b.audit?.storeOutputs !== undefined) await s.set('auditStoreFullOutput', b.audit.storeOutputs, u.id, tid);
    if (b.audit?.export) {
      const x = b.audit.export;
      const cur = await s.get('auditSinks', tid);
      let secretRef = cur.webhook.secretRef;
      if (x.webhookSecret !== undefined) {
        if (x.webhookSecret === null) {
          await c.namedSecrets.delete(tenantOf(req), 'settings', 'audit', WEBHOOK_SECRET);
          secretRef = null;
        } else {
          await c.namedSecrets.set(tenantOf(req), 'settings', 'audit', WEBHOOK_SECRET, x.webhookSecret, u.id);
          secretRef = 'stored';
        }
      }
      const url = x.webhookUrl === undefined ? cur.webhook.url : x.webhookUrl;
      const enabled = x.webhookEnabled ?? cur.webhook.enabled;
      if (enabled && !url) throw AppError.validation('Set a webhook URL before enabling the webhook', [{ path: ['audit', 'export', 'webhookUrl'], message: 'required', code: 'required' }]);
      await s.set('auditSinks', { webhook: { url, secretRef, enabled }, otelLogs: { enabled: x.otelLogsEnabled ?? cur.otelLogs.enabled } }, u.id, tid);
    }
    return settingsView(c, t);
  });

  const tenantRef = (req: FastifyRequest) => requireTenant(req).tenant;
  route(app, 'settings.testModel', api.settings.testModel, async (req) => testModel(c, tenantRef(req)));

  route(app, 'modelProviders.list', api.modelProviders.list, async (req) => ({ items: await providers(c, tenantRef(req)) }));
  route(app, 'modelProviders.create', api.modelProviders.create, async (req, reply) => {
    const u = requireUser(req);
    const t = tenantRef(req);
    const kind = req.body.kind;
    // a stored key may be added next to the server's env key: the tenant's own key takes precedence (spec §8.8)
    if ((await providers(c, t)).some((p) => p.kind === kind && p.keySource === 'stored')) throw AppError.conflict(`A ${PROVIDER_LABELS[kind]} provider is already configured (one per kind); update it instead`);
    await storeProviderKey(keyDeps(c, t), kind, req.body.apiKey, u.id);
    await setProviderName(t.id, kind, req.body.name, u.id);
    if (req.body.defaultModel) await c.settings.set('evalModel', req.body.defaultModel, u.id, t.id);
    reply.status(201);
    return (await providers(c, t)).find((p) => p.id === storedProviderId(kind))!;
  });
  const setProviderName = async (tid: string, kind: LlmProviderKind, name: string, by: string) => {
    if (kind === 'anthropic') await c.settings.set('modelProviderName', name, by, tid);
    else await c.settings.set('modelProviderNames', { ...(await c.settings.get('modelProviderNames', tid)), [kind]: name }, by, tid);
  };
  const providerOr404 = async (req: FastifyRequest, id: string) => {
    const p = (await providers(c, tenantRef(req))).find((x) => x.id === id);
    if (!p) throw AppError.notFound('Model provider');
    return p;
  };
  route(app, 'modelProviders.update', api.modelProviders.update, async (req) => {
    const u = requireUser(req);
    const t = tenantRef(req);
    const p = await providerOr404(req, req.params.id);
    if (p.keySource === 'env' && req.body.apiKey) throw AppError.validation(`This provider uses ${PROVIDER_ENV_KEYS[p.kind]}; change the environment variable`, [{ path: ['apiKey'], message: 'env-managed', code: 'env_managed' }]);
    if (req.body.apiKey) await storeProviderKey(keyDeps(c, t), p.kind, req.body.apiKey, u.id);
    if (req.body.name && p.keySource === 'stored') await setProviderName(t.id, p.kind, req.body.name, u.id);
    if (req.body.defaultModel) await c.settings.set('evalModel', req.body.defaultModel, u.id, t.id);
    return providerOr404(req, req.params.id);
  });
  route(app, 'modelProviders.delete', api.modelProviders.delete, async (req) => {
    const u = requireUser(req);
    const p = await providerOr404(req, req.params.id);
    if (p.keySource === 'env') throw AppError.conflict(`A provider from ${PROVIDER_ENV_KEYS[p.kind]} cannot be deleted from the console`);
    await clearProviderKey(keyDeps(c, tenantRef(req)), p.kind, u.id);
  });
  route(app, 'modelProviders.test', api.modelProviders.test, async (req) => {
    const p = await providerOr404(req, req.params.id);
    return testModel(c, tenantRef(req), p.kind);
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
  route(app, 'killSwitches.list', api.killSwitches.list, async (req) => ({ items: await Promise.all((await db.selectFrom('kill_switches').selectAll().where('tenant_id', '=', tenantOf(req)).orderBy('created_at', 'desc').execute()).map(ksRow)) }));
  route(app, 'killSwitches.set', api.killSwitches.set, async (req) => {
    const u = requireUser(req);
    const b = req.body;
    const row = { tenant_id: tenantOf(req), scope: b.scope, target: b.scope === 'global' ? '*' : b.target, kind: b.kind, reason: b.reason, created_by: u.id, created_at: c.clock.now() };
    await db.insertInto('kill_switches').values(row).onConflict((oc) => oc.columns(['tenant_id', 'scope', 'target', 'kind']).doUpdateSet({ reason: row.reason, created_by: row.created_by, created_at: row.created_at })).execute();
    c.runtime.invalidate();
    await c.coord.publish(KILL_CHANGED, { tenantId: tenantOf(req) });
    return ksRow(row);
  });
  route(app, 'killSwitches.clear', api.killSwitches.clear, async (req) => {
    const q = req.query;
    const res = await db.deleteFrom('kill_switches').where('tenant_id', '=', tenantOf(req)).where('scope', '=', q.scope).where('target', '=', q.scope === 'global' ? '*' : q.target).where('kind', '=', q.kind).executeTakeFirst();
    if (!Number(res.numDeletedRows)) throw AppError.notFound('Kill switch');
    c.runtime.invalidate();
    await c.coord.publish(KILL_CHANGED, {});
  });

  /* ---------------------------------------------------------------- config (neurouter.yaml) */
  const configStatus = async (tenantId: string) => {
    const st = await c.configSync.state();
    const [srv, env] = await Promise.all([
      db.selectFrom('servers').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', tenantId).where('managed_by', '=', 'file').where('status', '!=', 'removed_from_config').executeTakeFirst(),
      db.selectFrom('environments').select((eb) => eb.fn.countAll<number>().as('n')).where('tenant_id', '=', tenantId).where('managed_by', '=', 'file').where('status', '!=', 'removed_from_config').executeTakeFirst(),
    ]);
    return { mode: c.config.configMode, path: st.path ?? c.config.env.NEUROUTER_CONFIG ?? null, hash: st.hash, appliedAt: toIsoOrNull(st.appliedAt), status: st.status ?? ('none' as const), diagnostics: st.diagnostics, managed: { servers: Number(srv?.n ?? 0), environments: Number(env?.n ?? 0) } };
  };
  route(app, 'config.status', api.config.status, async (req) => configStatus(tenantOf(req)));
  route(app, 'config.reload', api.config.reload, async (req) => {
    // neurouter.yaml is instance configuration: it applies to the deployment's default tenant only
    const target = await c.tenancy.defaultTenant();
    if (!target || target.id !== tenantOf(req)) throw new AppError('forbidden', 'neurouter.yaml applies to the default organization only', { extensions: { reason: 'instance_setting' } });
    const path = c.config.env.NEUROUTER_CONFIG;
    if (!path || c.config.configMode === 'console') throw AppError.validation('No neurouter.yaml is configured (NEUROUTER_CONFIG) or NEUROUTER_CONFIG_MODE=console', [{ path: ['NEUROUTER_CONFIG'], message: 'not set', code: 'no_config' }]);
    const r = await c.configSync.loadFile(path);
    if (!r.ok) throw new AppError('validation_failed', 'neurouter.yaml has errors', { extensions: { diagnostics: r.diagnostics } });
    return configStatus(tenantOf(req));
  });
  route(app, 'config.validate', api.config.validate, async (req) => {
    const p = parseConfigYaml(req.body.yaml);
    return { ok: p.ok, diagnostics: p.diagnostics };
  });
  route(app, 'config.export', api.config.export, async (req, reply) => {
    const servers = await db.selectFrom('servers').selectAll().where('tenant_id', '=', tenantOf(req)).where('status', '!=', 'removed_from_config').orderBy('slug').execute();
    const out: Record<string, unknown> = { version: 1, instance: { name: (await c.settings.get('orgName', tenantOf(req))) ?? c.config.env.ORG_NAME }, settings: { codeMode: { enabled: await c.settings.get('codeModeEnabled', tenantOf(req)) } }, servers: [] as unknown[] };
    for (const s of servers) {
      const src = parseJsonColumn<{ url?: string; path?: string }>(s.spec_source) ?? {};
      const envs = await db.selectFrom('environments').selectAll().where('server_id', '=', s.id).where('tenant_id', '=', tenantOf(req)).where('status', '!=', 'removed_from_config').orderBy('created_at').execute();
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
    let qb = db.selectFrom('users').selectAll().where('tenant_id', '=', tenantOf(req)).where('email', '!=', 'anonymous@demo.invalid');
    if (req.query.q) qb = qb.where((eb) => eb.or([eb('email', 'like', `%${req.query.q}%`), eb('name', 'like', `%${req.query.q}%`)]));
    if (key) qb = qb.where('email', '>', String(key[0]));
    const rows = await qb.orderBy('email').limit(limit + 1).execute();
    return toPage(rows, limit, userRow, (r) => [r.email]);
  });
  route(app, 'users.update', api.users.update, async (req) => userRow(await c.users.update(tenantOf(req), req.params.id, req.body, requireUser(req).id)));
  route(app, 'jobs.get', api.jobs.get, async (req) => c.jobs.get(tenantOf(req), req.params.id, requireUser(req)));

  /* ---------------------------------------------------------------- SSE events (§12.3) */
  // every event carries its tenant; a console listener only receives its own tenant's events (spec §4.7, G4).
  // Events without a tenant are dropped (fail closed).
  const listeners = new Set<(event: string, tenantId: string, data: unknown) => void>();
  const emit = (event: string, tenantId: unknown, data: unknown) => {
    if (typeof tenantId !== 'string' || !tenantId) return;
    for (const l of listeners) l(event, tenantId, data);
  };
  const tenantOfPayload = (p: unknown) => (p as { tenantId?: unknown } | null)?.tenantId;
  c.coord.subscribe('events.task', (p) => emit('task.updated', tenantOfPayload(p), { taskId: (p as { taskId?: string })?.taskId ?? null }));
  c.coord.subscribe('events.inbox', (p) => emit('inbox.changed', tenantOfPayload(p), {}));
  c.coord.subscribe('events.eval', (p) => {
    const { tenantId, ...rest } = (p ?? {}) as Record<string, unknown>;
    emit('eval.progress', tenantId, rest);
  });
  c.postCommit.push((rows: readonly CommittedAuditRow[]) => {
    if (!listeners.size) return;
    for (const r of rows) if (r.kind === 'tool_call' || r.kind === 'script_run') emit('call.recorded', r.tenant_id, { auditId: r.id, taskId: r.task_id });
  });
  const TOPIC_OF: Record<string, string> = { 'task.updated': 'tasks', 'call.recorded': 'calls', 'eval.progress': 'evals', 'inbox.changed': 'inbox' };

  route(app, 'events.stream', api.events.stream, async (req, reply) => {
    const topics = new Set((req.query.topics ?? 'tasks,calls,evals,inbox').split(',').map((t) => t.trim()));
    const own = tenantOf(req);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.write(': connected\n\n');
    const l = (event: string, tenantId: string, data: unknown) => {
      if (tenantId === own && topics.has(TOPIC_OF[event] ?? '')) res.write(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    };
    listeners.add(l);
    const ping = setInterval(() => res.write(': ping\n\n'), 15_000);
    ping.unref();
    req.raw.on('close', () => {
      clearInterval(ping);
      listeners.delete(l);
    });
  });
}
