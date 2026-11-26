#!/usr/bin/env node
// npm `prepack` for the published workspaces (run with the package dir as cwd): copies the repo's
// LICENSE and NOTICE (and README for the CLI) into the package, and with `--web` the console build
// (apps/web/dist) into `web-dist/`, which @neurouter/server serves by default. Fails when a
// required file is missing so a broken tarball is never published.
import { cpSync, existsSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = process.cwd();
const args = new Set(process.argv.slice(2));

for (const f of ['LICENSE', 'NOTICE', ...(args.has('--readme') ? ['README.md'] : [])]) cpSync(join(root, f), join(pkg, f));
if (!existsSync(join(pkg, 'dist'))) throw new Error(`${pkg}/dist is missing: run \`npm run build\` first`);
if (args.has('--web')) {
  const web = join(root, 'apps/web/dist');
  if (!existsSync(join(web, 'index.html'))) throw new Error('apps/web/dist/index.html is missing: run `npm run build` (builds the console) first');
  rmSync(join(pkg, 'web-dist'), { recursive: true, force: true });
  cpSync(web, join(pkg, 'web-dist'), { recursive: true });
}
