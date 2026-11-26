import { readFileSync, writeFileSync } from 'node:fs';
import {
  buildReport,
  migrateSuite,
  regradeByCategory,
  regradeSummary,
  regradeTranscripts,
  renderRegradeCategories,
  renderCalibration,
  renderMarkdown,
  renderTable,
  suiteDataVersion,
  type EvalReport,
  type EvalTask,
  type SuiteCalibration,
  type SuiteFile,
  type TranscriptEntry,
} from '@neurouter/evals';
import { startServer, type RunningServer } from '@neurouter/server';
import { providerForModel } from '@neurouter/shared';
import { readSpec, serverEnv } from './common.js';

interface EvalOpts {
  config?: string;
  server?: string;
  spec?: string;
  overlay?: string;
  suite?: string;
  generate?: boolean;
  counts: string;
  saveSuite?: string;
  maxGeneratorTokens?: string;
  models?: string;
  modes: string;
  repeats: string;
  env: string;
  minScore?: string;
  out?: string;
  md?: string;
  transcripts?: string;
  transcriptMaxChars?: string;
  suggest?: boolean;
  embeddings?: boolean;
  maxRunTokens?: string;
  calibrate?: boolean;
  calibrateWith?: string;
  calibrateOnly?: boolean;
  migrateSuite?: string;
  regrade?: string;
  judgeModel?: string;
  maxJudgeTokens?: string;
  contract?: string;
}

const positiveInt = (v: string | undefined, flag: string): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${flag} must be a positive integer`);
  return n;
};

/**
 * `npx neurouter eval` (§15.8). Without --config it boots an in-process server (temporary SQLite,
 * embeddings off) on 127.0.0.1, creates a server from --spec with a `mock:` environment, generates or
 * loads the suite, runs it, prints a table and writes JSON/Markdown. Exit 0 ok, 1 below --min-score, 2 error.
 */
export async function cmdEval(o: EvalOpts): Promise<void> {
  if (!o.config && !o.spec) throw new Error('pass --spec <file|url> or --config neurouter.yaml --server <slug>');
  const maxRunTokens = positiveInt(o.maxRunTokens, '--max-run-tokens');
  const maxJudgeTokens = positiveInt(o.maxJudgeTokens, '--max-judge-tokens') ?? 300_000;
  if (o.regrade && !o.suite) throw new Error('--regrade <transcripts.json> needs --suite <suite.json> (the suite the transcripts ran, or its migrated version)');
  if (o.migrateSuite && o.suite) throw new Error('pass either --migrate-suite <old.json> or --suite <file>');
  if (o.contract !== undefined && o.contract !== '1' && o.contract !== '2') throw new Error('--contract must be 1 or 2');
  if (o.contract !== undefined && o.config) throw new Error('--contract applies to the server eval creates from --spec; with --config the server\'s exposure.contract decides');
  const contractFlag = o.contract === undefined ? undefined : (Number(o.contract) as 1 | 2);
  const env = serverEnv({ inMemory: !o.config, port: 0, host: '127.0.0.1', ...(o.config ? { config: o.config, data: './.neurouter' } : {}), ...(o.embeddings ? { embeddings: true } : {}) });
  env.PORT = '0';
  delete env.PUBLIC_URL;
  env.NEUROUTER_EXECUTOR_MODE ??= 'embedded';
  // a throwaway in-process server: mock state stays in memory (no DB tables to fill and GC)
  if (!o.config) env.NEUROUTER_MOCK_STORE ??= 'memory';
  let running: RunningServer | null = null;
  try {
    running = await startServer({ env, loadDotenv: false, jobs: false });
    const s = running.services;
    const tenant = (await s.tenancy.defaultTenant())?.id;
    if (!tenant) throw new Error('this deployment has no default organization');
    let serverId: string;
    let slug: string;
    if (o.config) {
      if (!o.server) throw new Error('--server <slug> is required with --config');
      const srv = await s.servers.bySlug(tenant, o.server);
      if (!srv) throw new Error(`unknown server ${o.server}`);
      serverId = srv.id;
      slug = srv.slug;
    } else {
      const bytes = await readSpec(o.spec!);
      slug = 'api';
      const created = await s.servers.create({ tenantId: tenant, slug, name: o.spec!.split('/').pop() ?? 'API', spec: { bytes, sourceUrl: /^https?:/.test(o.spec!) ? o.spec! : null }, specSource: { path: o.spec }, createdBy: null, overlay: o.overlay ? { yaml: readFileSync(o.overlay, 'utf8'), source: 'file', message: o.overlay } : null, ...(contractFlag ? { exposure: { contract: contractFlag } } : {}) });
      serverId = created.server.id;
      if (created.build.build.status !== 'ok') throw new Error(`spec does not compile: ${created.build.result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
    }
    const envRow = (await s.servers.environments(serverId)).find((e) => e.slug === o.env);
    if (!envRow) throw new Error(`unknown environment ${o.env}`);
    // the agent contract the eval's MCP sessions get (the eval client does not negotiate one): environment, else server
    const contract = contractOfServer((await s.servers.get(tenant, serverId)).exposure, envRow);
    console.error(`agent contract ${contract} (${contractFlag ? '--contract' : o.config ? 'the server\'s exposure.contract' : 'NEUROUTER_NEW_SERVER_CONTRACT'})`);
    // migrate a 0.2.1 suite file: v1 ground truth from the mock, then the calibration gate below
    if (o.migrateSuite) {
      const old = JSON.parse(readFileSync(o.migrateSuite, 'utf8')) as SuiteFile;
      const dv = suiteDataVersion(old) === 1 ? 1 : 2;
      const runner = await s.evals.referenceRunner(tenant, serverId, dv, envRow.id);
      try {
        const migrated = await migrateSuite(old, { tools: runner.tools, groundTruthOf: (t) => runner.groundTruth(runner.resolve([t])[0]!) });
        const out = o.saveSuite ?? o.migrateSuite.replace(/\.json$/, '') + '.v2.json';
        writeFileSync(out, JSON.stringify(migrated, null, 2));
        console.error(`suite migrated to version 2 (mock data v${migrated.mockDataVersion}): ${out}`);
        for (const [k, notes] of Object.entries(migrated.migration?.notes ?? {})) for (const n of notes) console.error(`  ${k}: ${n}`);
        o.suite = out;
        o.saveSuite = out;
        o.calibrateOnly = o.calibrateOnly ?? true;
      } finally {
        await runner.close();
      }
    }
    // suite: load, or generate
    let suiteId: string;
    let generated: EvalReport['generator'] | undefined;
    let suiteFile: SuiteFile | null = null;
    let calibration: SuiteCalibration | null = null;
    if (o.suite && !o.generate) {
      suiteFile = JSON.parse(readFileSync(o.suite, 'utf8')) as SuiteFile;
      const suite = await s.evals.saveSuite(tenant, serverId, null, suiteFile.tasks, { importedFrom: o.suite, mockDataVersion: suiteDataVersion(suiteFile), ...(suiteFile.calibration ? { calibration: suiteFile.calibration } : {}) }, null, true);
      suiteId = suite.id;
      // calibration gate: each task's reference solution through its own assertions (rejected tasks are not run)
      if (o.calibrate !== false && !o.regrade) {
        calibration = await s.evals.calibrateSuite(tenant, serverId, suiteId, { disableRejected: true, environmentId: envRow.id, ...(o.calibrateWith ? { calibrateWith: o.calibrateWith } : {}) });
        console.error(renderCalibration(calibration));
      }
    } else {
      const [single, multi, ambiguous, impossible] = o.counts.split(',').map((x) => Number(x));
      const maxGeneratorTokens = o.maxGeneratorTokens !== undefined ? Number(o.maxGeneratorTokens) : undefined;
      if (maxGeneratorTokens !== undefined && !(maxGeneratorTokens >= 4000)) throw new Error('--max-generator-tokens must be a number ≥ 4000');
      console.error('generating eval suite…');
      const suite = await s.evals.generateSuite(tenant, serverId, { counts: { single: single ?? 8, multi: multi ?? 8, ambiguous: ambiguous ?? 4, impossible: impossible ?? 4 }, ...(maxGeneratorTokens ? { maxGeneratorTokens } : {}), createdBy: null });
      suiteId = suite.id;
      const gen = JSON.parse(suite.generator ?? '{}') as { model?: string; usage?: NonNullable<EvalReport['generator']>['usage']; diagnostics?: Array<{ category: string; key: string | null; message: string }>; coverage?: Record<string, number>; calibration?: SuiteCalibration | null };
      const diags = gen.diagnostics ?? [];
      for (const d of diags) console.error(`generator: ${d.category}${d.key ? ` ${d.key}` : ''}: ${d.message}`);
      const u = gen.usage;
      if (u) console.error(`generator usage: ${u.calls} call(s), ${u.totalTokens} tokens (input ${u.inputTokens}, cached ${u.cacheReadTokens}, output ${u.outputTokens}) of a ${u.budgetTokens}-token budget`);
      if (gen.coverage) console.error(`coverage by tag: ${Object.entries(gen.coverage).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')}`);
      generated = { model: gen.model ?? '', usage: u ?? { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, totalTokens: 0, budgetTokens: 0 }, tasks: suite.task_count, diagnostics: diags.length, ...(gen.coverage ? { coverage: gen.coverage } : {}) };
      calibration = gen.calibration ?? null;
      // an empty suite would "run" and score nothing: stop here, with the reasons above
      if (suite.task_count === 0) {
        console.error('the generator produced no valid tasks; nothing was saved or run (see the generator diagnostics above)');
        process.exitCode = 2;
        return;
      }
      console.error(`suite generated: ${suite.task_count} tasks (each passed calibration: its reference solution passes its own assertions)`);
      if (o.calibrateWith) {
        calibration = await s.evals.calibrateSuite(tenant, serverId, suiteId, { calibrateWith: o.calibrateWith, environmentId: envRow.id });
        console.error(renderCalibration(calibration));
      }
    }
    const tasks = (await s.evals.suiteTasks(tenant, suiteId)).map((r) => ({ key: r.key, category: r.category, prompt: r.prompt })) as unknown as EvalTask[];
    if (o.saveSuite) {
      const { taskFromRow } = await import('@neurouter/server');
      // the file keeps the tasks as given (a rejected task stays in the file, marked by the calibration)
      const full = suiteFile ? suiteFile.tasks : (await s.evals.suiteTasks(tenant, suiteId)).map(taskFromRow);
      const meta = s.evals.suiteMeta(await s.evals.suiteOf(tenant, serverId, suiteId));
      const file: SuiteFile = {
        ...(suiteFile ?? {}),
        version: 2,
        server: suiteFile?.server ?? slug,
        generatedFrom: suiteFile?.generatedFrom ?? null,
        mockDataVersion: meta.mockDataVersion,
        calibration,
        ...(generated?.coverage ? { coverage: generated.coverage } : {}),
        tasks: full,
      };
      writeFileSync(o.saveSuite, JSON.stringify(file, null, 2));
      console.error(`suite saved to ${o.saveSuite} (${full.length} tasks)`);
    }
    if (o.calibrateOnly) {
      if (calibration && calibration.rejected > 0) process.exitCode = 1;
      return;
    }
    if (o.regrade) {
      await regrade(s, tenant, serverId, suiteId, envRow.id, o, maxJudgeTokens, contract);
      return;
    }
    const modes = o.modes.split(',').map((m) => m.trim()) as Array<'tool' | 'code'>;
    console.error(`running ${tasks.length} tasks × ${modes.join('+')} × ${o.repeats} attempt(s)…`);
    // --transcripts writes what the agent saw and said, untrimmed (the console keeps 4,096 chars per item)
    if (o.transcriptMaxChars !== undefined && !(Number(o.transcriptMaxChars) > 0)) throw new Error('--transcript-max-chars must be a positive number');
    const transcriptMaxChars = o.transcriptMaxChars !== undefined ? Math.floor(Number(o.transcriptMaxChars)) : o.transcripts ? null : undefined;
    const run = await s.evals.createRun(tenant, { serverId, suiteId, environmentId: envRow.id, models: o.models ? o.models.split(',').map((m) => m.trim()) : null, modes, repeats: Number(o.repeats), trigger: 'cli', createdBy: null, wait: true, ...(transcriptMaxChars !== undefined ? { transcriptMaxChars } : {}), ...(maxRunTokens ? { maxRunTokens } : {}) });
    if (run.status !== 'succeeded') throw new Error(`eval run ${run.status}: ${run.error ?? ''}`);
    const score = s.evals.score(run)!;
    const results = await s.evals.taskResults(tenant, run.id);
    const suggestions = await s.dbs.main.db.selectFrom('suggestions').selectAll().where('run_id', '=', run.id).execute();
    const taskRows = await s.evals.suiteTasks(tenant, suiteId);
    const prompts = Object.fromEntries(taskRows.map((t) => [t.key, { category: t.category, prompt: t.prompt }]));
    // suggestions store task-row ids; reports name the suite's task keys
    const keyById = new Map(taskRows.map((t) => [t.id, t.key]));
    const report = buildReport({
      server: { slug, name: slug },
      run: { id: run.id, models: JSON.parse(run.models) as string[], modes, repeats: run.repeats, environment: o.env, buildHash: null, provider: process.env.NEUROUTER_EVAL_LLM === 'stub' || results[0]?.servedByModel === 'stub' ? 'stub' : [...new Set((JSON.parse(run.models) as string[]).map((m) => providerForModel(m) ?? 'unknown'))].join(','), startedAt: new Date(run.started_at ?? run.created_at).toISOString(), endedAt: new Date(run.ended_at ?? Date.now()).toISOString(), contract },
      score,
      suggestions: suggestions.map((x) => ({ cause: x.cause as never, kind: x.kind, tools: JSON.parse(x.tools) as string[], affectedTaskKeys: (JSON.parse(x.affected_task_ids) as string[]).map((id) => keyById.get(id) ?? id), overlayPatch: (JSON.parse(x.overlay_patch) as { yaml: string }).yaml, overlayOps: [], specPatch: x.spec_patch, rationale: x.rationale, predictedDelta: x.predicted_delta })),
      results,
      prompts,
      ...(generated ? { generator: generated } : {}),
      ...(score.incomplete ? { incomplete: score.incomplete } : {}),
      ...(calibration ? { calibration } : {}),
    });
    console.log(renderTable(report));
    if (generated) console.log(`Suite generation: ${generated.usage.totalTokens} tokens over ${generated.usage.calls} call(s) (budget ${generated.usage.budgetTokens})`);
    if (o.suggest) for (const x of report.suggestions) console.log(`\nSuggestion (${x.kind}, +${x.predictedDelta} predicted): ${x.rationale}\n${x.overlayPatch}`);
    if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2));
    if (o.md) writeFileSync(o.md, renderMarkdown(report));
    if (o.transcripts) writeFileSync(o.transcripts, JSON.stringify(results.map((r) => ({ ...r, prompt: prompts[r.taskKey]?.prompt ?? null })), null, 2));
    if (score.incomplete) console.error(`run incomplete: ${score.incomplete.reason}; ${score.incomplete.attemptsRun} of ${score.incomplete.attemptsPlanned} attempts ran`);
    if (o.minScore !== undefined && score.headline < Number(o.minScore)) {
      console.error(`headline ${score.headline} is below --min-score ${o.minScore}`);
      process.exitCode = 1;
    }
  } finally {
    await running?.close();
  }
}

/**
 * `eval --suite <suite> --regrade <transcripts.json>`: re-scores recorded attempts with this grader
 * (ground truth from the mock with the suite's data version), without running agents.
 */
/** The contract of the environment (`discovery_override.contract`, neurouter.yaml), else `exposure.contract` of the server; absent = 1. */
function contractOfServer(serverExposure: string | null, env: { discovery_override?: string | null }): 1 | 2 {
  const read = (j: string | null | undefined): unknown => {
    try {
      return j ? (JSON.parse(j) as { contract?: unknown }).contract : undefined;
    } catch {
      return undefined;
    }
  };
  const c = read(env.discovery_override) ?? read(serverExposure);
  return c === 2 ? 2 : 1;
}

async function regrade(s: RunningServer['services'], tenant: string, serverId: string, suiteId: string, envId: string, o: EvalOpts, maxJudgeTokens: number, contract: 1 | 2): Promise<void> {
  const { taskFromRow } = await import('@neurouter/server');
  const meta = s.evals.suiteMeta(await s.evals.suiteOf(tenant, serverId, suiteId));
  const runner = await s.evals.referenceRunner(tenant, serverId, meta.mockDataVersion, envId);
  try {
    // tasks the suite's calibration rejected are not re-graded (as they are not run)
    const rejected = new Set((meta.calibration?.tasks ?? []).filter((t) => t.status === 'rejected').map((t) => t.key));
    const tasks = runner.resolve((await s.evals.suiteTasks(tenant, suiteId)).map(taskFromRow)).filter((t) => !rejected.has(t.key));
    const entries = JSON.parse(readFileSync(o.regrade!, 'utf8')) as TranscriptEntry[];
    const llm = o.judgeModel ? await s.evals.llm(tenant, [o.judgeModel]) : null;
    const out = await regradeTranscripts(entries, { tasks: new Map(tasks.map((t) => [t.key, t])), groundTruth: (t) => runner.groundTruth(t), llm, ...(o.judgeModel ? { judgeModel: o.judgeModel } : {}), maxJudgeTokens });
    const sum = regradeSummary(out.rows);
    const categories = regradeByCategory(out.rows);
    const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;
    console.log(`${renderRegradeCategories(categories)}\n`);
    console.log(`re-graded ${sum.attempts} attempts: pass rate ${pct(sum.oldPassRate)} → ${pct(sum.newPassRate)} (${sum.flipsUp} fail→pass, ${sum.flipsDown} pass→fail, ${sum.excluded} provider refusals excluded, ${sum.overBudget} over budget, ${sum.matchedByJudge} matched by judge)`);
    const u = out.judgeUsage;
    console.log(`judge usage: ${u.calls} calls, ${u.inputTokens + u.cacheReadTokens + u.outputTokens} tokens (cap ${maxJudgeTokens})`);
    if (out.skippedTasks.length) console.log(`not re-graded (task not in the suite or disabled): ${out.skippedTasks.join(', ')}`);
    if (o.out) writeFileSync(o.out, JSON.stringify({ contract, summary: sum, categories, judgeUsage: u, skippedTasks: out.skippedTasks, rows: out.rows }, null, 2));
  } finally {
    await runner.close();
  }
}
