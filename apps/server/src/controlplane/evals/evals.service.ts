import { mcpUrl } from '../../kernel/lib/mcp-url.js';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Kysely, Selectable } from 'kysely';
import { applyOverlayPatch, mockScaleSegment, sha256Hex, withMockDataVersion, withMockScale, type MockDataVersion, type MockNs, type MockScale } from '@neurouter/compiler';
import {
  calibrateTask,
  computeGroundTruth,
  hasScriptReference,
  taskMockScale,
  createMcpHttpClient,
  generateSuite,
  outcomeFromResult,
  runSuiteDetailed,
  summarizeCalibration,
  type GroundTruth,
  type RefSession,
  type SuiteCalibration,
  type TaskCalibration,
  llmFromEnv,
  LlmKeyError,
  RoutingLlmClient,
  QUICK_COUNTS,
  resolveTaskTools,
  scoreRun,
  selectVerifyTasks,
  STUB_RUN_MODEL,
  suggestDetailed,
  type EvalTask,
  type EvalLimitsOverride,
  type GenTool,
  type LlmClient,
  type ObservedCall,
  type ReadinessScore,
  type StateReader,
  type SuggestTool,
  type TaskRunResult,
} from '@neurouter/evals';
import { DETERMINISTIC_JUDGE_MODEL, HEADER_BUILD, HEADER_EXPOSURE, HEADER_MOCK_STATE, HEADER_REFERENCE, PROVIDER_ENV_KEYS, type EvalCategory, type ToolDef } from '@neurouter/shared';
import type { ModelKeyPolicy, TenantResolver } from '../../kernel/tenancy/types.js';
import type { AuditStore } from '../../kernel/audit/store.js';
import type { EvalRunsTable, EvalSuitesTable, EvalTasksTable, MainDB, SuggestionsTable } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../kernel/lib/json.js';
import type { JobsService } from '../../kernel/jobs/jobs.service.js';
import type { NamedSecrets } from '../../kernel/secrets/named-secrets.js';
import type { SettingsService } from '../../kernel/settings/settings.service.js';
import type { Metrics } from '../../kernel/observability/metrics.js';
import type { ApiKeysService } from '../keys/api-keys.service.js';
import type { BuildsService } from '../servers/builds.service.js';
import { hasProviderKey, providerKeys } from './model-keys.js';
import type { ServersService } from '../servers/servers.service.js';

export type EvalRunRowDb = Selectable<EvalRunsTable>;
export type EvalSuiteRowDb = Selectable<EvalSuitesTable>;
export type EvalTaskRowDb = Selectable<EvalTasksTable>;
export type SuggestionRowDb = Selectable<SuggestionsTable>;

/** What the control plane needs from the data plane (wired in deps.ts; no plane imports). */
export interface EvalPorts {
  /** Loopback base URL the runner's MCP client uses (`http://127.0.0.1:<port>`). */
  baseUrl(): string;
  /** Up to `n` seeded sample entities per mock resource (generator input). */
  mockSamples(ns: MockNs, n: number): Promise<Record<string, Array<Record<string, unknown>>>>;
  /** State reader over one mock namespace (`state` assertions), through the same store the data plane uses. */
  mockState(ns: MockNs): StateReader;
  /** Drops a mock namespace (every instance sees it). */
  resetMock(ns: MockNs): Promise<void>;
  /** Eval-only clear arguments of watched eval keys (the audit log stores them redacted). */
  evalArgs?: { watch(apiKeyId: string): void; peek(apiKeyId: string): ReadonlyMap<string, unknown>; release(apiKeyId: string): void };
}

export interface EvalDeps {
  db: Kysely<MainDB>;
  clock: Clock;
  jobs: JobsService;
  settings: SettingsService;
  secrets: NamedSecrets;
  keys: ApiKeysService;
  servers: ServersService;
  builds: BuildsService;
  auditStore: AuditStore;
  ports: EvalPorts;
  env: Record<string, string | undefined>;
  /** Server-level LLM key policy (spec §8.8, G12). */
  modelKeys: ModelKeyPolicy;
  tenancy: Pick<TenantResolver, 'byId' | 'multi'>;
  defaultModel: string;
  metrics?: Metrics;
  log: { warn: (o: object, m: string) => void; info: (o: object, m: string) => void };
  /** Called when a run changes (SSE `eval.progress`). */
  onProgress?: (tenantId: string, runId: string, done: number, total: number) => void;
}

export interface CreateRunInput {
  serverId: string;
  suiteId?: string | null;
  environmentId?: string | null;
  models?: string[] | null;
  modes?: Array<'tool' | 'code'> | null;
  repeats?: number | null;
  buildId?: string | null;
  preset?: 'quick' | null;
  taskKeys?: string[] | null;
  trigger?: 'console' | 'cli' | 'ci' | 'suggestion_verify';
  baseRunId?: string | null;
  createdBy: string | null;
  /** Run in the background (job) or await completion (CLI). */
  wait?: boolean;
  /** Characters kept per transcript item (null = untrimmed, CLI `--transcripts`); default 4,096. */
  transcriptMaxChars?: number | null;
  /** Hard token cap (agent + judge) for the run; it stops gracefully and is marked incomplete. */
  maxRunTokens?: number | null;
  /** Attempts in flight at once (default 4; CLI `--concurrency`). */
  concurrency?: number | null;
}

/** The suite's generator JSON fields this service reads (mock data version, calibration). */
interface SuiteMeta {
  mockDataVersion?: number;
  /** Per-attempt limit overrides for every task of the suite (0.3.3; a task's own win). */
  limits?: EvalLimitsOverride | null;
  calibration?: SuiteCalibration | null;
  pending?: boolean;
}

/** API key scopes of a reference session: script references (long-workflow tasks) also need `code:run`. */
function refScopes(tasks: EvalTask[]): Array<'tools:read' | 'tools:write' | 'code:run'> {
  return tasks.some(hasScriptReference) ? ['tools:read', 'tools:write', 'code:run'] : ['tools:read', 'tools:write'];
}

/**
 * An attempt's mock namespace: `eval:<runId>:[dv1:][ms…:]<attempt key>` (the name stays within the 150
 * characters the data plane accepts; a scaled task's long key keeps a hash of the rest, so attempts stay apart).
 */
export function attemptNamespace(runId: string, attemptKey: string, dv: MockDataVersion, scale: MockScale | null): string {
  const key = attemptKey.replace(/[^A-Za-z0-9:_-]/g, '_');
  if (!scale) return withMockDataVersion(`eval:${runId}:${key.slice(0, 140)}`, dv);
  const room = Math.max(24, 140 - mockScaleSegment(scale).length - 1);
  const short = key.length <= room ? key : `${key.slice(0, room - 13)}_${sha256Hex(key).slice(0, 12)}`;
  return withMockScale(withMockDataVersion(`eval:${runId}:${short}`, dv), scale);
}

const gz = (v: unknown) => gzipSync(Buffer.from(JSON.stringify(v), 'utf8'));
const gunz = <T>(b: Buffer | null): T | null => (b ? (JSON.parse(gunzipSync(b).toString('utf8')) as T) : null);

/** The first generator diagnostics of a suite, as one line (empty-suite errors). */
export function generatorProblems(suite: Pick<EvalSuiteRowDb, 'generator'>, max = 5): string {
  const d = parseJsonColumn<{ diagnostics?: Array<{ category: string; key: string | null; message: string }> }>(suite.generator)?.diagnostics ?? [];
  if (!d.length) return 'No diagnostics were recorded.';
  return `Diagnostics: ${d
    .slice(0, max)
    .map((x) => `[${x.category}${x.key ? ` ${x.key}` : ''}] ${x.message.slice(0, 200)}`)
    .join('; ')}${d.length > max ? ` (+${d.length - max} more)` : ''}`;
}

export function taskFromRow(r: EvalTaskRowDb): EvalTask {
  return {
    key: r.key,
    category: r.category,
    prompt: r.prompt,
    rubric: r.rubric,
    assertions: parseJsonColumn(r.assertions) ?? [],
    referenceCalls: parseJsonColumn(r.reference_calls) ?? [],
    seedState: parseJsonColumn(r.seed_state),
    ...(r.limits ? { limits: parseJsonColumn(r.limits) } : {}),
    tags: parseJsonColumn(r.tags) ?? [],
    enabled: r.enabled === 1,
  };
}

/**
 * Evals (§15): suite generation, runs (tool × code mode against the mock or a dev/qa environment,
 * never prod), scoring, fix suggestions, verify and apply. The runner talks to this server over
 * MCP like a real client, with one short-lived `purpose = 'eval'` key per attempt.
 */
export class EvalsService {
  private readonly cancels = new Map<string, AbortController>();

  constructor(private readonly d: EvalDeps) {}

  /**
   * BYOK keys per provider (OPENAI_API_KEY / ANTHROPIC_API_KEY / GEMINI_API_KEY env win over the
   * stored, encrypted keys); stub/fake per env. With `models`, 412 unless each model's provider has
   * a key.
   */
  /** The judge model: the `judgeModel` setting, else the deterministic Gemini judge when a Gemini key is available, else `fallback`. */
  async judgeModel(tenantId: string, fallback: string): Promise<string> {
    const set = await this.d.settings.get('judgeModel', tenantId);
    if (set) return set;
    const t = await this.d.tenancy.byId(tenantId);
    if (t && (await hasProviderKey({ env: this.d.env, settings: this.d.settings, tenantId, allowEnvKeys: this.d.modelKeys.allowEnvKeys(t) }, 'gemini'))) return DETERMINISTIC_JUDGE_MODEL;
    return fallback;
  }
  /** The run's MCP endpoint on this instance: the tenant's 3-segment URL on a multi-tenant deployment (spec §3.9). */
  private async mcpUrlOf(tenantId: string, server: string, env: string): Promise<string> {
    const tenant = this.d.tenancy.multi ? ((await this.d.tenancy.byId(tenantId))?.slug ?? null) : null;
    return mcpUrl(this.d.ports.baseUrl(), server, env, tenant);
  }


  async llm(tenantId: string, models?: string[]): Promise<LlmClient> {
    const testLlm = this.d.env.NEUROUTER_EVAL_LLM || this.d.env.NEUROUTER_EVAL_FAKE_LLM;
    const t = await this.d.tenancy.byId(tenantId);
    // the tenant's stored keys first; the server's env keys only when the ModelKeyPolicy allows it (spec §8.8)
    const stored = testLlm || !t ? {} : await providerKeys({ env: this.d.env, settings: this.d.settings, namedSecrets: this.d.secrets, tenantId, allowEnvKeys: this.d.modelKeys.allowEnvKeys(t) });
    // the env given to the factory carries no provider keys, so a server key can't override the resolved ones
    const env = Object.fromEntries(Object.entries(this.d.env).filter(([k]) => !(Object.values(PROVIDER_ENV_KEYS) as string[]).includes(k)));
    let llm: LlmClient;
    try {
      llm = llmFromEnv(env, stored, { defaultModel: await this.model(tenantId) });
    } catch (err) {
      if (err instanceof LlmKeyError) throw new AppError('llm_key_missing', 'Configure a model provider API key (OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY, or Settings → Models) to run evals');
      throw err;
    }
    if (llm instanceof RoutingLlmClient) {
      for (const m of models ?? []) {
        try {
          llm.resolve(m);
        } catch (err) {
          if (err instanceof LlmKeyError) throw new AppError('llm_key_missing', err.message);
          throw AppError.validation((err as Error).message, [{ path: ['models'], message: 'unknown provider', code: 'unknown_provider' }]);
        }
      }
    }
    return llm;
  }

  async model(tenantId: string): Promise<string> {
    return (await this.d.settings.get('evalModel', tenantId)) ?? this.d.defaultModel;
  }

  private async serverAndEnv(tenantId: string, serverId: string, environmentId?: string | null) {
    const s = await this.d.servers.get(tenantId, serverId);
    const envs = await this.d.servers.environments(serverId);
    const env = environmentId ? envs.find((e) => e.id === environmentId) : (envs.find((e) => e.slug === 'mock') ?? envs.find((e) => e.kind === 'dev'));
    if (!env) throw AppError.validation('No environment to run against', [{ path: ['environmentId'], message: 'Unknown environment', code: 'not_found' }]);
    if (env.kind === 'prod') throw AppError.validation('Evals never run against production environments', [{ path: ['environmentId'], message: 'kind: prod', code: 'prod_environment' }]);
    return { server: s, env };
  }

  private async evalKey(tenantId: string, serverId: string, environmentId: string, scopes: Array<'tools:read' | 'tools:write' | 'code:run'>, name: string): Promise<{ id: string; token: string }> {
    const admin = (await this.d.db.selectFrom('users').select('id').where('tenant_id', '=', tenantId).where('role', '=', 'admin').orderBy('created_at').executeTakeFirst())!;
    const { key, token } = await this.d.keys.create({ tenantId, name, serverId, environmentId, scopes, ownerUserId: admin.id, purpose: 'eval', expiresInDays: 1 });
    return { id: key.id, token };
  }

  /* ------------------------------------------------------------------ suites */

  private async genTools(buildId: string): Promise<{ tools: ToolDef[]; gen: GenTool[] }> {
    const tools = (await this.d.builds.tools(buildId)).filter((t) => !t.hidden && t.kind !== 'composite');
    return {
      tools,
      gen: tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        inputSchema: t.inputSchema,
        write: t.risk.write,
        pyName: t.pyName,
        exampleArguments: t.examples[0]?.arguments ?? null,
        key: t.key,
        ...(t.pinned ? { pinned: true } : {}),
        ...(t.tags[0] ? { group: t.tags[0] } : {}),
        ...(t.binding.type === 'http' ? { path: t.binding.pathTemplate, method: t.binding.method } : {}),
      })),
    };
  }

  /**
   * Reference sessions for ground truth and calibration: each opens a fresh `gen:<keyId>:…` mock
   * namespace (the key's own, G13) with the suite's data version, over MCP with tool exposure, so the
   * reference outcome goes through the same pipeline (shaping, contract) as the agent's calls.
   */
  private refOpener(server: { slug: string }, env: { id: string; slug: string; tenant_id: string }, key: { id: string; token: string }, dv: MockDataVersion, build?: string | null, opts: { scale?: MockScale | null; code?: boolean } = {}): () => Promise<RefSession> {
    return async () => {
      const name = withMockScale(withMockDataVersion(`gen:${key.id}:gt-${newId()}`, dv), opts.scale);
      const ns: MockNs = { tenantId: env.tenant_id, environmentId: env.id, name };
      // full objects (B7): ground-truth paths may name fields the overlay's default projection leaves out;
      // a script reference (long-workflow task) runs with code-mode exposure
      const headers: Record<string, string> = { [HEADER_MOCK_STATE]: name, [HEADER_EXPOSURE]: opts.code ? 'code' : 'tools', [HEADER_REFERENCE]: '1' };
      if (build) headers[HEADER_BUILD] = build;
      const mcp = await createMcpHttpClient({ url: await this.mcpUrlOf(env.tenant_id, server.slug, env.slug), apiKey: key.token, headers });
      return {
        call: async (tool, args) => outcomeFromResult(tool, await mcp.callTool(tool, args)),
        close: async () => {
          await mcp.close().catch(() => {});
          await this.d.ports.resetMock(ns).catch((err: unknown) => this.d.log.warn({ err }, 'mock reset failed'));
        },
      };
    };
  }

  /** A task's ground truth: its reference calls on a fresh namespace with the suite's data version and the task's mock scale. */
  private taskGroundTruth(server: { slug: string }, env: { id: string; slug: string; tenant_id: string }, key: { id: string; token: string }, dv: MockDataVersion, build?: string | null) {
    return (task: EvalTask) => computeGroundTruth(task.referenceCalls, this.refOpener(server, env, key, dv, build, { scale: taskMockScale(task), code: hasScriptReference(task) }));
  }

  /** Mock data version of a suite: recorded at generation/import; suites from before 0.2.2 use version 1. */
  suiteMeta(suite: Pick<EvalSuiteRowDb, 'generator'>): SuiteMeta & { mockDataVersion: MockDataVersion } {
    const g = parseJsonColumn<SuiteMeta>(suite.generator) ?? {};
    return { ...g, mockDataVersion: g.mockDataVersion === 2 ? 2 : 1 };
  }

  /** Generates a draft suite (§15.2); reference calls are executed over MCP on a fresh mock namespace. */
  /**
   * Generates a draft suite (§15.2); reference calls are executed over MCP on a fresh mock namespace.
   * The suite's `generator` JSON records the model, LLM usage and the generator diagnostics (why tasks
   * were rejected), so an empty or short suite says why.
   */
  async generateSuite(tenantId: string, serverId: string, opts: { counts?: Partial<Record<EvalCategory, number>>; model?: string; seed?: number; instructions?: string | null; maxGeneratorTokens?: number; createdBy: string | null; intoSuiteId?: string }): Promise<EvalSuiteRowDb> {
    const { server, env } = await this.serverAndEnv(tenantId, serverId, null);
    const buildId = env.build_id ?? server.latest_build_id;
    if (!buildId) throw AppError.conflict('The server has no build');
    const { gen } = await this.genTools(buildId);
    const model = opts.model ?? (await this.d.settings.get('generatorModel', tenantId)) ?? (await this.model(tenantId));
    const llm = await this.llm(tenantId, [model]);
    const mockNs = (name: string): MockNs => ({ tenantId: env.tenant_id, environmentId: env.id, name });
    const ns = mockNs(`gen:samples-${newId()}`);
    const samples = await this.d.ports.mockSamples(ns, 3);
    const key = await this.evalKey(tenantId, serverId, env.id, ['tools:read', 'tools:write'], 'eval generator');
    try {
      const out = await generateSuite({
        llm,
        model,
        server: { name: server.name, slug: server.slug, description: server.description },
        tools: gen,
        samples,
        ...(opts.counts ? { counts: opts.counts } : {}),
        ...(opts.instructions ? { instructions: opts.instructions } : {}),
        seed: opts.seed ?? 42,
        ...(opts.maxGeneratorTokens ? { maxGeneratorTokens: opts.maxGeneratorTokens } : {}),
        openReference: this.refOpener(server, env, key, 2),
      });
      const generator = { ...out.generator, diagnostics: out.diagnostics } as unknown as Record<string, unknown>;
      this.d.log.info({ serverId, tasks: out.tasks.length, usage: out.generator.usage, coverage: out.generator.coverage, diagnostics: out.diagnostics.length }, 'eval suite generated');
      if (opts.intoSuiteId) return await this.fillSuite(tenantId, opts.intoSuiteId, buildId, out.tasks, generator);
      return await this.saveSuite(tenantId, serverId, buildId, out.tasks, generator, opts.createdBy);
    } finally {
      await this.d.keys.revoke(tenantId, key.id, null);
      await this.d.ports.resetMock(ns).catch((err: unknown) => this.d.log.warn({ err }, 'mock reset failed'));
    }
  }

  async saveSuite(tenantId: string, serverId: string, buildId: string | null, tasks: EvalTask[], generator: Record<string, unknown>, createdBy: string | null, frozen = false): Promise<EvalSuiteRowDb> {
    const last = await this.d.db.selectFrom('eval_suites').select((eb) => eb.fn.max('version').as('v')).where('tenant_id', '=', tenantId).where('server_id', '=', serverId).executeTakeFirst();
    const id = newId();
    const now = this.d.clock.now();
    await this.d.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('eval_suites')
        .values({ id, tenant_id: tenantId, server_id: serverId, version: Number(last?.v ?? 0) + 1, status: frozen ? 'frozen' : 'draft', generated_from_build_id: buildId, generator: toJsonColumn(generator), task_count: tasks.length, created_by: createdBy, created_at: now, frozen_at: frozen ? now : null })
        .execute();
      for (const t of tasks)
        await trx
          .insertInto('eval_tasks')
          .values({ id: newId(), tenant_id: tenantId, suite_id: id, key: t.key, category: t.category, prompt: t.prompt, rubric: t.rubric ?? '', assertions: toJsonColumn(t.assertions), reference_calls: toJsonColumn(t.referenceCalls ?? []), seed_state: t.seedState ? toJsonColumn(t.seedState) : null, limits: t.limits && Object.keys(t.limits).length ? toJsonColumn(t.limits) : null, tags: toJsonColumn(t.tags ?? []), enabled: t.enabled === false ? 0 : 1, source: 'generated' })
          .execute();
    });
    return (await this.d.db.selectFrom('eval_suites').selectAll().where('id', '=', id).where('tenant_id', '=', tenantId).executeTakeFirst())!;
  }

  /** Inserts generated tasks into an existing (empty, draft) suite. */
  async fillSuite(tenantId: string, suiteId: string, buildId: string | null, tasks: EvalTask[], generator: Record<string, unknown>): Promise<EvalSuiteRowDb> {
    await this.d.db.transaction().execute(async (trx) => {
      for (const t of tasks)
        await trx
          .insertInto('eval_tasks')
          .values({ id: newId(), tenant_id: tenantId, suite_id: suiteId, key: t.key, category: t.category, prompt: t.prompt, rubric: t.rubric ?? '', assertions: toJsonColumn(t.assertions), reference_calls: toJsonColumn(t.referenceCalls ?? []), seed_state: t.seedState ? toJsonColumn(t.seedState) : null, limits: t.limits && Object.keys(t.limits).length ? toJsonColumn(t.limits) : null, tags: toJsonColumn(t.tags ?? []), enabled: t.enabled === false ? 0 : 1, source: 'generated' })
          .execute();
      await trx.updateTable('eval_suites').set({ generated_from_build_id: buildId, generator: toJsonColumn(generator), task_count: tasks.length }).where('id', '=', suiteId).where('tenant_id', '=', tenantId).execute();
    });
    return (await this.d.db.selectFrom('eval_suites').selectAll().where('id', '=', suiteId).where('tenant_id', '=', tenantId).executeTakeFirst())!;
  }

  /** A suite of this server and tenant (G6); 404 otherwise. */
  async suiteOf(tenantId: string, serverId: string, suiteId: string): Promise<EvalSuiteRowDb> {
    const s = await this.d.db.selectFrom('eval_suites').selectAll().where('id', '=', suiteId).where('tenant_id', '=', tenantId).where('server_id', '=', serverId).executeTakeFirst();
    if (!s) throw AppError.notFound('Eval suite');
    return s;
  }

  async suiteTasks(tenantId: string, suiteId: string): Promise<EvalTaskRowDb[]> {
    // G6: tasks of a suite of this tenant only (a foreign suite id yields no prompts or assertions)
    return this.d.db.selectFrom('eval_tasks').selectAll().where('suite_id', '=', suiteId).where('tenant_id', '=', tenantId).orderBy('key').execute();
  }

  /**
   * Calibration gate: every task's own reference solution runs through its assertions against the mock
   * (the suite's data version). Rejected tasks are reported (and disabled with `disableRejected`, so
   * they are never run or scored). `calibrateWith`: one tool-mode pass of that model; tasks it fails
   * are flagged for human review, not dropped. The result is stored with the suite.
   */
  async calibrateSuite(tenantId: string, serverId: string, suiteId: string, opts: { calibrateWith?: string | null; disableRejected?: boolean; environmentId?: string | null } = {}): Promise<SuiteCalibration> {
    const suite = await this.suiteOf(tenantId, serverId, suiteId);
    const meta = this.suiteMeta(suite);
    const { server, env } = await this.serverAndEnv(tenantId, serverId, opts.environmentId);
    const buildId = env.build_id ?? server.latest_build_id;
    if (!buildId) throw AppError.conflict('The server has no build');
    const tasks = resolveTaskTools((await this.suiteTasks(tenantId, suiteId)).map(taskFromRow), await this.d.builds.tools(buildId));
    const key = await this.evalKey(tenantId, serverId, env.id, refScopes(tasks), 'eval calibration');
    const openKeys = new Set<string>();
    try {
      const groundTruthOf = this.taskGroundTruth(server, env, key, meta.mockDataVersion);
      const results: TaskCalibration[] = [];
      const gts = new Map<string, GroundTruth>();
      for (const t of tasks) {
        try {
          const gt = await groundTruthOf(t);
          gts.set(t.key, gt);
          results.push(await calibrateTask(t, gt));
        } catch (err) {
          results.push({ key: t.key, status: 'rejected', reasons: [`reference execution failed: ${(err as Error).message}`] });
        }
      }
      if (opts.calibrateWith) {
        const passed = new Set(results.filter((r) => r.status === 'passed').map((r) => r.key));
        const llm = await this.llm(tenantId, [opts.calibrateWith]);
        const out = await runSuiteDetailed({
          llm,
          tasks: tasks.filter((t) => passed.has(t.key) && t.referenceCalls.length),
          models: [opts.calibrateWith],
          modes: ['tool'],
          repeats: 1,
          judgeModel: opts.calibrateWith,
          groundTruth: async (t) => gts.get(t.key) ?? null,
          openSession: async (ctx) => this.attemptSession(tenantId, serverId, server, env, ctx.mode, (k) => withMockScale(withMockDataVersion(`gen:${k}:cal-${newId()}`, meta.mockDataVersion), taskMockScale(ctx.task)), null, openKeys),
        });
        for (const r of out.results) {
          if (r.passed || r.failureCause === 'provider_refusal') continue;
          const c = results.find((x) => x.key === r.taskKey);
          if (!c) continue;
          c.status = 'flagged';
          c.reasons.push(`${opts.calibrateWith} (tool mode) disagrees: ${r.assertionResults.filter((a) => !a.passed && a.assertion.type !== 'framing').map((a) => a.detail).join('; ').slice(0, 400) || (r.error ?? r.failureCause ?? 'failed')}`);
        }
      }
      const cal = summarizeCalibration(results, meta.mockDataVersion, opts.calibrateWith ?? null, new Date(this.d.clock.now()));
      const fresh = await this.suiteOf(tenantId, serverId, suiteId);
      await this.d.db.transaction().execute(async (trx) => {
        await trx.updateTable('eval_suites').set({ generator: toJsonColumn({ ...(parseJsonColumn<Record<string, unknown>>(fresh.generator) ?? {}), calibration: cal }) }).where('id', '=', suiteId).where('tenant_id', '=', tenantId).execute();
        const rejected = cal.tasks.filter((t) => t.status === 'rejected').map((t) => t.key);
        if (opts.disableRejected && rejected.length) await trx.updateTable('eval_tasks').set({ enabled: 0 }).where('suite_id', '=', suiteId).where('tenant_id', '=', tenantId).where('key', 'in', rejected).execute();
      });
      return cal;
    } finally {
      await this.d.keys.revoke(tenantId, key.id, null);
      for (const id of openKeys) await this.d.keys.revoke(tenantId, id, null).catch(() => {});
    }
  }

  /**
   * Reference runner for offline tools (CLI `--migrate-suite`, `--regrade`): resolves tasks against the
   * environment's build, executes reference calls (ground truth) on fresh namespaces of mock data
   * version `dv`, and lists the build's tools for the task upgrader. `close()` revokes its key.
   */
  async referenceRunner(tenantId: string, serverId: string, dv: MockDataVersion, environmentId?: string | null) {
    const { server, env } = await this.serverAndEnv(tenantId, serverId, environmentId);
    const buildId = env.build_id ?? server.latest_build_id;
    if (!buildId) throw AppError.conflict('The server has no build');
    const buildTools = await this.d.builds.tools(buildId);
    const key = await this.evalKey(tenantId, serverId, env.id, ['tools:read', 'tools:write', 'code:run'], 'eval reference runner');
    return {
      resolve: (tasks: EvalTask[]) => resolveTaskTools(tasks, buildTools),
      groundTruth: this.taskGroundTruth(server, env, key, dv),
      tools: buildTools.map((t) => ({ name: t.name, key: t.key, inputSchema: t.inputSchema, write: t.risk.write, ...(t.binding.type === 'http' ? { method: t.binding.method, path: t.binding.pathTemplate } : {}) })),
      close: () => this.d.keys.revoke(tenantId, key.id, null),
    };
  }

  /**
   * A per-attempt MCP session: its own eval key (watched for clear arguments), the mock namespace
   * `nsName(keyId)` and the mode's exposure; calls are collected from the audit log by the key.
   */
  private async attemptSession(
    tenantId: string,
    serverId: string,
    server: { slug: string },
    env: { id: string; slug: string },
    mode: 'tool' | 'code',
    nsName: (keyId: string) => string,
    buildHeader: string | null,
    openKeys: Set<string>,
  ) {
    const key = await this.evalKey(tenantId, serverId, env.id, mode === 'code' ? ['tools:read', 'tools:write', 'code:run'] : ['tools:read', 'tools:write'], 'eval attempt');
    openKeys.add(key.id);
    this.d.ports.evalArgs?.watch(key.id);
    const name = nsName(key.id);
    const ns: MockNs = { tenantId, environmentId: env.id, name };
    await this.d.ports.resetMock(ns);
    const headers: Record<string, string> = { [HEADER_MOCK_STATE]: name, [HEADER_EXPOSURE]: mode === 'code' ? 'code' : 'tools' };
    if (buildHeader) headers[HEADER_BUILD] = buildHeader;
    const mcp = await createMcpHttpClient({ url: await this.mcpUrlOf(tenantId, server.slug, env.slug), apiKey: key.token, headers });
    return {
      mcp,
      stateReader: this.d.ports.mockState(ns),
      collectCalls: async () => this.observedCalls(tenantId, key.id),
      close: async () => {
        await mcp.close().catch(() => {});
        this.d.ports.evalArgs?.release(key.id);
        await this.d.keys.revoke(tenantId, key.id, null);
        openKeys.delete(key.id);
        await this.d.ports.resetMock(ns).catch((err: unknown) => this.d.log.warn({ err }, 'mock reset failed'));
      },
    };
  }

  /* ------------------------------------------------------------------ runs */

  async createRun(tenantId: string, input: CreateRunInput): Promise<EvalRunRowDb> {
    const { server, env } = await this.serverAndEnv(tenantId, input.serverId, input.environmentId);
    // G6: a body-supplied suite or build must belong to this server of this tenant (else 404, nothing written)
    if (input.suiteId) await this.suiteOf(tenantId, input.serverId, input.suiteId);
    if (input.buildId) {
      const b = await this.d.db.selectFrom('builds').select('id').where('id', '=', input.buildId).where('tenant_id', '=', tenantId).where('server_id', '=', input.serverId).executeTakeFirst();
      if (!b) throw AppError.notFound('Build');
    }
    const running = await this.d.db.selectFrom('eval_runs').select('id').where('tenant_id', '=', tenantId).where('server_id', '=', input.serverId).where('status', 'in', ['queued', 'running']).executeTakeFirst();
    if (running && input.trigger !== 'suggestion_verify') throw new AppError('job_running', 'An eval run is already in progress for this server');
    // 412 early when a run model's (or the judge's) provider has no key
    const stubLlm = !this.d.env.NEUROUTER_EVAL_FAKE_LLM && this.d.env.NEUROUTER_EVAL_LLM === 'stub';
    const runModels = input.models?.length ? input.models : [await this.model(tenantId)];
    await this.llm(tenantId, stubLlm ? [] : [...runModels, await this.judgeModel(tenantId, runModels[0]!)]);
    let suiteId = input.suiteId ?? null;
    if (!suiteId) {
      const latest = await this.d.db.selectFrom('eval_suites').select(['id', 'task_count']).where('tenant_id', '=', tenantId).where('server_id', '=', input.serverId).orderBy('version', 'desc').executeTakeFirst();
      suiteId = latest && latest.task_count > 0 ? latest.id : null;
    }
    // no suite yet: an empty draft suite now (the job generates its tasks), so the run always names its suite
    if (!suiteId) suiteId = (await this.saveSuite(tenantId, input.serverId, null, [], { pending: true }, input.createdBy)).id;
    const buildId = input.buildId ?? env.build_id ?? server.latest_build_id;
    if (!buildId) throw AppError.conflict('The server has no build');
    const quick = input.preset === 'quick';
    // the stub plays every model: record it as such, never as the configured (real) model name
    const stub = !this.d.env.NEUROUTER_EVAL_FAKE_LLM && this.d.env.NEUROUTER_EVAL_LLM === 'stub';
    const models = stub ? [STUB_RUN_MODEL] : input.models?.length ? input.models : [await this.model(tenantId)];
    const modes = input.modes?.length ? input.modes : env.code_mode === 1 ? (['tool', 'code'] as const) : (['tool'] as const);
    const repeats = Math.min(5, Math.max(1, input.repeats ?? (quick ? 1 : await this.d.settings.get('evalRepeats', tenantId))));
    const id = newId();
    const now = this.d.clock.now();
    const build = await this.d.db.selectFrom('builds').select(['overlay_revision_id']).where('id', '=', buildId).where('tenant_id', '=', tenantId).executeTakeFirst();
    await this.d.db
      .insertInto('eval_runs')
      .values({
        id,
        tenant_id: tenantId,
        server_id: input.serverId,
        suite_id: suiteId,
        environment_id: env.id,
        build_id: buildId,
        overlay_revision_id: build?.overlay_revision_id ?? null,
        models: toJsonColumn(models),
        modes: toJsonColumn([...modes]),
        repeats,
        task_keys: input.taskKeys ? toJsonColumn(input.taskKeys) : null,
        status: 'queued',
        progress: toJsonColumn({ done: 0, total: 0 }),
        trigger: input.trigger ?? 'console',
        base_run_id: input.baseRunId ?? null,
        created_by: input.createdBy,
        created_at: now,
      })
      .execute();
    const work = async () => this.executeRun(tenantId, id, { quick, createdBy: input.createdBy, ...(input.transcriptMaxChars !== undefined ? { transcriptMaxChars: input.transcriptMaxChars } : {}), ...(input.maxRunTokens ? { maxRunTokens: input.maxRunTokens } : {}), ...(input.concurrency ? { concurrency: input.concurrency } : {}) });
    if (input.wait) await work();
    else {
      const jobId = await this.d.jobs.start(tenantId, 'eval_run', { runId: id }, input.createdBy, work);
      await this.d.db.updateTable('eval_runs').set({ job_id: jobId }).where('id', '=', id).where('tenant_id', '=', tenantId).execute();
    }
    return this.run(tenantId, id);
  }

  async run(tenantId: string, id: string): Promise<EvalRunRowDb> {
    const r = await this.d.db.selectFrom('eval_runs').selectAll().where('id', '=', id).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!r) throw AppError.notFound('Eval run');
    return r;
  }

  async cancel(tenantId: string, id: string): Promise<EvalRunRowDb> {
    this.cancels.get(id)?.abort(new Error('cancelled'));
    const r = await this.run(tenantId, id);
    if (r.status === 'queued' || r.status === 'running') await this.d.db.updateTable('eval_runs').set({ status: 'cancelled', ended_at: this.d.clock.now() }).where('id', '=', id).where('tenant_id', '=', tenantId).execute();
    return this.run(tenantId, id);
  }

  private async executeRun(tenantId: string, runId: string, opts: { quick: boolean; createdBy: string | null; transcriptMaxChars?: number | null; maxRunTokens?: number; concurrency?: number }): Promise<void> {
    const ac = new AbortController();
    this.cancels.set(runId, ac);
    const db = this.d.db;
    // per-attempt eval keys still active (revoked on session close; any left are revoked when the run ends)
    const openKeys = new Set<string>();
    let refKey: { id: string; token: string } | null = null;
    try {
      let run = await this.run(tenantId, runId);
      await db.updateTable('eval_runs').set({ status: 'running', started_at: this.d.clock.now() }).where('id', '=', runId).where('tenant_id', '=', tenantId).execute();
      const server = await this.d.servers.get(tenantId, run.server_id);
      const env = (await this.d.servers.environments(run.server_id)).find((e) => e.id === run.environment_id)!;
      if ((await this.suiteTasks(tenantId, run.suite_id)).length === 0) {
        const suite = await this.generateSuite(tenantId, run.server_id, { ...(opts.quick ? { counts: QUICK_COUNTS } : {}), createdBy: opts.createdBy, intoSuiteId: run.suite_id });
        // never run (and score) an empty suite: fail the run with the generator's reasons
        if (suite.task_count === 0) throw new Error(`The generator produced no valid tasks. ${generatorProblems(suite)}`);
        run = await this.run(tenantId, runId);
      }
      // assertions name tools by stable key (fallback: name, or the pre-overlay name): survive overlay renames
      const buildTools = await this.d.builds.tools(run.build_id);
      const meta = this.suiteMeta(await this.suiteOf(tenantId, run.server_id, run.suite_id));
      // tasks the calibration gate rejected are never run or scored
      const rejected = new Set((meta.calibration?.tasks ?? []).filter((t) => t.status === 'rejected').map((t) => t.key));
      let tasks = resolveTaskTools((await this.suiteTasks(tenantId, run.suite_id)).map(taskFromRow), buildTools).filter((t) => t.enabled && !rejected.has(t.key));
      const keys = parseJsonColumn<string[]>(run.task_keys);
      if (keys?.length) tasks = tasks.filter((t) => keys.includes(t.key));
      const models = parseJsonColumn<string[]>(run.models) ?? [];
      const modes = parseJsonColumn<Array<'tool' | 'code'>>(run.modes) ?? ['tool'];
      const llm = await this.llm(tenantId);
      const effort = await this.d.settings.get('evalEffort', tenantId);
      const fallbacks = await this.d.settings.get('evalFallbacks', tenantId);
      const judgeModel = await this.judgeModel(tenantId, models[0]!);
      const total = tasks.length * models.length * modes.length * run.repeats;
      const existing = new Set((await db.selectFrom('eval_task_runs').where('tenant_id', '=', tenantId).select(['task_id', 'model', 'mode', 'attempt']).where('run_id', '=', runId).execute()).map((r) => `${r.task_id}|${r.model}|${r.mode}|${r.attempt}`));
      const taskIds = new Map((await this.suiteTasks(tenantId, run.suite_id)).map((t) => [t.key, t.id]));
      const usage: Record<string, { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }> = {};
      const isTemp = (await db.selectFrom('builds').where('tenant_id', '=', tenantId).select('temporary').where('id', '=', run.build_id).executeTakeFirst())?.temporary === 1;
      const pinned = env.build_id;
      // ground truth: each task's reference calls on a fresh namespace with the attempts' seed and data version
      refKey = await this.evalKey(tenantId, run.server_id, env.id, refScopes(tasks), `eval ${runId.slice(-6)} ground truth`);
      const buildHeader = isTemp || (pinned && pinned !== run.build_id) ? run.build_id : null;
      const groundTruthOf = this.taskGroundTruth(server, env, refKey, meta.mockDataVersion, buildHeader);
      const outcome = await runSuiteDetailed({
        llm,
        tasks,
        models,
        modes,
        repeats: run.repeats,
        judgeModel,
        settings: { effort, fallbacks: fallbacks === 'default', ...(opts.transcriptMaxChars !== undefined ? { transcriptMaxChars: opts.transcriptMaxChars } : {}) },
        signal: ac.signal,
        hasResult: (k) => existing.has(k),
        groundTruth: groundTruthOf,
        ...(opts.maxRunTokens ? { maxRunTokens: opts.maxRunTokens } : {}),
        ...(opts.concurrency ? { concurrency: opts.concurrency } : {}),
        ...(meta.limits ? { limits: meta.limits } : {}),
        openSession: async (ctx) => this.attemptSession(tenantId, run.server_id, server, env, ctx.mode, () => attemptNamespace(runId, ctx.key, meta.mockDataVersion, taskMockScale(ctx.task)), buildHeader, openKeys),
        onResult: async (r) => {
          const u = (usage[r.model] ??= { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
          u.inputTokens += r.inputTokens;
          u.outputTokens += r.outputTokens;
          u.cacheReadTokens += r.cacheReadTokens;
          u.cacheWriteTokens += r.cacheWriteTokens;
          this.d.metrics?.evalTaskRuns.inc({ model: r.model, mode: r.mode, passed: String(r.passed) });
          this.d.metrics?.llmTokens.inc({ model: r.model, kind: 'input' }, r.inputTokens);
          this.d.metrics?.llmTokens.inc({ model: r.model, kind: 'output' }, r.outputTokens);
          this.d.metrics?.llmTokens.inc({ model: r.model, kind: 'cache_read' }, r.cacheReadTokens);
          await db
            .insertInto('eval_task_runs')
            .values({
              id: newId(),
              tenant_id: tenantId,
              run_id: runId,
              task_id: taskIds.get(r.taskKey) ?? r.taskKey,
              model: r.model,
              mode: r.mode,
              attempt: r.attempt,
              passed: r.passed ? 1 : 0,
              assertion_results: toJsonColumn(r.assertionResults),
              judge: r.judge ? toJsonColumn(r.judge) : null,
              failure_cause: r.failureCause,
              framing_ok: r.framingPassed ? 1 : 0,
              tool_calls: r.toolCalls,
              scripts: r.scripts,
              input_tokens: r.inputTokens,
              output_tokens: r.outputTokens,
              cache_read_tokens: r.cacheReadTokens,
              cache_write_tokens: r.cacheWriteTokens,
              latency_ms: Math.round(r.latencyMs),
              served_by_model: r.servedByModel,
              fallback_used: r.fallbackUsed ? 1 : 0,
              task_id_neurouter: r.neurouterTaskId,
              transcript: gz({ transcript: r.transcript, calls: r.calls, endReason: r.endReason, error: r.error, primaryTool: r.primaryTool, referenceCallCount: r.referenceCallCount, category: r.category, taskKey: r.taskKey, upstreamCalls: r.upstreamCalls, callBudget: r.callBudget, overBudget: r.overBudget, judgeUsage: r.judgeUsage, toolsListBytes: r.toolsListBytes, framingPassed: r.framingPassed, judgeVotes: r.judgeVotes ?? null, limits: r.limits ?? null, ...(r.llmRetries?.length ? { llmRetries: r.llmRetries } : {}) }),
              created_at: this.d.clock.now(),
            })
            .execute();
        },
        onProgress: (done) => {
          void db.updateTable('eval_runs').where('tenant_id', '=', tenantId).set({ progress: toJsonColumn({ done, total }) }).where('id', '=', runId).execute().catch(() => {});
          this.d.onProgress?.(tenantId, runId, done, total);
        },
      });
      if (ac.signal.aborted) return;
      const all = await this.taskResults(tenantId, runId);
      const lint = (await db.selectFrom('builds').where('tenant_id', '=', tenantId).select('lint_score').where('id', '=', run.build_id).executeTakeFirst())?.lint_score ?? 0;
      const score = { ...scoreRun({ tasks, results: all, models, modes, lintScore: lint }), incomplete: outcome.incomplete };
      await db
        .updateTable('eval_runs').where('tenant_id', '=', tenantId)
        .set({ status: 'succeeded', score: toJsonColumn(score), headline: score.headline, recommended_mode: score.recommendedMode, confidence: score.confidence, usage: toJsonColumn(usage), progress: toJsonColumn({ done: total, total }), ended_at: this.d.clock.now() })
        .where('id', '=', runId)
        .execute();
      // B3: the suggestion LLM spends from the same --max-run-tokens cap as the attempts and judges
      const suggestBudget = opts.maxRunTokens ? Math.max(0, opts.maxRunTokens - outcome.tokensUsed) : null;
      if (run.trigger !== 'suggestion_verify') await this.createSuggestions(tenantId, runId, { maxTokens: suggestBudget }).catch((err: unknown) => this.d.log.warn({ err, runId }, 'suggestion generation failed'));
      else await this.finishVerify(tenantId, runId);
    } catch (err) {
      const msg = err instanceof AppError ? err.message : (err as Error).message;
      this.d.log.warn({ err, runId }, 'eval run failed');
      await db.updateTable('eval_runs').where('tenant_id', '=', tenantId).set({ status: ac.signal.aborted ? 'cancelled' : 'failed', error: msg.slice(0, 1000), ended_at: this.d.clock.now() }).where('id', '=', runId).execute();
    } finally {
      this.cancels.delete(runId);
      if (refKey) await this.d.keys.revoke(tenantId, refKey.id, null).catch((err: unknown) => this.d.log.warn({ err, runId }, 'eval key revoke failed'));
      for (const id of openKeys) await this.d.keys.revoke(tenantId, id, null).catch((err: unknown) => this.d.log.warn({ err, runId }, 'eval key revoke failed'));
    }
  }

  /** The attempt's calls from the audit log (incl. inner script calls), by its eval key. */
  private async observedCalls(tenantId: string, apiKeyId: string): Promise<ObservedCall[]> {
    await this.d.auditStore.flush(5000);
    const rows = await this.d.auditStore.query({ tenantId, from: 0, to: this.d.clock.now() + 60_000, limit: 2000, order: 'asc', kinds: ['tool_call', 'ops_call', 'script_run'], principal: apiKeyId } as never);
    // assertions check the clear arguments (eval-only, in memory); the audit log keeps them redacted
    const clear = this.d.ports.evalArgs?.peek(apiKeyId);
    return rows.rows.map((r) => ({
      tool: r.tool_name ?? '',
      arguments: ((clear?.get(r.id) as Record<string, unknown> | undefined) ?? parseJsonColumn<Record<string, unknown>>(r.params_redacted) ?? {}) as Record<string, unknown>,
      status: r.status,
      decision: r.decision,
      via: r.via ?? 'direct',
      write: Number(r.write) === 1 && r.kind === 'tool_call',
      scriptRunId: r.script_run_id,
      ts: Number(r.ts),
    }));
  }

  /** Stored attempt results, rebuilt as TaskRunResult (scoring, suggestions, resume). */
  async taskResults(tenantId: string, runId: string): Promise<TaskRunResult[]> {
    const rows = await this.d.db.selectFrom('eval_task_runs as r').where('r.tenant_id', '=', tenantId).innerJoin('eval_tasks as t', 't.id', 'r.task_id').select(['r.id', 'r.model', 'r.mode', 'r.attempt', 'r.passed', 'r.assertion_results', 'r.judge', 'r.failure_cause', 'r.framing_ok', 'r.tool_calls', 'r.scripts', 'r.input_tokens', 'r.output_tokens', 'r.cache_read_tokens', 'r.cache_write_tokens', 'r.latency_ms', 'r.served_by_model', 'r.fallback_used', 'r.task_id_neurouter', 'r.transcript', 't.key', 't.category']).where('r.run_id', '=', runId).execute();
    return rows.map((r) => {
      const tr = gunz<{ transcript: TaskRunResult['transcript']; calls: ObservedCall[]; endReason: TaskRunResult['endReason']; error: string | null; primaryTool: string | null; referenceCallCount: number; framingPassed?: boolean | null; judgeVotes?: TaskRunResult['judgeVotes']; limits?: TaskRunResult['limits'] | null; llmRetries?: TaskRunResult['llmRetries'] } & Pick<TaskRunResult, 'upstreamCalls' | 'callBudget' | 'overBudget' | 'judgeUsage' | 'toolsListBytes'>>(r.transcript);
      return {
        key: `${r.key}|${r.model}|${r.mode}|${r.attempt}`,
        taskKey: r.key,
        category: r.category,
        model: r.model,
        mode: r.mode,
        attempt: r.attempt,
        passed: r.passed === 1,
        // null = framing not offered (contract 2): kept in the transcript blob, the framing_ok column is NOT NULL (B2)
        framingPassed: tr && 'framingPassed' in tr ? (tr.framingPassed ?? null) : r.framing_ok === 1,
        assertionResults: parseJsonColumn(r.assertion_results) ?? [],
        judge: parseJsonColumn(r.judge),
        failureCause: (r.failure_cause as TaskRunResult['failureCause']) ?? null,
        primaryTool: tr?.primaryTool ?? null,
        toolCalls: r.tool_calls,
        scripts: r.scripts,
        inputTokens: r.input_tokens,
        outputTokens: r.output_tokens,
        cacheReadTokens: r.cache_read_tokens,
        cacheWriteTokens: r.cache_write_tokens,
        latencyMs: r.latency_ms,
        servedByModel: r.served_by_model,
        fallbackUsed: r.fallback_used === 1,
        neurouterTaskId: r.task_id_neurouter,
        referenceCallCount: tr?.referenceCallCount ?? 0,
        endReason: tr?.endReason ?? 'end_turn',
        error: tr?.error ?? null,
        transcript: tr?.transcript ?? [],
        calls: tr?.calls ?? [],
        ...(tr?.upstreamCalls !== undefined ? { upstreamCalls: tr.upstreamCalls, callBudget: tr.callBudget ?? null, overBudget: tr.overBudget ?? false } : {}),
        ...(tr?.judgeUsage ? { judgeUsage: tr.judgeUsage } : {}),
        ...(tr?.toolsListBytes !== undefined ? { toolsListBytes: tr.toolsListBytes } : {}),
        ...(tr?.judgeVotes ? { judgeVotes: tr.judgeVotes } : {}),
        ...(tr?.limits ? { limits: tr.limits } : {}),
        ...(tr?.llmRetries?.length ? { llmRetries: tr.llmRetries } : {}),
      } as TaskRunResult;
    });
  }

  score(run: EvalRunRowDb): ReadinessScore | null {
    return parseJsonColumn<ReadinessScore>(run.score);
  }

  /* ------------------------------------------------------------------ suggestions (§15.7) */

  private async publishedYaml(tenantId: string, serverId: string): Promise<string> {
    const s = await this.d.servers.get(tenantId, serverId);
    return (await this.d.builds.overlayYaml(s.published_overlay_revision_id)) ?? 'overlay: 1\n';
  }

  /**
   * Fix suggestions for a finished run (§15.7). B3: the suggestion LLM's usage is stored with the run's score
   * (`suggestUsage`), and `maxTokens` (what --max-run-tokens left) bounds it.
   */
  async createSuggestions(tenantId: string, runId: string, opts: { maxTokens?: number | null } = {}): Promise<SuggestionRowDb[]> {
    const run = await this.run(tenantId, runId);
    const results = await this.taskResults(tenantId, runId);
    if (!results.some((r) => !r.passed)) return [];
    const tasks = (await this.suiteTasks(tenantId, run.suite_id)).map(taskFromRow);
    const tools = await this.d.builds.tools(run.build_id);
    const st: SuggestTool[] = tools.map((t) => ({ name: t.name, key: t.key, title: t.title, description: t.description, inputSchema: t.inputSchema, hidden: t.hidden, tags: t.tags, write: t.risk.write, pyName: t.pyName, sourceRef: 'method' in t.sourceRef ? { ...(t.sourceRef.method ? { method: t.sourceRef.method } : {}), ...(t.sourceRef.path ? { path: t.sourceRef.path } : {}), ...(t.sourceRef.operationId ? { operationId: t.sourceRef.operationId } : {}) } : null }));
    const base = await this.publishedYaml(tenantId, run.server_id);
    const lint = parseJsonColumn<{ rules: Array<{ rule: string; weight: number; score: number; passed: boolean; detail: string }> }>((await this.d.db.selectFrom('builds').where('tenant_id', '=', tenantId).select('lint').where('id', '=', run.build_id).executeTakeFirst())?.lint);
    const llm: LlmClient | null = await this.llm(tenantId).catch(() => null);
    const { suggestions: out, usage } = await suggestDetailed({
      results,
      tasks,
      tools: st,
      llm,
      model: await this.model(tenantId),
      ...(opts.maxTokens !== undefined && opts.maxTokens !== null ? { maxTokens: opts.maxTokens } : {}),
      ...(lint ? { lint: lint as never } : {}),
      validatePatch: async (_yaml, ops) => {
        try {
          const merged = applyOverlayPatch(base, ops as never).yaml;
          const r = await this.d.builds.compileWith(run.server_id, merged);
          return { ok: r.ok, diagnostics: r.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message) };
        } catch (err) {
          return { ok: false, diagnostics: [(err as Error).message] };
        }
      },
      findHiddenTool: async (intent) => {
        const words = new Set((intent.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 3));
        let best: { name: string; n: number } | null = null;
        for (const t of tools.filter((x) => x.hidden)) {
          const n = (`${t.name} ${t.description}`.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((w) => words.has(w)).length;
          if (n > 0 && (!best || n > best.n)) best = { name: t.name, n };
        }
        return best?.name ?? null;
      },
    });
    const score = this.score(run);
    if (score) await this.d.db.updateTable('eval_runs').where('tenant_id', '=', tenantId).set({ score: toJsonColumn({ ...score, suggestUsage: usage }) }).where('id', '=', runId).execute();
    const now = this.d.clock.now();
    const taskIds = new Map((await this.suiteTasks(tenantId, run.suite_id)).map((t) => [t.key, t.id]));
    for (const sgg of out) {
      await this.d.db
        .insertInto('suggestions')
        .values({ id: newId(), tenant_id: tenantId, run_id: runId, server_id: run.server_id, cause: sgg.cause, kind: sgg.kind, tools: toJsonColumn(sgg.tools), affected_task_ids: toJsonColumn(sgg.affectedTaskKeys.map((k) => taskIds.get(k) ?? k)), overlay_patch: JSON.stringify({ yaml: sgg.overlayPatch, ops: sgg.overlayOps }), spec_patch: sgg.specPatch, rationale: sgg.rationale, predicted_delta: sgg.predictedDelta, status: 'proposed', created_at: now, updated_at: now })
        .execute();
    }
    return this.d.db.selectFrom('suggestions').where('tenant_id', '=', tenantId).selectAll().where('run_id', '=', runId).execute();
  }

  async suggestion(tenantId: string, id: string): Promise<SuggestionRowDb> {
    const s = await this.d.db.selectFrom('suggestions').selectAll().where('id', '=', id).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!s) throw AppError.notFound('Suggestion');
    return s;
  }

  static patchOf(s: Pick<SuggestionRowDb, 'overlay_patch'>): { yaml: string; ops: unknown[] } {
    try {
      const p = JSON.parse(s.overlay_patch) as { yaml?: string; ops?: unknown[] };
      return { yaml: p.yaml ?? s.overlay_patch, ops: p.ops ?? [] };
    } catch {
      return { yaml: s.overlay_patch, ops: [] };
    }
  }

  /** Verify (§15.7 step 5): affected tasks (+20% of passing as a regression guard) on a temporary build. */
  async verify(tenantId: string, id: string, createdBy: string | null): Promise<SuggestionRowDb> {
    const sg = await this.suggestion(tenantId, id);
    const run = await this.run(tenantId, sg.run_id);
    const base = await this.publishedYaml(tenantId, sg.server_id);
    const merged = applyOverlayPatch(base, EvalsService.patchOf(sg).ops as never).yaml;
    const s = await this.d.servers.get(tenantId, sg.server_id);
    const temp = await this.d.builds.build(sg.server_id, s.current_spec_revision_id!, null, { temporary: true, overlayYaml: merged, pin: false });
    if (temp.build.status !== 'ok') throw new AppError('build_failed', 'The suggested patch does not compile');
    const results = await this.taskResults(tenantId, run.id);
    const affectedIds = parseJsonColumn<string[]>(sg.affected_task_ids) ?? [];
    const keyById = new Map((await this.suiteTasks(tenantId, run.suite_id)).map((t) => [t.id, t.key]));
    const affected = affectedIds.map((x) => keyById.get(x) ?? x);
    const passing = [...new Set(results.filter((r) => r.passed).map((r) => r.taskKey))].filter((k) => !affected.includes(k));
    const keys = selectVerifyTasks(affected, passing, 0.2, 7);
    const vr = await this.createRun(tenantId, { serverId: sg.server_id, suiteId: run.suite_id, environmentId: run.environment_id, models: parseJsonColumn<string[]>(run.models), modes: parseJsonColumn(run.modes), repeats: run.repeats, buildId: temp.build.id, taskKeys: keys, trigger: 'suggestion_verify', baseRunId: run.id, createdBy });
    await this.d.db.updateTable('suggestions').where('tenant_id', '=', tenantId).set({ status: 'verifying', verify_run_id: vr.id, updated_at: this.d.clock.now() }).where('id', '=', id).execute();
    return this.suggestion(tenantId, id);
  }

  private async finishVerify(tenantId: string, verifyRunId: string): Promise<void> {
    const sg = await this.d.db.selectFrom('suggestions').where('tenant_id', '=', tenantId).selectAll().where('verify_run_id', '=', verifyRunId).executeTakeFirst();
    if (!sg) return;
    const vr = await this.run(tenantId, verifyRunId);
    const base = await this.run(tenantId, sg.run_id);
    const keys = parseJsonColumn<string[]>(vr.task_keys) ?? [];
    const after = (await this.taskResults(tenantId, verifyRunId)).filter((r) => keys.includes(r.taskKey));
    const before = (await this.taskResults(tenantId, base.id)).filter((r) => keys.includes(r.taskKey));
    const rate = (rs: TaskRunResult[]) => (rs.length ? rs.filter((r) => r.passed).length / rs.length : 0);
    const suiteSize = (await this.suiteTasks(tenantId, base.suite_id)).filter((t) => t.enabled === 1).length || 1;
    const delta = Math.round(100 * 0.45 * (rate(after) - rate(before)) * (keys.length / suiteSize));
    await this.d.db.updateTable('suggestions').where('tenant_id', '=', tenantId).set({ status: 'verified', verified_delta: delta, updated_at: this.d.clock.now() }).where('id', '=', sg.id).execute();
  }

  /** Apply (§14.11): write the patch into the overlay draft, or publish it as a new revision. */
  async apply(tenantId: string, id: string, mode: 'draft' | 'publish', message: string | null, by: string | null): Promise<{ suggestion: SuggestionRowDb; draftYaml?: string; revisionId?: string }> {
    const sg = await this.suggestion(tenantId, id);
    const ops = EvalsService.patchOf(sg).ops;
    const draft = await this.d.db.selectFrom('overlay_drafts').where('tenant_id', '=', tenantId).selectAll().where('server_id', '=', sg.server_id).executeTakeFirst();
    const baseYaml = draft?.yaml ?? (await this.publishedYaml(tenantId, sg.server_id));
    const yaml = applyOverlayPatch(baseYaml, ops as never).yaml;
    const now = this.d.clock.now();
    if (mode === 'publish') {
      const r = await this.d.servers.publishOverlay(tenantId, sg.server_id, yaml, { message: message ?? `Apply suggestion ${sg.kind} (${JSON.parse(sg.tools).join(', ')})`, source: 'suggestion', createdBy: by, basedOnRev: null });
      if (draft) await this.d.db.deleteFrom('overlay_drafts').where('tenant_id', '=', tenantId).where('server_id', '=', sg.server_id).execute();
      await this.d.db.updateTable('suggestions').where('tenant_id', '=', tenantId).set({ status: 'applied', updated_at: now }).where('id', '=', id).execute();
      return { suggestion: await this.suggestion(tenantId, id), revisionId: r.revisionId };
    }
    const cur = await this.d.db.selectFrom('servers').where('tenant_id', '=', tenantId).select('published_overlay_revision_id').where('id', '=', sg.server_id).executeTakeFirst();
    const basedOn = cur?.published_overlay_revision_id ? ((await this.d.db.selectFrom('overlay_revisions').where('tenant_id', '=', tenantId).select('rev').where('id', '=', cur.published_overlay_revision_id).executeTakeFirst())?.rev ?? null) : null;
    if (draft) await this.d.db.updateTable('overlay_drafts').where('tenant_id', '=', tenantId).set({ yaml, change_count: draft.change_count + ops.length, updated_by: by, updated_at: now }).where('server_id', '=', sg.server_id).execute();
    else await this.d.db.insertInto('overlay_drafts').values({ server_id: sg.server_id, tenant_id: tenantId, yaml, based_on_rev: basedOn, change_count: ops.length, changes: toJsonColumn([]), updated_by: by, updated_at: now }).execute();
    await this.d.db.updateTable('suggestions').where('tenant_id', '=', tenantId).set({ status: 'applied', updated_at: now }).where('id', '=', id).execute();
    return { suggestion: await this.suggestion(tenantId, id), draftYaml: yaml };
  }

  async dismiss(tenantId: string, id: string): Promise<SuggestionRowDb> {
    await this.suggestion(tenantId, id);
    await this.d.db.updateTable('suggestions').where('tenant_id', '=', tenantId).set({ status: 'dismissed', updated_at: this.d.clock.now() }).where('id', '=', id).execute();
    return this.suggestion(tenantId, id);
  }
}
