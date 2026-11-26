import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { findServerPackageDir, SERVER_PACKAGE_DIR } from './load.js';

describe('findServerPackageDir', () => {
  const root = mkdtempSync(join(tmpdir(), 'nr-pkgdir-'));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('is apps/server when running from source', () => {
    expect(SERVER_PACKAGE_DIR).toBe(resolve(import.meta.dirname, '../../..'));
  });

  it('walks up from any depth (src/, dist/, the bundle dist-bundle/) to the @neurouter/server package', () => {
    // repo root package.json (another name) above the server package: must not stop there
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'neurouter-monorepo' }));
    const server = join(root, 'apps', 'server');
    mkdirSync(join(server, 'dist-bundle', 'executor'), { recursive: true });
    mkdirSync(join(server, 'dist', 'kernel', 'config'), { recursive: true });
    writeFileSync(join(server, 'package.json'), JSON.stringify({ name: '@neurouter/server' }));
    expect(findServerPackageDir(join(server, 'dist-bundle'), '')).toBe(server);
    expect(findServerPackageDir(join(server, 'dist-bundle', 'executor'), '')).toBe(server);
    expect(findServerPackageDir(join(server, 'dist', 'kernel', 'config'), '')).toBe(server);
  });

  it('NEUROUTER_SERVER_DIR overrides; no package above is an error', () => {
    expect(findServerPackageDir('/anywhere', '/opt/neurouter')).toBe('/opt/neurouter');
    expect(() => findServerPackageDir(tmpdir(), '')).toThrow(/NEUROUTER_SERVER_DIR/);
  });
});
