import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

/** The migrate step runs with only the database settings, also in production (separate deploy step). */
describe('migrate script', () => {
  const dir = mkdtempSync(join(tmpdir(), 'nr-migrate-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const run = (...args: string[]) =>
    execFileSync(process.execPath, ['--conditions=@neurouter/source', '--import', 'tsx', resolve(import.meta.dirname, 'migrate.ts'), ...args], {
      cwd: import.meta.dirname,
      encoding: 'utf8',
      // no PUBLIC_URL / OIDC / master keys / pepper: the full server config would refuse this in production
      env: { PATH: process.env.PATH, NODE_ENV: 'production', DATABASE_URL: `sqlite:${join(dir, 'm.db')}` },
    });

  it('up applies both sets, then status lists them as applied', () => {
    const applied = JSON.parse(run('up')) as { main: string[]; audit: string[] };
    expect(applied.main.length).toBeGreaterThan(0);
    expect(applied.audit.length).toBeGreaterThan(0);
    expect(JSON.parse(run('up'))).toEqual({ main: [], audit: [] });
    expect(run('status')).not.toMatch(/pending/);
  }, 60_000);
});
