import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compile, GRAPHQL_ACCEPT, GRAPHQL_INTROSPECTION_QUERY, pyNamespace, readIntrospectionResponse } from '@neurouter/compiler';
import { neurouterYamlJsonSchema, type LintReport, type ToolDef } from '@neurouter/shared';
import { parseConfigYaml } from '@neurouter/server';
import { readSpec } from './common.js';

export async function cmdCompile(o: { spec?: string; overlay?: string; out?: string; stubs?: string; namespace?: string; graphqlEndpoint?: string }): Promise<void> {
  let bytes: Uint8Array;
  if (o.graphqlEndpoint) {
    const res = await fetch(o.graphqlEndpoint, { method: 'POST', headers: { 'content-type': 'application/json', accept: GRAPHQL_ACCEPT }, body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }) });
    const out = readIntrospectionResponse(await res.text());
    if (!out.ok) throw new Error(res.ok ? out.message : `${o.graphqlEndpoint} answered ${res.status}: ${out.message}`);
    bytes = new TextEncoder().encode(out.json);
  } else if (o.spec) bytes = await readSpec(o.spec);
  else throw new Error('--spec or --graphql-endpoint is required');
  const overlay = o.overlay ? readFileSync(o.overlay, 'utf8') : undefined;
  const ns = o.namespace ?? pyNamespace((o.spec ?? 'api').split('/').pop()!.replace(/\.(ya?ml|json|graphql|gql)$/i, '').replace(/^openapi$/, 'api')) ?? 'api';
  const r = await compile({ spec: { bytes }, ...(overlay ? { overlay } : {}), namespace: ns });
  const visible = r.tools.filter((t) => !t.hidden);
  for (const d of r.diagnostics) console.error(`${d.severity}: ${d.code}: ${d.message}${d.pointer ? ` (${d.pointer})` : ''}${d.line ? ` line ${d.line}` : ''}`);
  // an invalid overlay is not skipped: the result would silently differ from what the overlay asks for
  const overlayErrors = r.diagnostics.filter((d) => d.severity === 'error' && d.code.startsWith('overlay_'));
  if (overlayErrors.length) {
    console.error(`${o.overlay}: ${overlayErrors.length} overlay error(s); nothing was written`);
    process.exitCode = 1;
    return;
  }
  console.log(`${r.title || 'API'} (${r.format}): ${r.tools.length} tools (${visible.length} visible, ${visible.filter((t) => t.risk.write).length} write), lint score ${r.lint.score}`);
  for (const t of visible) console.log(`  ${t.risk.write ? 'W' : 'R'} ${t.name}`);
  printLint('', r.lint, r.tools);
  if (o.out) writeFileSync(o.out, JSON.stringify({ format: r.format, title: r.title, tools: r.tools, lint: r.lint, diagnostics: r.diagnostics }, null, 2));
  if (o.stubs) {
    mkdirSync(o.stubs, { recursive: true });
    for (const [name, pyi] of Object.entries(r.pythonStubs)) {
      writeFileSync(join(o.stubs, `${name}.pyi`), pyi);
      console.log(`wrote ${join(o.stubs, `${name}.pyi`)}`);
    }
  }
  if (!r.ok) process.exitCode = 1;
}

/**
 * Lint lines for the terminal: each rule that does not pass (score, detail) and its warnings (max `perRule`).
 * Returns the number of errors: a curated (overlay or spec) example that does not run fails validation
 * (contract-v2 §10: examples in descriptions are executed); a synthesized one only warns.
 */
export function printLint(prefix: string, report: LintReport, tools: ToolDef[], perRule = 5): number {
  let errors = 0;
  for (const r of report.rules) {
    if (r.passed || r.weight === 0) continue;
    console.log(`  ${prefix}lint ${r.rule} ${Math.round(r.score * 100)}%: ${r.detail}`);
    const fs = report.findings.filter((f) => f.rule === r.rule && f.severity !== 'info');
    for (const f of fs.slice(0, perRule)) {
      const curated = r.rule === 'example_runs' && f.message.startsWith('curated example');
      if (curated) errors++;
      (curated ? console.error : console.log)(`    ${curated ? 'error' : f.severity}: ${f.tool ? `${f.tool}: ` : ''}${f.message}`);
    }
    if (fs.length > perRule) console.log(`    … ${fs.length - perRule} more`);
  }
  // curated examples beyond the printed ones still count
  void tools;
  const failing = report.findings.filter((f) => f.rule === 'example_runs' && f.message.startsWith('curated example'));
  return Math.max(errors, failing.length);
}

/** `npx neurouter validate`: parse + compile + lint every server of the file; exit 1 on errors (§6.2). */
export async function cmdValidate(o: { config: string; printSchema?: boolean }): Promise<void> {
  if (o.printSchema) {
    console.log(JSON.stringify(neurouterYamlJsonSchema(), null, 2));
    return;
  }
  const text = readFileSync(o.config, 'utf8');
  const parsed = parseConfigYaml(text, o.config);
  let errors = 0;
  for (const d of parsed.diagnostics) {
    console.error(`${o.config}:${d.line ?? 1}:${d.col ?? 1}: ${d.severity}: ${d.message}`);
    if (d.severity === 'error') errors++;
  }
  if (parsed.config) {
    const { dirname, isAbsolute, resolve } = await import('node:path');
    const base = dirname(o.config);
    for (const [i, s] of parsed.config.servers.entries()) {
      const line = parsed.lines.get(`servers.${i}`) ?? 1;
      try {
        const src = s.spec as { url?: string; path?: string };
        const bytes = await readSpec(src.url ?? (isAbsolute(src.path!) ? src.path! : resolve(base, src.path!)));
        const overlay = s.overlay ? readFileSync(isAbsolute(s.overlay) ? s.overlay : resolve(base, s.overlay), 'utf8') : undefined;
        const r = await compile({ spec: { bytes }, ...(overlay ? { overlay } : {}), namespace: pyNamespace(s.slug) });
        for (const d of r.diagnostics.filter((x) => x.severity !== 'info')) {
          console.error(`${o.config}:${line}:1: ${d.severity}: ${s.slug}: ${d.code}: ${d.message}`);
          if (d.severity === 'error') errors++;
        }
        console.log(`${s.slug}: ${r.tools.filter((t) => !t.hidden).length} visible tools, lint score ${r.lint.score}, ${s.environments?.length ?? 0} environment(s) + mock`);
        const failed = printLint(`${s.slug}: `, r.lint, r.tools);
        if (failed) console.error(`${o.config}:${line}:1: error: ${s.slug}: ${failed} curated example(s) do not run against the mock (fix them in the overlay)`);
        errors += failed;
      } catch (err) {
        console.error(`${o.config}:${line}:1: error: ${s.slug}: ${(err as Error).message}`);
        errors++;
      }
    }
  }
  if (errors) {
    console.error(`${errors} error(s)`);
    process.exitCode = 1;
  } else console.log('ok');
}
