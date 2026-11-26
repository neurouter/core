#!/usr/bin/env node
// `npm run dev`: server (tsx watch, embedded executor) + the console's Vite dev server when apps/web has one.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const env = { ...process.env };
// relative paths in .env / defaults resolve against the repo root (the server runs from apps/server)
if (!env.NEUROUTER_CONFIG && existsSync(resolve(root, 'neurouter.example.yaml'))) env.NEUROUTER_CONFIG = resolve(root, 'neurouter.example.yaml');
else if (env.NEUROUTER_CONFIG && !env.NEUROUTER_CONFIG.startsWith('/')) env.NEUROUTER_CONFIG = resolve(root, env.NEUROUTER_CONFIG);
env.NEUROUTER_ENV_FILE ??= existsSync(resolve(root, '.env')) ? resolve(root, '.env') : '';
if (!env.NEUROUTER_ENV_FILE) delete env.NEUROUTER_ENV_FILE;

const procs = [];
const run = (name, args) => {
  const p = spawn('npm', args, { cwd: root, env, stdio: 'inherit' });
  p.on('exit', (code) => {
    console.log(`[dev] ${name} exited (${code})`);
    for (const q of procs) if (q !== p) q.kill('SIGTERM');
    process.exit(code ?? 0);
  });
  procs.push(p);
};
run('server', ['run', 'dev', '-w', '@neurouter/server']);
const webPkg = resolve(root, 'apps/web/package.json');
if (existsSync(webPkg) && JSON.parse(readFileSync(webPkg, 'utf8')).scripts?.dev) run('web', ['run', 'dev', '-w', '@neurouter/web']);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => procs.forEach((p) => p.kill(sig)));
