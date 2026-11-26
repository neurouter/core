#!/usr/bin/env node
/**
 * Production bundle of the server (cold start): run after `tsc -b`. Bundles the built `dist/` output
 * of the server, its workspace packages and its pure-JS dependencies into `apps/server/dist-bundle/`,
 * so a cold container reads a few large files instead of ~2,000 small ones (Cloud Run streams each
 * file of the image on first read).
 *
 * Entries (paths matter: code looks for these files next to itself):
 *   main.js          the server process (CMD)
 *   server.js        `startServer` without starting it (compile-cache warm-up at image build)
 *   embed-worker.js  the embedding worker thread (`new URL('./embed-worker.js', import.meta.url)`)
 *   executor/main.js the embedded code-mode executor child (`resolveExecutorEntry`)
 * Shared code and lazily imported modules become chunks next to main.js.
 *
 * External (resolved from node_modules at runtime): native addons, packages that locate their own
 * files at runtime (worker scripts, binaries, loader hooks), and the eval-only SDKs (loaded on first use).
 * `dist/` stays: the CLI, `npx neurouter serve`, `instrumentation.js` and the migrate script use it.
 */
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const serverDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outdir = join(serverDir, 'dist-bundle');
const executorDist = resolve(serverDir, '../executor/dist');

export const EXTERNAL = [
  // native addons / platform binaries
  'better-sqlite3',
  'sqlite-vec',
  'sqlite-vec-*',
  'onnxruntime-node',
  'onnxruntime-common',
  '@huggingface/transformers',
  '@pydantic/monty',
  '@pydantic/monty-*',
  'pg-native',
  // OpenTelemetry SDK + instrumentations stay real modules (loaded only when OTEL_SDK_DISABLED=false;
  // see otelPlugin for @opentelemetry/api); pg is instrumented by patching the module on load
  '@fastify/otel',
  'pg',
  // pino resolves its transport worker files at runtime
  'pino',
  'pino-pretty',
  'thread-stream',
  // eval-only, imported on first use (see packages/evals/src/llm/*.ts)
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
  '@modelcontextprotocol/client',
];

/**
 * `@opentelemetry/*` is external, except the API packages: they keep their state in a versioned
 * `globalThis` registry (built for several copies in one process), so the bundled API still sees the
 * SDK that `instrumentation.js` registers. They are ~110 small files the server loads at boot.
 */
const otelPlugin = {
  name: 'otel-external',
  setup(b) {
    b.onResolve({ filter: /^@opentelemetry\// }, (args) => (/^@opentelemetry\/(api|api-logs)$/.test(args.path) ? undefined : { path: args.path, external: true }));
  },
};

rmSync(outdir, { recursive: true, force: true });
const result = await build({
  entryPoints: {
    main: join(serverDir, 'dist/main.js'),
    server: join(serverDir, 'dist/server.js'),
    'embed-worker': join(serverDir, 'dist/dataplane/search/embed-worker.js'),
    'executor/main': join(executorDist, 'main.js'),
  },
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  chunkNames: '[name]-[hash]',
  external: EXTERNAL,
  plugins: [otelPlugin],
  // bundled CommonJS calls require() for Node built-ins and the externals
  banner: { js: "import { createRequire as __nrCreateRequire } from 'node:module'; const require = __nrCreateRequire(import.meta.url);" },
  legalComments: 'linked',
  metafile: true,
  logLevel: 'warning',
});
// `--meta`: write esbuild's metafile (inputs/outputs, for analysis) next to the bundle
if (process.argv.includes('--meta')) writeFileSync(join(outdir, 'meta.json'), JSON.stringify(result.metafile));
const outputs = Object.entries(result.metafile.outputs).filter(([f]) => f.endsWith('.js'));
const bytes = outputs.reduce((n, [, o]) => n + o.bytes, 0);
console.log(`bundle: ${Object.keys(result.metafile.inputs).length} input files → ${outputs.length} files, ${(bytes / 1024 / 1024).toFixed(1)} MB in ${relative(process.cwd(), outdir) || '.'}`);
