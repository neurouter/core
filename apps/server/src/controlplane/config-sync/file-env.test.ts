import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { NeurouterYaml } from '@neurouter/shared';
import { createTestContext, REPO_ROOT, type TestContext } from '../../test/fakes/app-context.js';
import { fileEnvDefaults } from './file-env.js';
import { parseConfigYaml } from './reconcile.js';

const cfg = (o: Record<string, unknown>) => NeurouterYaml.parse({ version: 1, ...o });

describe('neurouter.yaml process-level keys (file-env)', () => {
  it('instance.publicUrl fills PUBLIC_URL unless the env sets it', () => {
    const c = cfg({ instance: { publicUrl: 'https://mcp.acme.test/' } });
    expect(fileEnvDefaults(c, {}).env.PUBLIC_URL).toBe('https://mcp.acme.test');
    expect(fileEnvDefaults(c, { PUBLIC_URL: 'https://env.test' }).env).not.toHaveProperty('PUBLIC_URL');
  });

  it('auth.oidc → OIDC_* from an env:NAME client secret; env OIDC_* wins; secret: refs are ignored with a warning', () => {
    const oidc = { issuer: 'https://idp.acme.test', clientId: 'nr', clientSecret: 'env:IDP_SECRET', displayName: 'Acme SSO', scopes: ['openid', 'email'], adminGroups: ['ops', 'sre'], allowedEmailDomains: ['acme.test'], defaultRole: 'viewer' };
    const r = fileEnvDefaults(cfg({ auth: { oidc } }), { IDP_SECRET: 's3cret' });
    expect(r.env).toMatchObject({ OIDC_ISSUER: 'https://idp.acme.test', OIDC_CLIENT_ID: 'nr', OIDC_CLIENT_SECRET: 's3cret', OIDC_DISPLAY_NAME: 'Acme SSO', OIDC_SCOPES: 'openid email', OIDC_ADMIN_GROUPS: 'ops,sre', OIDC_ALLOWED_EMAIL_DOMAINS: 'acme.test', OIDC_DEFAULT_ROLE: 'viewer' });
    expect(fileEnvDefaults(cfg({ auth: { oidc } }), { IDP_SECRET: 's', OIDC_ISSUER: 'https://env-idp.test', OIDC_CLIENT_ID: 'x', OIDC_CLIENT_SECRET: 'y' }).env).toEqual({});
    const missing = fileEnvDefaults(cfg({ auth: { oidc } }), {});
    expect(missing.env).toEqual({});
    expect(missing.warnings.join('\n')).toMatch(/IDP_SECRET is not set/);
    const stored = fileEnvDefaults(cfg({ auth: { oidc: { ...oidc, clientSecret: 'secret:idp' } } }), {});
    expect(stored.env).toEqual({});
    expect(stored.warnings.join('\n')).toMatch(/only env:NAME/);
  });

  it('settings.evals.apiKey becomes the eval model provider key unless that provider env key is set', () => {
    expect(fileEnvDefaults(cfg({ settings: { evals: { apiKey: 'env:MY_KEY' } } }), { MY_KEY: 'sk-1' }).env).toEqual({ OPENAI_API_KEY: 'sk-1' });
    expect(fileEnvDefaults(cfg({ settings: { evals: { model: 'claude-sonnet-5-5', apiKey: 'env:MY_KEY' } } }), { MY_KEY: 'sk-2' }).env).toEqual({ ANTHROPIC_API_KEY: 'sk-2' });
    expect(fileEnvDefaults(cfg({ settings: { evals: { apiKey: 'env:MY_KEY' } } }), { MY_KEY: 'sk-1', OPENAI_API_KEY: 'sk-env' }).env).toEqual({});
  });

  it('auth.externalAs.scopeMap maps external scopes onto mcp:* scopes (mcp:* keep their meaning)', () => {
    const r = fileEnvDefaults(cfg({ auth: { externalAs: { issuer: 'https://auth.acme.test', scopeMap: { 'orders.read': 'mcp:tools', 'orders.write': 'mcp:write' } } } }), {});
    expect(r.externalAs?.scopeMap).toMatchObject({ 'orders.read': 'tools:read', 'orders.write': 'tools:write', 'mcp:code': 'code:run' });
  });

  it('validate warns about accepted-but-ignored keys (settings.tasks, secret: references) with their line', () => {
    const text = `version: 1\nauth:\n  oidc:\n    issuer: https://idp.acme.test\n    clientId: nr\n    clientSecret: secret:idp\nsettings:\n  evals:\n    apiKey: secret:openai\n  tasks:\n    labelInferred: true\n`;
    const p = parseConfigYaml(text, 'neurouter.yaml');
    expect(p.ok).toBe(true);
    const w = p.diagnostics.filter((d) => d.severity === 'warning');
    expect(w.map((d) => [d.code, d.line, d.message.split(':')[0]])).toEqual([
      ['config_ignored', 11, 'settings.tasks'],
      ['config_ignored', 6, 'auth.oidc.clientSecret'],
      ['config_ignored', 9, 'settings.evals.apiKey'],
    ]);
  });
});

describe('boot with neurouter.yaml: publicUrl and settings are applied, file-managed keys are honest', () => {
  let t: TestContext;
  afterAll(async () => t?.close());

  it('applies instance.publicUrl, auth.oidc, evals models, discovery, audit and reports the right fileManaged keys', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-file-env-'));
    const f = join(dir, 'neurouter.yaml');
    writeFileSync(f, `version: 1
instance: { name: Acme, publicUrl: https://mcp.acme.test }
auth:
  oidc: { issuer: https://idp.acme.test, clientId: nr, clientSecret: env:NR_TEST_IDP_SECRET, displayName: Acme SSO }
settings:
  evals: { model: gpt-6-luna, judgeModel: claude-sonnet-5-5, generatorModel: gpt-6-luna, fallbacks: 'off' }
  discovery: { nativeSearchClients: [claude-code] }
  audit: { storeOutputs: true }
  tasks: { labelInferred: true }
servers:
  - slug: petstore
    name: Petstore
    spec: { path: ${join(REPO_ROOT, 'examples/petstore/openapi.yaml')} }
`);
    process.env.NR_TEST_IDP_SECRET = 'idp-secret';
    try {
      t = await createTestContext({ PUBLIC_URL: '', NEUROUTER_CONFIG: f, NR_TEST_IDP_SECRET: 'idp-secret' });
    } finally {
      delete process.env.NR_TEST_IDP_SECRET;
    }
    expect(t.s.config.publicUrl).toBe('https://mcp.acme.test');
    expect(t.s.config.env.OIDC_ISSUER).toBe('https://idp.acme.test');
    const auth = await t.json(null, { url: '/api/auth/config' }, 200);
    expect(auth.oidc).toMatchObject({ enabled: true, displayName: 'Acme SSO' });
    const s = await t.json(t.admin, { url: '/api/settings' }, 200);
    expect(s.models).toMatchObject({ judgeModel: 'claude-sonnet-5-5', generatorModel: 'gpt-6-luna', fallbacks: 'off' });
    expect(s.discovery.nativeSearchClients).toEqual(['claude-code']);
    expect(s.audit.storeOutputs).toBe(true);
    expect(s.fileManaged).toEqual(expect.arrayContaining(['models.judgeModel', 'models.generatorModel', 'models.fallbacks', 'discovery.nativeSearchClients', 'audit.storeOutputs']));
    expect(s.fileManaged).not.toContain('models.labelInferredTasks');
    const st = await t.s.services.configSync.state();
    expect(st.diagnostics.some((d) => d.code === 'config_ignored' && /settings\.tasks/.test(d.message))).toBe(true);
  }, 60_000);
});
