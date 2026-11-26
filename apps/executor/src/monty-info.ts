import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type * as MontyNode from '@pydantic/monty/node';

let version: string | null = null;

/** Version of the installed `@pydantic/monty` package. */
export function montyVersion(): string {
  if (version) return version;
  try {
    const url = new URL('../package.json', import.meta.resolve('@pydantic/monty'));
    version = (JSON.parse(readFileSync(url, 'utf8')) as { version: string }).version;
  } catch {
    version = 'unknown';
  }
  return version;
}

/**
 * Resolves the `monty` worker binary (explicit path, `MONTY_BINARY_PATH`, or the platform package).
 * `@pydantic/monty` is only loaded for the platform lookup (the server process spawns the executor
 * with a pinned path and never needs the package itself).
 */
export function resolveMontyBinary(explicit?: string): string {
  const path = explicit || process.env.MONTY_BINARY_PATH;
  if (path) {
    if (!existsSync(path)) throw new Error(`monty binary not found at binaryPath: ${path}`);
    return path;
  }
  const { findMontyBinary } = createRequire(import.meta.url)('@pydantic/monty/node') as typeof MontyNode;
  return findMontyBinary();
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Checks the binary against `expectedSha256` (plan L2: binary pinned by path + checksum).
 * Returns the actual checksum; throws on a mismatch.
 */
export function verifyMontyBinary(path: string, expectedSha256?: string): string {
  const actual = sha256File(path);
  if (expectedSha256 && actual.toLowerCase() !== expectedSha256.trim().toLowerCase()) {
    throw new Error(`monty binary checksum mismatch for ${path}: expected ${expectedSha256}, got ${actual}`);
  }
  return actual;
}
