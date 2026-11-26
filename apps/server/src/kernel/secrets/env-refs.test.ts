import { describe, expect, it } from 'vitest';
import { EnvRefGate, isInternalEnvName, matchesAllowList } from './env-refs.js';
import type { TenantRef } from '../tenancy/types.js';

const T: TenantRef = { id: 't1', slug: 'one', name: 'One', status: 'active', plan: 'oss' };
const env = { GITHUB_TOKEN: 'gh', DATABASE_URL: 'postgres://secret', NEUROUTER_MASTER_KEYS: 'k1:xx', HASH_PEPPER: 'pp', OPENAI_API_KEY: 'sk', ACME_TOKEN: 'acme', PGPASSWORD: 'pw' };
const gate = (o: Partial<ConstructorParameters<typeof EnvRefGate>[0]> = {}) => new EnvRefGate({ policy: { allowEnvRefs: () => true }, allow: [], tenant: async (id) => (id === 't1' ? T : null), env, ...o });

describe('env: secret references (multi-tenancy spec §4.9 G12)', () => {
  it('never reads a gateway-internal variable', async () => {
    for (const n of ['DATABASE_URL', 'AUDIT_DATABASE_URL', 'NEUROUTER_MASTER_KEYS', 'NEUROUTER_ACTIVE_KEY_ID', 'NEUROUTER_ANYTHING', 'HASH_PEPPER', 'OIDC_CLIENT_SECRET', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'METRICS_TOKEN', 'PGPASSWORD', 'database_url']) expect(isInternalEnvName(n), n).toBe(true);
    expect(isInternalEnvName('GITHUB_TOKEN')).toBe(false);
    const g = gate();
    expect(await g.read('t1', 'DATABASE_URL')).toBeNull();
    expect(await g.read('t1', 'NEUROUTER_MASTER_KEYS')).toBeNull();
    expect(await g.read('t1', 'PGPASSWORD')).toBeNull();
    expect(await g.denial(T, 'HASH_PEPPER')).toBe('internal_variable');
    expect(await g.read('t1', 'GITHUB_TOKEN')).toBe('gh');
  });

  it('refuses names that are not plain variable names', async () => {
    expect(await gate().denial(T, 'A-B')).toBe('internal_variable');
    expect(await gate().denial(T, '')).toBe('internal_variable');
  });

  it('honours the operator allow-list (exact names and PREFIX*)', async () => {
    expect(matchesAllowList('ACME_TOKEN', ['ACME_*'])).toBe(true);
    expect(matchesAllowList('GITHUB_TOKEN', ['ACME_*', 'X'])).toBe(false);
    const g = gate({ allow: ['ACME_*'] });
    expect(await g.read('t1', 'ACME_TOKEN')).toBe('acme');
    expect(await g.denial(T, 'GITHUB_TOKEN')).toBe('not_allowlisted');
    // the allow-list never re-opens an internal variable
    expect(await gate({ allow: ['DATABASE_*', 'HASH_PEPPER'] }).read('t1', 'DATABASE_URL')).toBeNull();
  });

  it('SecretRefPolicy: env refs off for a tenant (cloud) and a name policy', async () => {
    expect(await gate({ policy: { allowEnvRefs: () => false } }).denial(T, 'GITHUB_TOKEN')).toBe('env_refs_disabled');
    expect(await gate({ policy: { allowEnvRefs: () => true, allowEnvName: (n) => n.startsWith('ACME_') } }).denial(T, 'GITHUB_TOKEN')).toBe('not_allowlisted');
    // unknown tenant: fail closed
    expect(await gate().read('nope', 'GITHUB_TOKEN')).toBeNull();
  });
});
