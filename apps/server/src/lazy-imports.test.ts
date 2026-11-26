import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * Cold start: the eval-only LLM SDKs and the MCP client are imported on first use, never by the
 * server's module graph at boot (each is hundreds of files; on Cloud Run every file is a cold read).
 */
const LAZY = ['/node_modules/@anthropic-ai/sdk/', '/node_modules/openai/', '/node_modules/@google/genai/', '/node_modules/@modelcontextprotocol/client/'];

describe('server module graph at boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nr-lazy-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('does not load the eval LLM SDKs or the MCP client', () => {
    const log = join(dir, 'loaded.txt');
    const hook = join(dir, 'hook.mjs');
    // synchronous hooks see both import and require
    writeFileSync(hook, `import { registerHooks } from 'node:module';\nimport { appendFileSync } from 'node:fs';\nregisterHooks({ load(url, ctx, next) { appendFileSync(${JSON.stringify(log)}, url + '\\n'); return next(url, ctx); } });\n`);
    writeFileSync(log, '');
    const server = pathToFileURL(resolve(import.meta.dirname, 'server.ts')).href;
    execFileSync(process.execPath, ['--conditions=@neurouter/source', '--import', 'tsx', '--import', pathToFileURL(hook).href, '--input-type=module', '-e', `await import(${JSON.stringify(server)})`], { cwd: import.meta.dirname, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'test' } });
    const urls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
    // control: the hook saw the server's real dependencies
    expect(urls.some((u) => u.includes('/node_modules/kysely/'))).toBe(true);
    expect(urls.some((u) => u.includes('/node_modules/fastify/'))).toBe(true);
    expect(urls.filter((u) => LAZY.some((p) => u.includes(p)))).toEqual([]);
  }, 60_000);
});
