import { describe, expect, it } from 'vitest';
import { providerKey } from './model-keys.js';

/** Settings + named secrets stand-ins for one tenant. */
function deps(o: { stored?: string; env?: string; allowEnvKeys: boolean }) {
  const settings = { get: async (k: string) => (k === 'openaiKeySecretId' && o.stored ? 'settings:openai' : null) } as never;
  const namedSecrets = { get: async () => o.stored ?? null } as never;
  return { env: { OPENAI_API_KEY: o.env }, settings, namedSecrets, tenantId: 't1', allowEnvKeys: o.allowEnvKeys };
}

describe('model keys (multi-tenancy spec §8.8, G12)', () => {
  it("the tenant's stored key wins over the server's env key", async () => {
    expect(await providerKey(deps({ stored: 'sk-tenant', env: 'sk-server', allowEnvKeys: true }), 'openai')).toEqual({ key: 'sk-tenant', source: 'stored' });
  });
  it('the env key is a fallback only when the ModelKeyPolicy allows it', async () => {
    expect(await providerKey(deps({ env: 'sk-server', allowEnvKeys: true }), 'openai')).toEqual({ key: 'sk-server', source: 'env' });
    expect(await providerKey(deps({ env: 'sk-server', allowEnvKeys: false }), 'openai')).toBeNull();
    expect(await providerKey(deps({ stored: 'sk-tenant', env: 'sk-server', allowEnvKeys: false }), 'openai')).toEqual({ key: 'sk-tenant', source: 'stored' });
  });
});
