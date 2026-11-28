import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startServer } from '@neurouter/server';
import { buildProgram } from './main.js';

const ROOT = resolve(import.meta.dirname, '../../..');
const ENV_KEYS = ['NODE_ENV', 'DATABASE_URL', 'NEUROUTER_MASTER_KEYS', 'NEUROUTER_ACTIVE_KEY_ID', 'HASH_PEPPER', 'NEUROUTER_CONFIG', 'EMBEDDINGS_ENABLED', 'NEUROUTER_EXECUTOR_MODE', 'BOOTSTRAP_ADMIN_EMAIL', 'PUBLIC_URL', 'LOG_LEVEL'] as const;

async function keysCreate(args: string[]): Promise<string> {
  const out: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void out.push(a.join(' ')));
  const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await buildProgram().exitOverride().parseAsync(['node', 'neurouter', 'keys', 'create', '--server', 'petstore', '--env', 'dev', ...args]);
  } finally {
    log.mockRestore();
    err.mockRestore();
  }
  return out.filter((l) => !l.startsWith('{')).pop() ?? '';
}

const usersOf = (file: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare('select id, email from users order by email').all() as Array<{ id: string; email: string }>;
  } finally {
    db.close();
  }
};
const keyOwner = (file: string, name: string) => {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare('select u.email as email from api_keys k join users u on u.id = k.owner_user_id where k.name = ?').get(name) as { email: string } | undefined;
    return row?.email;
  } finally {
    db.close();
  }
};

describe('neurouter keys create (owner of the key)', () => {
  const saved: Partial<Record<string, string | undefined>> = {};
  const dir = mkdtempSync(join(tmpdir(), 'nr-keys-'));
  const file = join(dir, 'neurouter.db');
  const base = {
    NODE_ENV: 'test',
    DATABASE_URL: `sqlite:${file}`,
    NEUROUTER_MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`,
    NEUROUTER_ACTIVE_KEY_ID: 'k1',
    HASH_PEPPER: randomBytes(32).toString('hex'),
    NEUROUTER_CONFIG: join(ROOT, 'neurouter.example.yaml'),
    EMBEDDINGS_ENABLED: 'false',
    NEUROUTER_EXECUTOR_MODE: 'off',
    PUBLIC_URL: 'https://neurouter.keys.invalid',
    LOG_LEVEL: 'error',
  };

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    // a deployment: its first owner came from BOOTSTRAP_ADMIN_EMAIL and signed in with OIDC; an OIDC admin joined later
    const s = await startServer({ env: { ...base, BOOTSTRAP_ADMIN_EMAIL: 'owner@corp.test' }, listen: false, jobs: false, loadDotenv: false, services: { executor: null, defaultMetrics: false } });
    await s.services.users.upsertOidc({ email: 'owner@corp.test', name: 'Owner', issuer: 'https://idp.corp.test', subject: 'owner', role: 'admin' });
    await s.services.users.upsertOidc({ email: 'ops@corp.test', name: 'Ops', issuer: 'https://idp.corp.test', subject: 'ops', role: 'admin' });
    await s.close();
    // the operator's shell: the deployment's database, no BOOTSTRAP_ADMIN_EMAIL
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, base);
  }, 60_000);
  afterAll(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates no user: the key belongs to the oldest active owner of the organization', async () => {
    const before = usersOf(file);
    expect(before.map((u) => u.email)).toEqual(['ops@corp.test', 'owner@corp.test']);
    expect(await keysCreate(['--name', 'k-default'])).toMatch(/^\S{20,}$/);
    expect(usersOf(file)).toEqual(before);
    expect(keyOwner(file, 'k-default')).toBe('owner@corp.test');
  }, 60_000);

  it('--owner picks another owner or admin of the organization', async () => {
    await keysCreate(['--name', 'k-ops', '--owner', 'OPS@corp.test']);
    expect(keyOwner(file, 'k-ops')).toBe('ops@corp.test');
  }, 60_000);

  it('--owner with someone who is not an owner or admin there fails clearly', async () => {
    await expect(keysCreate(['--name', 'k-x', '--owner', 'nobody@corp.test'])).rejects.toThrow(/nobody@corp\.test is not an active owner or admin of organization/);
    expect(usersOf(file).map((u) => u.email)).toEqual(['ops@corp.test', 'owner@corp.test']);
  }, 60_000);

  it('a fresh local data directory still works: the local admin is created and owns the key', async () => {
    const local = mkdtempSync(join(tmpdir(), 'nr-keys-local-'));
    for (const k of ENV_KEYS) delete process.env[k];
    Object.assign(process.env, { NODE_ENV: 'test', NEUROUTER_CONFIG: base.NEUROUTER_CONFIG, EMBEDDINGS_ENABLED: 'false', NEUROUTER_EXECUTOR_MODE: 'off', LOG_LEVEL: 'error' });
    try {
      await keysCreate(['--name', 'k-local', '--data', local]);
      expect(keyOwner(join(local, 'neurouter.db'), 'k-local')).toBe('admin@localhost');
    } finally {
      for (const k of ENV_KEYS) delete process.env[k];
      Object.assign(process.env, base);
      rmSync(local, { recursive: true, force: true });
    }
  }, 60_000);
});
