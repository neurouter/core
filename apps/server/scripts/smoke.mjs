#!/usr/bin/env node
/**
 * Boot smoke for the built server: starts it as production would (SQLite in a temp dir, embedded
 * executor), then checks /readyz, MCP tools/list, a mock tool call, run_script and search_tools.
 *
 *   node apps/server/scripts/smoke.mjs                  the production bundle (dist-bundle/main.js)
 *   node apps/server/scripts/smoke.mjs --entry dist     the unbundled build (dist/main.js, `npm start`)
 *   EMBEDDINGS_ENABLED=true MODELS_DIR=<dir> node …     also waits for the embedder (needs the model)
 *
 * Exits 1 on any failed check. Run from anywhere after `npm run build`.
 */
import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '../../..');
const entry = process.argv.includes('--entry') ? process.argv[process.argv.indexOf('--entry') + 1] : 'bundle';
const main = entry === 'dist' ? 'apps/server/dist/main.js' : 'apps/server/dist-bundle/main.js';
const embeddings = process.env.EMBEDDINGS_ENABLED === 'true';

const port = await new Promise((res) => {
  const s = createServer().listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => res(p));
  });
});
const dir = mkdtempSync(join(tmpdir(), 'nr-smoke-'));
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  PORT: String(port),
  PUBLIC_URL: 'https://neurouter.smoke.invalid',
  NEUROUTER_LOCAL_LINK: 'true',
  DATABASE_URL: `sqlite:${join(dir, 'neurouter.db')}`,
  NEUROUTER_MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`,
  NEUROUTER_ACTIVE_KEY_ID: 'k1',
  HASH_PEPPER: randomBytes(32).toString('hex'),
  NEUROUTER_CONFIG: join(root, 'neurouter.example.yaml'),
  NEUROUTER_EXECUTOR_MODE: 'embedded',
  EMBEDDINGS_ENABLED: String(embeddings),
  ...(process.env.MODELS_DIR ? { MODELS_DIR: process.env.MODELS_DIR } : {}),
  SERVE_WEB: 'false',
  OTEL_SDK_DISABLED: 'true',
  LOG_LEVEL: 'info',
  // from the caller: OTEL_* (e.g. OTEL_SDK_DISABLED=false + an OTLP endpoint), the image's pinned
  // Monty binary (MONTY_BINARY_PATH/_SHA256) and NODE_COMPILE_CACHE
  ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('OTEL_') || k.startsWith('MONTY_BINARY_') || k === 'NODE_COMPILE_CACHE')),
};

const fails = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) fails.push(name);
};

if (entry !== 'dist') {
  // code looks for these next to itself: the executor child, the embedding worker, the warm-up entry
  for (const f of ['main.js', 'server.js', 'embed-worker.js', 'executor/main.js']) check(`bundle has ${f}`, existsSync(join(root, 'apps/server/dist-bundle', f)));
}

const t0 = Date.now();
const server = spawn(process.execPath, ['--import', './apps/server/dist/instrumentation.js', main], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
server.stdout.on('data', (d) => (log += d));
server.stderr.on('data', (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  let ready = null;
  for (let i = 0; i < 120 && server.exitCode === null; i++) {
    ready = await fetch(`${base}/readyz`).then((r) => r.json(), () => null);
    if (ready) break;
    await sleep(250);
  }
  check(`server listening (${main})`, !!ready, `${Date.now() - t0} ms`);
  if (!ready) throw new Error('server did not start');
  // listen happens only after the executor is up: the very first probe must report it
  check('first /readyz: executor ok', ready.checks?.executor?.ok === true, JSON.stringify(ready.checks?.executor));
  check('first /readyz: database ok', ready.checks?.database?.ok === true);
  if (embeddings) {
    for (let i = 0; i < 120 && ready.checks?.embedder?.detail !== 'ready' && ready.checks?.embedder?.detail !== 'error'; i++) {
      await sleep(500);
      ready = await (await fetch(`${base}/readyz`)).json();
    }
    check('embedder ready', ready.checks?.embedder?.detail === 'ready', JSON.stringify(ready.checks?.embedder));
  }

  const token = execFileSync(process.execPath, ['packages/cli/dist/main.js', 'keys', 'create', '--server', 'petstore', '--env', 'dev', '--scopes', 'tools:read,tools:write,code:run', '--name', 'smoke'], { cwd: root, env: { ...env, LOG_LEVEL: 'warn' }, encoding: 'utf8' }).trim().split('\n').filter((l) => !l.startsWith('{')).pop();
  check('API key created (CLI)', /^\S{20,}$/.test(token ?? ''), (token ?? '').slice(0, 12) + '…');
  let id = 0;
  const rpc = async (method, params, headers = {}) => {
    const res = await fetch(`${base}/mcp/petstore/dev`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-11-25', ...headers },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const body = await res.text();
    const json = body.startsWith('{') ? JSON.parse(body) : JSON.parse(body.split('\n').find((l) => l.startsWith('data: '))?.slice(6) ?? 'null');
    return json?.result ?? { error: json?.error ?? body.slice(0, 300) };
  };
  const text = (r) => (r.content ?? []).map((c) => c.text ?? '').join('\n');

  const listed = await rpc('tools/list', {});
  const names = (listed.tools ?? []).map((t) => t.name);
  check('tools/list', names.includes('get_pet_by_id') && names.includes('run_script'), `${names.length} tools`);
  const call = await rpc('tools/call', { name: 'get_pet_by_id', arguments: { pet_id: 1 } });
  check('mock tool call get_pet_by_id', !call.isError && !call.error, text(call).slice(0, 100).replace(/\s+/g, ' '));
  const script = await rpc('tools/call', { name: 'run_script', arguments: { code: 'pet = petstore.get_pet_by_id(pet_id=1)\nreturn {"answer": 6 * 7, "has_pet": pet is not None}' } });
  check('run_script', !script.isError && script.structuredContent?.status === 'ok' && script.structuredContent?.result?.answer === 42, JSON.stringify(script.structuredContent ?? script).slice(0, 200));
  const found = await rpc('tools/call', { name: 'search_tools', arguments: { query: 'find a pet by its id', format: 'json' } }, { 'x-neurouter-exposure': 'code' });
  const hits = (found.structuredContent?.tools ?? []).map((t) => t.name);
  check('search_tools', hits.includes('get_pet_by_id'), hits.slice(0, 5).join(', '));
} catch (err) {
  check('smoke', false, String(err?.message ?? err));
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => (server.exitCode !== null ? r() : server.once('exit', r)));
  rmSync(dir, { recursive: true, force: true });
}
if (fails.length) {
  console.log(`\n--- server log (tail) ---\n${log.split('\n').slice(-40).join('\n')}`);
  console.log(`\n${fails.length} FAILED: ${fails.join('; ')}`);
  process.exit(1);
}
console.log('\nALL PASS');
