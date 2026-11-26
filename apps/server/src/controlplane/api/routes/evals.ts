import { tenantOf } from '../../auth/guards.js';
import { gunzipSync } from 'node:zlib';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { applyOverlayPatch } from '@neurouter/compiler';
import type { ReadinessScore as EvalScore, TaskRunResult } from '@neurouter/evals';
import { api, type EvalRunRow, type EvalSuiteRow, type EvalTaskRow, type MatrixCell, type ReadinessScore, type SuggestionRow, type TaskResultRow, type TranscriptItem } from '@neurouter/shared';
import { toIso, toIsoOrNull } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { newId } from '../../../kernel/lib/ids.js';
import { parseJsonColumn, toJsonColumn } from '../../../kernel/lib/json.js';
import { clampLimit, decodeCursor, toPage } from '../../../kernel/lib/pagination.js';
import { EvalsService, type EvalRunRowDb, type EvalSuiteRowDb, type EvalTaskRowDb, type SuggestionRowDb } from '../../evals/evals.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { OverlayDrafts } from './overlays.js';


const userOf = (req: unknown): string | null => ((req as { user?: { id: string } }).user?.id ?? null);

/** `evals.*`, `suggestions.*` (§14.11, §14.15). `readiness.get` lives with the server views. */
export async function evalsRoutes(app: FastifyInstance, c0: ApiContext): Promise<void> {
  const c = c0;
  if (!c.evals) return;
  const ev = c.evals;
  const db = c.dbs.main.db;
  const drafts = new OverlayDrafts(c);

  const suiteRow = async (s: EvalSuiteRowDb): Promise<EvalSuiteRow> => {
    const tasks = await db.selectFrom('eval_tasks').where('tenant_id', '=', s.tenant_id).select(['category']).where('suite_id', '=', s.id).execute();
    const by = { single: 0, multi: 0, ambiguous: 0, impossible: 0 };
    for (const t of tasks) by[t.category]++;
    const gen = parseJsonColumn<{ model?: string; promptVersion?: string; seed?: number }>(s.generator) ?? {};
    const b = s.generated_from_build_id ? await db.selectFrom('builds').where('tenant_id', '=', s.tenant_id).select(['id', 'hash']).where('id', '=', s.generated_from_build_id).executeTakeFirst() : undefined;
    return { id: s.id, serverId: s.server_id, version: s.version, status: s.status, taskCount: tasks.length, byCategory: by, generatedFromBuild: b ? { id: b.id, hash: b.hash } : null, generator: gen.model ? { model: gen.model, promptVersion: gen.promptVersion ?? '', seed: gen.seed ?? null } : null, createdAt: toIso(s.created_at), frozenAt: toIsoOrNull(s.frozen_at) };
  };
  const taskRow = (t: EvalTaskRowDb): EvalTaskRow => ({ id: t.id, key: t.key, category: t.category, prompt: t.prompt, rubric: t.rubric, assertions: parseJsonColumn(t.assertions) ?? [], referenceCalls: parseJsonColumn(t.reference_calls) ?? [], seedState: parseJsonColumn(t.seed_state), tags: parseJsonColumn(t.tags) ?? [], enabled: t.enabled === 1, source: t.source });
  const runRow = async (r: EvalRunRowDb): Promise<EvalRunRow> => {
    const s = await db.selectFrom('servers').where('tenant_id', '=', r.tenant_id).select(['id', 'slug', 'name']).where('id', '=', r.server_id).executeTakeFirst();
    const e = await db.selectFrom('environments').where('tenant_id', '=', r.tenant_id).select(['id', 'slug', 'name']).where('id', '=', r.environment_id).executeTakeFirst();
    const suite = r.suite_id ? await db.selectFrom('eval_suites').where('tenant_id', '=', r.tenant_id).select(['id', 'version']).where('id', '=', r.suite_id).executeTakeFirst() : undefined;
    const b = await db.selectFrom('builds').where('tenant_id', '=', r.tenant_id).select(['id', 'hash', 'temporary']).where('id', '=', r.build_id).executeTakeFirst();
    const ov = r.overlay_revision_id ? await db.selectFrom('overlay_revisions').where('tenant_id', '=', r.tenant_id).select('rev').where('id', '=', r.overlay_revision_id).executeTakeFirst() : undefined;
    return {
      id: r.id,
      server: { id: r.server_id, slug: s?.slug ?? '', name: s?.name ?? '(deleted)' },
      suite: { id: suite?.id ?? r.suite_id, version: suite?.version ?? 0 },
      environment: { id: r.environment_id, slug: e?.slug ?? '', name: e?.name ?? '(deleted)' },
      build: { id: r.build_id, hash: b?.hash ?? '' },
      overlayRev: ov?.rev ?? null,
      temporaryBuild: b?.temporary === 1,
      models: parseJsonColumn<string[]>(r.models) ?? [],
      modes: parseJsonColumn(r.modes) ?? [],
      repeats: r.repeats,
      status: r.status,
      progress: { done: 0, total: 0, ...(parseJsonColumn<{ done: number; total: number }>(r.progress) ?? {}) },
      headline: r.headline,
      recommendedMode: (r.recommended_mode as 'tool' | 'code' | null) ?? null,
      confidence: (r.confidence as EvalRunRow['confidence']) ?? null,
      trigger: r.trigger,
      baseRunId: r.base_run_id,
      error: r.error,
      createdAt: toIso(r.created_at),
      startedAt: toIsoOrNull(r.started_at),
      endedAt: toIsoOrNull(r.ended_at),
      usage: parseJsonColumn(r.usage) ?? {},
    } as EvalRunRow;
  };
  const apiScore = (r: EvalRunRowDb): ReadinessScore | null => {
    const s = ev.score(r) as EvalScore | null;
    if (!s) return null;
    return { headline: s.headline, band: s.band, confidence: s.confidence, recommendedMode: s.recommendedMode, recommendation: s.recommendationText ?? null, primaryModel: (parseJsonColumn<string[]>(r.models) ?? [''])[0]!, modeScores: s.modeScores, breakdown: s.breakdown, cells: s.cells.map((x) => ({ model: x.model, mode: x.mode, score: x.score, components: x.components })) };
  };
  const matrix = (r: EvalRunRowDb): MatrixCell[] => ((ev.score(r) as EvalScore | null)?.cells ?? []).map((x) => ({ model: x.model, mode: x.mode, successRate: x.successRate, score: x.score, avgTokens: x.avgTokens, avgCalls: x.avgCalls, avgLatencyMs: x.avgLatencyMs, flakyTasks: x.flakyTasks, excludedAttempts: x.excludedFallback ?? 0, best: x.best }));
  const taskResults = async (r: EvalRunRowDb, filter: { model?: string; mode?: string; passed?: boolean; category?: string } = {}): Promise<TaskResultRow[]> => {
    const tasks = r.suite_id ? await ev.suiteTasks(r.tenant_id, r.suite_id) : [];
    const runs = await db.selectFrom('eval_task_runs').select(['id', 'task_id', 'model', 'mode', 'passed', 'failure_cause', 'input_tokens', 'output_tokens', 'tool_calls']).where('run_id', '=', r.id).where('tenant_id', '=', r.tenant_id).execute();
    const out: TaskResultRow[] = [];
    for (const t of tasks) {
      if (filter.category && t.category !== filter.category) continue;
      const mine = runs.filter((x) => x.task_id === t.id && (!filter.model || x.model === filter.model) && (!filter.mode || x.mode === filter.mode));
      if (!mine.length) continue;
      const cells = new Map<string, TaskResultRow['cells'][number]>();
      for (const x of mine) {
        const k = `${x.model}|${x.mode}`;
        const cell = cells.get(k) ?? { model: x.model, mode: x.mode, passes: 0, attempts: 0, flaky: false, failureCause: null, avgTokens: 0, avgCalls: 0, taskRunIds: [] };
        cell.attempts++;
        if (x.passed === 1) cell.passes++;
        else cell.failureCause ??= (x.failure_cause as never) ?? null;
        cell.avgTokens += x.input_tokens + x.output_tokens;
        cell.avgCalls += x.tool_calls;
        cell.taskRunIds.push(x.id);
        cells.set(k, cell);
      }
      for (const cell of cells.values()) {
        cell.flaky = cell.passes > 0 && cell.passes < cell.attempts;
        cell.avgTokens = Math.round(cell.avgTokens / cell.attempts);
        cell.avgCalls = Math.round((cell.avgCalls / cell.attempts) * 10) / 10;
      }
      const row = { taskId: t.id, key: t.key, category: t.category, prompt: t.prompt, cells: [...cells.values()] };
      if (filter.passed !== undefined && row.cells.every((x) => (x.passes === x.attempts) !== filter.passed)) continue;
      out.push(row);
    }
    return out;
  };
  const suggestionRow = async (s: SuggestionRowDb): Promise<SuggestionRow> => {
    const ids = parseJsonColumn<string[]>(s.affected_task_ids) ?? [];
    // tenant-scope: child-of-scoped (task ids of a tenant-scoped run)
    const keys = ids.length ? (await db.selectFrom('eval_tasks').select(['id', 'key']).where('id', 'in', ids).execute()).map((t) => t.key) : [];
    return { id: s.id, runId: s.run_id, serverId: s.server_id, cause: (s.cause === 'toolset_size' ? 'wrong_tool' : s.cause) as SuggestionRow['cause'], kind: s.kind, tools: parseJsonColumn<string[]>(s.tools) ?? [], affectedTaskKeys: keys.length ? keys : ids, overlayPatch: EvalsService.patchOf(s).yaml, specPatch: s.spec_patch, rationale: s.rationale, predictedDelta: s.predicted_delta, status: s.status, verifyRunId: s.verify_run_id, verifiedDelta: s.verified_delta, createdAt: toIso(s.created_at), updatedAt: toIso(s.updated_at) };
  };
  const suiteOr404 = async (req: FastifyRequest, id: string) => {
    const s = await db.selectFrom('eval_suites').selectAll().where('id', '=', id).where('tenant_id', '=', tenantOf(req)).executeTakeFirst();
    if (!s) throw AppError.notFound('Eval suite');
    return s;
  };

  route(app, 'evals.suites', api.evals.suites, async (req) => {
    const rows = await db.selectFrom('eval_suites').where('tenant_id', '=', tenantOf(req)).selectAll().where('server_id', '=', req.params.id).orderBy('version', 'desc').execute();
    return { items: await Promise.all(rows.map(suiteRow)) };
  });

  route(app, 'evals.generateSuite', api.evals.generateSuite, async (req, reply) => {
    await ev.llm(tenantOf(req));
    const b = req.body ?? {};
    const jobId = await c.jobs.start(tenantOf(req), 'eval_generate', { serverId: req.params.id }, userOf(req), async () => suiteRow(await ev.generateSuite(tenantOf(req), req.params.id, { ...(b.counts ? { counts: b.counts } : {}), ...(b.model ? { model: b.model } : {}), ...(b.seed !== undefined ? { seed: b.seed } : {}), instructions: b.instructions ?? null, createdBy: userOf(req) })));
    return reply.status(202).send({ jobId, status: 'running' } as never);
  });

  route(app, 'evals.suite', api.evals.suite, async (req) => {
    const s = await suiteOr404(req, req.params.id);
    return { ...(await suiteRow(s)), tasks: (await ev.suiteTasks(tenantOf(req), s.id)).map(taskRow), diagnostics: [] };
  });

  route(app, 'evals.updateTask', api.evals.updateTask, async (req) => {
    const t = await db.selectFrom('eval_tasks').selectAll().where('id', '=', req.params.id).where('tenant_id', '=', tenantOf(req)).executeTakeFirst();
    if (!t) throw AppError.notFound('Eval task');
    if ((await suiteOr404(req, t.suite_id)).status === 'frozen') throw AppError.conflict('The suite is frozen');
    const b = req.body;
    await db
      .updateTable('eval_tasks').where('tenant_id', '=', tenantOf(req))
      .set({ ...(b.prompt !== undefined ? { prompt: b.prompt } : {}), ...(b.rubric !== undefined ? { rubric: b.rubric } : {}), ...(b.assertions ? { assertions: toJsonColumn(b.assertions) } : {}), ...(b.referenceCalls ? { reference_calls: toJsonColumn(b.referenceCalls) } : {}), ...(b.enabled !== undefined ? { enabled: b.enabled ? 1 : 0 } : {}) })
      .where('id', '=', t.id)
      .execute();
    return taskRow((await db.selectFrom('eval_tasks').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', t.id).executeTakeFirst())!);
  });

  route(app, 'evals.createTask', api.evals.createTask, async (req, reply) => {
    const s = await suiteOr404(req, req.params.id);
    if (s.status === 'frozen') throw AppError.conflict('The suite is frozen');
    const b = req.body as { key?: string; category: EvalTaskRow['category']; prompt: string; rubric?: string; assertions?: unknown[]; referenceCalls?: unknown[]; tags?: string[] };
    const id = newId();
    await db.insertInto('eval_tasks').values({ id, tenant_id: tenantOf(req), suite_id: s.id, key: b.key ?? `manual-${id.slice(-8)}`, category: b.category, prompt: b.prompt, rubric: b.rubric ?? '', assertions: toJsonColumn(b.assertions ?? []), reference_calls: toJsonColumn(b.referenceCalls ?? []), tags: toJsonColumn(b.tags ?? []), enabled: 1, source: 'manual' }).execute();
    await db.updateTable('eval_suites').where('tenant_id', '=', tenantOf(req)).set({ task_count: s.task_count + 1 }).where('id', '=', s.id).execute();
    return reply.status(201).send(taskRow((await db.selectFrom('eval_tasks').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', id).executeTakeFirst())!) as never);
  });

  route(app, 'evals.freezeSuite', api.evals.freezeSuite, async (req) => {
    const s = await suiteOr404(req, req.params.id);
    if (s.status !== 'frozen') await db.updateTable('eval_suites').where('tenant_id', '=', tenantOf(req)).set({ status: 'frozen', frozen_at: c.clock.now() }).where('id', '=', s.id).execute();
    return suiteRow(await suiteOr404(req, s.id));
  });

  route(app, 'evals.runs', api.evals.runs, async (req) => {
    const q = req.query;
    const limit = clampLimit(q.limit);
    const cur = decodeCursor(q.cursor);
    let qb = db.selectFrom('eval_runs').selectAll().where('tenant_id', '=', tenantOf(req));
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.status?.length) qb = qb.where('status', 'in', q.status);
    if (q.trigger) qb = qb.where('trigger', '=', q.trigger);
    if (cur) qb = qb.where((eb) => eb.or([eb('created_at', '<', Number(cur[0])), eb.and([eb('created_at', '=', Number(cur[0])), eb('id', '<', String(cur[1]))])]));
    const rows = await qb.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1).execute();
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at, r.id]);
    return { ...page, items: await Promise.all(page.items.map(runRow)) };
  });

  route(app, 'evals.createRun', api.evals.createRun, async (req, reply) => {
    const b = req.body;
    let buildId = b.buildId ?? null;
    if (b.overlay && 'draft' in b.overlay) {
      const s = await c.servers.get(tenantOf(req), b.serverId);
      const cur = await drafts.current(s);
      const t = await c.builds.build(b.serverId, s.current_spec_revision_id!, null, { temporary: true, overlayYaml: cur.yaml, pin: false });
      if (t.build.status !== 'ok') throw new AppError('build_failed', 'The overlay draft does not compile');
      buildId = t.build.id;
    } else if (b.overlay && 'revisionId' in b.overlay) {
      const s = await c.servers.get(tenantOf(req), b.serverId);
      const t = await c.builds.build(b.serverId, s.current_spec_revision_id!, b.overlay.revisionId, { temporary: true, pin: false });
      buildId = t.build.id;
    }
    let taskKeys: string[] | null = null;
    if (Array.isArray(b.taskSet)) taskKeys = b.taskSet;
    else if (typeof b.taskSet === 'string' && b.taskSet.startsWith('failed_in:')) {
      const base = await ev.run(tenantOf(req), b.taskSet.slice('failed_in:'.length));
      taskKeys = [...new Set((await ev.taskResults(tenantOf(req), base.id)).filter((r: TaskRunResult) => !r.passed).map((r) => r.taskKey))];
    }
    const run = await ev.createRun(tenantOf(req), { serverId: b.serverId, suiteId: b.suiteId ?? null, environmentId: b.environmentId ?? null, models: b.models ?? null, modes: b.modes ?? null, repeats: b.preset === 'quick' ? 1 : (b.repeats ?? null), buildId, preset: b.preset ?? null, taskKeys, trigger: 'console', createdBy: userOf(req) });
    return reply.status(202).send((await runRow(run)) as never);
  });

  route(app, 'evals.compare', api.evals.compare, async (req) => {
    const base = await ev.run(tenantOf(req), req.query.base);
    const head = await ev.run(tenantOf(req), req.query.head);
    if (base.server_id !== head.server_id) throw AppError.validation('Runs of different servers cannot be compared', [{ path: ['head'], message: 'different server', code: 'different_servers' }]);
    const bs = ev.score(base) as EvalScore | null;
    const hs = ev.score(head) as EvalScore | null;
    const mb = matrix(base);
    const mh = matrix(head);
    const keys = [...new Set([...mb, ...mh].map((x) => `${x.model}|${x.mode}`))];
    const tb = await taskResults(base);
    const th = await taskResults(head);
    const pass = (rows: TaskResultRow[], k: string) => {
      const r = rows.find((x) => x.key === k);
      if (!r) return null;
      const p = r.cells.reduce((a, x) => a + x.passes, 0);
      const n = r.cells.reduce((a, x) => a + x.attempts, 0);
      return `${p}/${n}`;
    };
    const avg = (m: MatrixCell[], f: (x: MatrixCell) => number) => (m.length ? m.reduce((a, x) => a + f(x), 0) / m.length : null);
    const tk = (bt: number | null, ht: number | null) => (bt !== null && ht !== null ? Math.round((ht - bt) * 10) / 10 : null);
    return {
      base: await runRow(base),
      head: await runRow(head),
      scoreDelta: base.headline !== null && head.headline !== null ? head.headline - base.headline : null,
      components: (hs?.breakdown ?? bs?.breakdown ?? []).map((comp) => ({ key: comp.key, label: comp.label, base: bs?.breakdown.find((x) => x.key === comp.key)?.score ?? null, head: hs?.breakdown.find((x) => x.key === comp.key)?.score ?? null })),
      matrix: keys.map((k) => {
        const [model, mode] = k.split('|') as [string, 'tool' | 'code'];
        return { model, mode, base: mb.find((x) => x.model === model && x.mode === mode) ?? null, head: mh.find((x) => x.model === model && x.mode === mode) ?? null };
      }),
      tasks: [...new Set([...tb, ...th].map((x) => x.key))].map((k) => ({ taskKey: k, category: (th.find((x) => x.key === k) ?? tb.find((x) => x.key === k))?.category ?? null, base: pass(tb, k), head: pass(th, k) })),
      tokensDelta: tk(avg(mb, (x) => x.avgTokens), avg(mh, (x) => x.avgTokens)),
      callsDelta: tk(avg(mb, (x) => x.avgCalls), avg(mh, (x) => x.avgCalls)),
    };
  });

  route(app, 'evals.run', api.evals.run, async (req) => {
    const r = await ev.run(tenantOf(req), req.params.id);
    const sc = await db.selectFrom('suggestions').where('tenant_id', '=', tenantOf(req)).select((eb) => eb.fn.countAll<number>().as('n')).where('run_id', '=', r.id).executeTakeFirst();
    return { ...(await runRow(r)), score: apiScore(r), matrix: matrix(r), tasks: await taskResults(r), suggestionsCount: Number(sc?.n ?? 0), correctness: null };
  });

  route(app, 'evals.runTasks', api.evals.runTasks, async (req) => {
    const r = await ev.run(tenantOf(req), req.params.id);
    const q = req.query;
    const rows = await taskResults(r, { ...(q.model ? { model: q.model } : {}), ...(q.mode ? { mode: q.mode } : {}), ...(q.passed !== undefined ? { passed: q.passed } : {}), ...(q.category ? { category: q.category } : {}) });
    const limit = clampLimit(q.limit);
    const offset = Number(decodeCursor(q.cursor)?.[0] ?? 0);
    const slice = rows.slice(offset, offset + limit);
    return { items: slice, nextCursor: offset + limit < rows.length ? Buffer.from(JSON.stringify({ k: [offset + limit] })).toString('base64url') : null };
  });

  route(app, 'evals.taskRun', api.evals.taskRun, async (req) => {
    const r = await db.selectFrom('eval_task_runs').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', req.params.taskRunId).where('run_id', '=', req.params.id).executeTakeFirst();
    if (!r) throw AppError.notFound('Task run');
    const t = await db.selectFrom('eval_tasks').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', r.task_id).executeTakeFirstOrThrow();
    const tr = r.transcript ? (JSON.parse(gunzipSync(r.transcript).toString('utf8')) as { transcript: Array<Record<string, unknown>> }) : { transcript: [] };
    const items: TranscriptItem[] = tr.transcript.map((x) => {
      switch (x.kind) {
        case 'user':
          return { type: 'user', text: String(x.text ?? '') };
        case 'assistant':
          return { type: 'assistant', text: String(x.text ?? '') };
        case 'tool_call':
          return { type: 'tool_call', id: String(x.id ?? ''), tool: String(x.name ?? ''), arguments: x.arguments ?? {} };
        case 'tool_result':
          return { type: 'tool_result', id: String(x.id ?? ''), tool: String(x.name ?? ''), isError: Boolean(x.isError), content: String(x.text ?? ''), ...(x.truncated ? { truncated: true } : {}) };
        default:
          return { type: 'note', text: String(x.text ?? JSON.stringify(x)) };
      }
    });
    const final = [...items].reverse().find((x) => x.type === 'assistant');
    return {
      id: r.id,
      runId: r.run_id,
      task: taskRow(t),
      model: r.model,
      mode: r.mode,
      attempt: r.attempt,
      passed: r.passed === 1,
      assertionResults: (parseJsonColumn<Array<{ assertion: never; passed: boolean; detail: string }>>(r.assertion_results) ?? []).map((a) => ({ assertion: a.assertion, passed: Boolean(a.passed), detail: String(a.detail ?? '') })),
      judge: parseJsonColumn<never>(r.judge),
      failureCause: (r.failure_cause as never) ?? null,
      toolCalls: r.tool_calls,
      scripts: r.scripts,
      tokens: { inputTokens: r.input_tokens, outputTokens: r.output_tokens },
      latencyMs: r.latency_ms,
      servedByModel: r.served_by_model,
      fallbackUsed: r.fallback_used === 1,
      neurouterTaskId: r.task_id_neurouter,
      finalAnswer: final && final.type === 'assistant' ? final.text : null,
      transcript: items,
      createdAt: toIso(r.created_at),
    };
  });

  route(app, 'evals.cancelRun', api.evals.cancelRun, async (req) => runRow(await ev.cancel(tenantOf(req), req.params.id)));

  /* ---------------------------------------------------------------- suggestions */

  route(app, 'suggestions.list', api.suggestions.list, async (req) => {
    const rows = await db.selectFrom('suggestions').where('tenant_id', '=', tenantOf(req)).selectAll().where('run_id', '=', req.params.id).orderBy('predicted_delta', 'desc').execute();
    return { items: await Promise.all(rows.map(suggestionRow)) };
  });

  route(app, 'suggestions.search', api.suggestions.search, async (req) => {
    const q = req.query;
    const limit = clampLimit(q.limit);
    let qb = db.selectFrom('suggestions').selectAll().where('tenant_id', '=', tenantOf(req));
    if (q.serverId) qb = qb.where('server_id', '=', q.serverId);
    if (q.status?.length) qb = qb.where('status', 'in', q.status);
    const cur = decodeCursor(q.cursor);
    if (cur) qb = qb.where('created_at', '<', Number(cur[0]));
    let rows = await qb.orderBy('created_at', 'desc').limit(limit + 1).execute();
    if (q.toolName) rows = rows.filter((r) => (parseJsonColumn<string[]>(r.tools) ?? []).includes(q.toolName!));
    const page = toPage(rows, limit, (r) => r, (r) => [r.created_at]);
    return { ...page, items: await Promise.all(page.items.map(suggestionRow)) };
  });

  route(app, 'suggestions.get', api.suggestions.get, async (req) => {
    const s = await ev.suggestion(tenantOf(req), req.params.id);
    const vr = s.verify_run_id ? await ev.run(tenantOf(req), s.verify_run_id).catch(() => null) : null;
    const run = await ev.run(tenantOf(req), s.run_id);
    const affected = parseJsonColumn<string[]>(s.affected_task_ids) ?? [];
    return { ...(await suggestionRow(s)), verifyRun: vr ? await runRow(vr) : null, affectedTasks: (await taskResults(run)).filter((t) => affected.includes(t.taskId) || affected.includes(t.key)) };
  });

  route(app, 'suggestions.verify', api.suggestions.verify, async (req, reply) => reply.status(202).send((await suggestionRow(await ev.verify(tenantOf(req), req.params.id, userOf(req)))) as never));

  route(app, 'suggestions.apply', api.suggestions.apply, async (req) => {
    const sg = await ev.suggestion(tenantOf(req), req.params.id);
    const s = await c.servers.get(tenantOf(req), sg.server_id);
    const ops = EvalsService.patchOf(sg).ops;
    const mode = req.body?.mode ?? 'draft';
    if (mode === 'publish') {
      const r = await ev.apply(tenantOf(req), sg.id, 'publish', req.body?.message ?? null, userOf(req));
      const rev = await db.selectFrom('overlay_revisions').where('tenant_id', '=', tenantOf(req)).selectAll().where('id', '=', r.revisionId!).executeTakeFirstOrThrow();
      const b = await db.selectFrom('builds').where('tenant_id', '=', tenantOf(req)).selectAll().where('overlay_revision_id', '=', rev.id).orderBy('created_at', 'desc').executeTakeFirstOrThrow();
      const pinned = await db.selectFrom('environments').where('tenant_id', '=', tenantOf(req)).select(['id', 'slug']).where('build_id', '=', b.id).execute();
      return { suggestion: await suggestionRow(r.suggestion), publish: { revision: await c.views.overlayRow(rev), build: await c.views.buildRow(b), pinnedEnvironments: pinned } };
    }
    const cur = await drafts.current(s);
    const yaml = applyOverlayPatch(cur.yaml, ops as never).yaml;
    await drafts.save(s, yaml, cur.basedOnRev, userOf(req) ?? '');
    await db.updateTable('suggestions').where('tenant_id', '=', tenantOf(req)).set({ status: 'applied', updated_at: c.clock.now() }).where('id', '=', sg.id).execute();
    return { suggestion: await suggestionRow(await ev.suggestion(tenantOf(req), sg.id)), draft: await drafts.view(s) };
  });

  route(app, 'suggestions.dismiss', api.suggestions.dismiss, async (req) => suggestionRow(await ev.dismiss(tenantOf(req), req.params.id)));
}
