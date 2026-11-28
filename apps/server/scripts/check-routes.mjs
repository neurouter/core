#!/usr/bin/env node
/**
 * Route registration check against a running server: sends one unauthenticated request per endpoint
 * of the shared `api` contract registry (ALL_ENDPOINTS) and fails on Fastify's "No route for …" 404.
 * 401/403/400/429/… all mean the route exists. Guards against routes that vanish from a build (the
 * evals routes were missing from the production bundle from 0.2.0 to 0.3.5).
 *
 *   node apps/server/scripts/check-routes.mjs http://127.0.0.1:3000      from the repo root, after `npm run build`
 *   docker exec -i -w /app <ctr> node --input-type=module - < apps/server/scripts/check-routes.mjs   (CHECK_ROUTES_BASE, default http://127.0.0.1:3000)
 *
 * The registry is read from `<cwd>/packages/shared/dist/index.js` (the repo root, or /app in the image).
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @returns {Promise<{ checked: number; missing: string[] }>} */
export async function checkRoutes(base, root = process.cwd()) {
  const { ALL_ENDPOINTS, buildPath, pathParamNames } = await import(pathToFileURL(resolve(root, 'packages/shared/dist/index.js')).href);
  const missing = [];
  for (const { key, def } of ALL_ENDPOINTS) {
    const params = Object.fromEntries(pathParamNames(def.path).map((p) => [p, 'x']));
    const hasBody = def.method !== 'GET' && def.method !== 'DELETE';
    const res = await fetch(base + buildPath(def.path, params), {
      method: def.method,
      redirect: 'manual',
      headers: { accept: 'application/json', ...(hasBody ? { 'content-type': 'application/json' } : {}) },
      ...(hasBody ? { body: '{}' } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const text = res.status === 404 ? await res.text() : (await res.body?.cancel(), '');
    if (res.status === 404 && text.includes('No route for')) missing.push(`${key} ${def.method} ${def.path}`);
  }
  return { checked: ALL_ENDPOINTS.length, missing };
}

const isMain = process.argv[1] === undefined || process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const base = (process.argv[2] ?? process.env.CHECK_ROUTES_BASE ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  const { checked, missing } = await checkRoutes(base);
  if (missing.length) {
    console.log(`FAIL ${missing.length}/${checked} contract endpoints answer 404 "No route":\n  ${missing.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`PASS all ${checked} contract endpoints are registered`);
}
