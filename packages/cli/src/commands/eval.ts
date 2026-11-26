import { readFileSync, writeFileSync } from 'node:fs';
import { buildReport, renderMarkdown, renderTable, type EvalTask, type SuiteFile } from '@neurouter/evals';
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
  models?: string;
  modes: string;
  repeats: string;
  env: string;
  minScore?: string;
  out?: string;
  md?: string;
  suggest?: boolean;
  embeddings?: boolean;
}

/**
 * `npx neurouter eval` (§15.8). Without --config it boots an in-process server (temporary SQLite,
 * embeddings off) on 127.0.0.1, creates a server from --spec with a `mock:` environment, generates or
 * loads the suite, runs it, prints a table and writes JSON/Markdown. Exit 0 ok, 1 below --min-score, 2 error.
 */
export async function cmdEval(o: EvalOpts): Promise<void> {
  if (!o.config && !o.spec) throw new Error('pass --spec <file|url> or --config neurouter.yaml --server <slug>');
  const env = serverEnv({ inMemory: !o.config, port: 0, host: '127.0.0.1', ...(o.config ? { config: o.config, data: './.neurouter' } : {}), ...(o.embeddings ? { embeddings: true } : {}) });
  env.PORT = '0';
  delete env.PUBLIC_URL;
  env.NEUROUTER_EXECUTOR_MODE ??= 'embedded';
  let running: RunningServer | null = null;
  try {
    running = await startServer({ env, loadDotenv: false, jobs: false });
    const s = running.services;
    const tenant = s.tenantId;
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
      const created = await s.servers.create({ tenantId: tenant, slug, name: o.spec!.split('/').pop() ?? 'API', spec: { bytes, sourceUrl: /^https?:/.test(o.spec!) ? o.spec! : null }, specSource: { path: o.spec }, createdBy: null, overlay: o.overlay ? { yaml: readFileSync(o.overlay, 'utf8'), source: 'file', message: o.overlay } : null });
      serverId = created.server.id;
      if (created.build.build.status !== 'ok') throw new Error(`spec does not compile: ${created.build.result.diagnostics.filter((d) => d.severity === 'error').map((d) => d.message).join('; ')}`);
    }
    const envRow = (await s.servers.environments(serverId)).find((e) => e.slug === o.env);
    if (!envRow) throw new Error(`unknown environment ${o.env}`);
    // suite: load, or generate
    let suiteId: string;
    if (o.suite && !o.generate) {
      const file = JSON.parse(readFileSync(o.suite, 'utf8')) as SuiteFile;
      const suite = await s.evals.saveSuite(serverId, null, file.tasks, { importedFrom: o.suite }, null, true);
      suiteId = suite.id;
    } else {
      const [single, multi, ambiguous, impossible] = o.counts.split(',').map((x) => Number(x));
      console.error('generating eval suite…');
      const suite = await s.evals.generateSuite(serverId, { counts: { single: single ?? 8, multi: multi ?? 8, ambiguous: ambiguous ?? 4, impossible: impossible ?? 4 }, createdBy: null });
      suiteId = suite.id;
    }
    const tasks = (await s.evals.suiteTasks(suiteId)).map((r) => ({ key: r.key, category: r.category, prompt: r.prompt })) as unknown as EvalTask[];
    if (o.saveSuite) {
      const { taskFromRow } = await import('@neurouter/server');
      const full = (await s.evals.suiteTasks(suiteId)).map(taskFromRow);
      const file: SuiteFile = { version: 1, server: slug, generatedFrom: null, tasks: full };
      writeFileSync(o.saveSuite, JSON.stringify(file, null, 2));
      console.error(`suite saved to ${o.saveSuite} (${full.length} tasks)`);
    }
    const modes = o.modes.split(',').map((m) => m.trim()) as Array<'tool' | 'code'>;
    console.error(`running ${tasks.length} tasks × ${modes.join('+')} × ${o.repeats} attempt(s)…`);
    const run = await s.evals.createRun({ serverId, suiteId, environmentId: envRow.id, models: o.models ? o.models.split(',').map((m) => m.trim()) : null, modes, repeats: Number(o.repeats), trigger: 'cli', createdBy: null, wait: true });
    if (run.status !== 'succeeded') throw new Error(`eval run ${run.status}: ${run.error ?? ''}`);
    const score = s.evals.score(run)!;
    const results = await s.evals.taskResults(run.id);
    const suggestions = await s.dbs.main.db.selectFrom('suggestions').selectAll().where('run_id', '=', run.id).execute();
    const prompts = Object.fromEntries((await s.evals.suiteTasks(suiteId)).map((t) => [t.key, { category: t.category, prompt: t.prompt }]));
    const report = buildReport({
      server: { slug, name: slug },
      run: { id: run.id, models: JSON.parse(run.models) as string[], modes, repeats: run.repeats, environment: o.env, buildHash: null, provider: process.env.NEUROUTER_EVAL_LLM === 'stub' || results[0]?.servedByModel === 'stub' ? 'stub' : [...new Set((JSON.parse(run.models) as string[]).map((m) => providerForModel(m) ?? 'unknown'))].join(','), startedAt: new Date(run.started_at ?? run.created_at).toISOString(), endedAt: new Date(run.ended_at ?? Date.now()).toISOString() },
      score,
      suggestions: suggestions.map((x) => ({ cause: x.cause as never, kind: x.kind, tools: JSON.parse(x.tools) as string[], affectedTaskKeys: JSON.parse(x.affected_task_ids) as string[], overlayPatch: (JSON.parse(x.overlay_patch) as { yaml: string }).yaml, overlayOps: [], specPatch: x.spec_patch, rationale: x.rationale, predictedDelta: x.predicted_delta })),
      results,
      prompts,
    });
    console.log(renderTable(report));
    if (o.suggest) for (const x of report.suggestions) console.log(`\nSuggestion (${x.kind}, +${x.predictedDelta} predicted): ${x.rationale}\n${x.overlayPatch}`);
    if (o.out) writeFileSync(o.out, JSON.stringify(report, null, 2));
    if (o.md) writeFileSync(o.md, renderMarkdown(report));
    if (o.minScore !== undefined && score.headline < Number(o.minScore)) {
      console.error(`headline ${score.headline} is below --min-score ${o.minScore}`);
      process.exitCode = 1;
    }
  } finally {
    await running?.close();
  }
}
