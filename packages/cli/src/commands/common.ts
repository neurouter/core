import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { generateKeyEnv } from '@neurouter/server';
import { isAbsolute, resolve } from 'node:path';

/** Reads a spec from a file path or an http(s) URL. */
export async function readSpec(fileOrUrl: string): Promise<Uint8Array> {
  if (/^https?:\/\//i.test(fileOrUrl)) {
    const res = await fetch(fileOrUrl);
    if (!res.ok) throw new Error(`could not fetch ${fileOrUrl}: ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }
  return readFileSync(fileOrUrl);
}

/** Environment for an in-process server rooted at `dataDir` (SQLite `<data>/neurouter.db`). */
export function serverEnv(opts: { data?: string; port?: string | number; host?: string; config?: string; embeddings?: boolean; inMemory?: boolean }): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  if (!env.DATABASE_URL) {
    if (opts.inMemory) env.DATABASE_URL = 'sqlite::memory:';
    else {
      const dir = resolve(opts.data ?? './.neurouter');
      mkdirSync(dir, { recursive: true });
      env.DATABASE_URL = `sqlite:${resolve(dir, 'neurouter.db')}`;
      // dev convenience: stable crypto per data dir, so keys minted by `keys create` verify in `serve`
      if (!env.NEUROUTER_MASTER_KEYS && !env.HASH_PEPPER && env.NODE_ENV !== 'production') {
        const file = resolve(dir, 'keys.env');
        if (!existsSync(file)) writeFileSync(file, `${generateKeyEnv('dev')}\n`, { mode: 0o600 });
        for (const line of readFileSync(file, 'utf8').split('\n')) {
          const i = line.indexOf('=');
          if (i > 0) env[line.slice(0, i)] ??= line.slice(i + 1);
        }
      }
    }
  }
  if (opts.port !== undefined) env.PORT = String(opts.port);
  if (opts.host) env.HOST = opts.host;
  if (!env.PUBLIC_URL && opts.port !== undefined && Number(opts.port) > 0) env.PUBLIC_URL = `http://${opts.host && opts.host !== '0.0.0.0' ? (opts.host === '127.0.0.1' ? 'localhost' : opts.host) : 'localhost'}:${opts.port}`;
  if (opts.config) env.NEUROUTER_CONFIG = isAbsolute(opts.config) ? opts.config : resolve(opts.config);
  if (!opts.embeddings && env.EMBEDDINGS_ENABLED === undefined) env.EMBEDDINGS_ENABLED = 'false';
  env.NODE_ENV ??= 'development';
  env.LOG_LEVEL ??= 'warn';
  return env;
}
