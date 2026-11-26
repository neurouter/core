import { describe, expect, it } from 'vitest';
import { NeurouterYaml, effectiveConfirm, neurouterYamlJsonSchema } from './neurouter-yaml.js';
import { parseSecretRef } from './secret-ref.js';
import { DEFAULT_LIMITS, mergeLimits } from './limits.js';
import { Policy } from './policy.js';

/** The backend spec §6.2 example, as a JS object (what `yaml.parse` returns). */
const SPEC_EXAMPLE = {
  version: 1,
  instance: { name: 'Acme API gateway', publicUrl: 'https://mcp.acme.dev' },
  auth: {
    oidc: { issuer: 'https://accounts.google.com', clientId: '1234.apps.googleusercontent.com', clientSecret: 'env:OIDC_CLIENT_SECRET', adminGroups: ['platform-admins'], allowedEmailDomains: ['acme.dev'] },
    externalAs: { issuer: 'https://auth.acme.dev', jwksUri: 'https://auth.acme.dev/.well-known/jwks.json', audience: 'auto', requiredScopes: ['mcp'] },
  },
  settings: { codeMode: { enabled: true }, evals: { model: 'claude-sonnet-5-5', apiKey: 'env:ANTHROPIC_API_KEY', effort: 'medium', repeats: 3 }, retentionDays: 30 },
  servers: [
    {
      slug: 'github',
      name: 'GitHub REST',
      description: 'Issues, pull requests and repositories',
      spec: { url: 'https://raw.githubusercontent.com/github/rest-api-description/v2.1.0/descriptions/api.github.com/api.github.com.yaml' },
      overlay: './overlays/github.overlay.yaml',
      exposure: { mode: 'auto', discovery: 'auto', pinned: ['issues_list_for_repo', 'issues_create'] },
      opsTools: { begin_task: true, end_task: true, log_decision: true, report_unmet_need: true, report_issue: true, explain_error: true, get_examples: true, whoami: true },
      publicReport: true,
      environments: [
        { slug: 'dev', kind: 'dev', baseUrl: 'mock:', auth: { type: 'none' }, writes: { enabled: true }, codeMode: true },
        {
          slug: 'prod',
          kind: 'prod',
          baseUrl: 'https://api.github.com',
          auth: { type: 'bearer', secret: 'env:GITHUB_TOKEN' },
          headers: { 'X-GitHub-Api-Version': '2022-11-28' },
          writes: { enabled: true, tools: ['issues_create', 'issues_create_comment'], confirm: 'elicit' },
          limits: {
            rateLimit: { perMinute: 120, burst: 30 },
            toolRateLimit: { perMinute: 60, burst: 10 },
            timeoutMs: 15000,
            maxResponseBytes: 2097152,
            code: { maxToolCalls: 200, wallTimeSec: 30, cpuTimeSec: 10, maxMemoryMb: 64, maxConcurrentCalls: 8, maxResultBytes: 1048576 },
          },
          policies: [{ name: 'no-external-write-after-sensitive-read', deny: { sequence: { first: { tags: ['read-sensitive'] }, then: { tags: ['external-write'] } }, within: 'task' } }],
          allowedHosts: ['api.github.com'],
        },
      ],
    },
  ],
};

const clone = <T>(v: T): T => structuredClone(v);
const prod = (f: typeof SPEC_EXAMPLE) => f.servers[0]!.environments[1]! as Record<string, unknown>;
const issues = (v: unknown) => {
  const r = NeurouterYaml.safeParse(v);
  return r.success ? [] : r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
};

describe('neurouter.yaml schema', () => {
  it('accepts the §6.2 example verbatim', () => {
    expect(issues(SPEC_EXAMPLE)).toEqual([]);
    const f = NeurouterYaml.parse(SPEC_EXAMPLE);
    expect(f.servers[0]!.environments[0]!.writes.enabled).toBe(true);
    expect(f.servers[0]!.environments[1]!.policies[0]!.name).toBe('no-external-write-after-sensitive-read');
  });

  it('applies defaults (read-only, no auth, mock not required)', () => {
    const f = NeurouterYaml.parse({ version: 1, servers: [{ slug: 'petstore', name: 'Petstore', spec: { path: './openapi.yaml' }, environments: [{ slug: 'qa', kind: 'qa', baseUrl: 'https://qa.example.com' }] }] });
    const env = f.servers[0]!.environments[0]!;
    expect(env.writes).toEqual({ enabled: false });
    expect(env.auth).toEqual({ type: 'none' });
    expect(f.servers[0]!.exposure).toEqual({ mode: 'auto', discovery: 'auto', pinned: [] });
    expect(effectiveConfirm('prod', undefined)).toBe('elicit');
    expect(effectiveConfirm('dev', undefined)).toBe('none');
  });

  it('rejects literal secrets everywhere', () => {
    const a = clone(SPEC_EXAMPLE);
    (prod(a).auth as Record<string, unknown>).secret = 'ghp_abc123';
    expect(issues(a).join('\n')).toMatch(/Literal secrets/);
    const b = clone(SPEC_EXAMPLE);
    b.auth.oidc.clientSecret = 'super-secret';
    expect(issues(b).join('\n')).toMatch(/auth\.oidc\.clientSecret: Literal secrets/);
    const c = clone(SPEC_EXAMPLE);
    c.settings.evals.apiKey = 'sk-ant-xyz';
    expect(issues(c).join('\n')).toMatch(/settings\.evals\.apiKey/);
  });

  it('rejects credential-looking static headers', () => {
    const a = clone(SPEC_EXAMPLE);
    prod(a).headers = { Authorization: 'Bearer abc' };
    expect(issues(a).join('\n')).toMatch(/looks like a credential/);
  });

  it('rejects confirm: none on prod (but allows it on dev)', () => {
    const a = clone(SPEC_EXAMPLE);
    (prod(a).writes as Record<string, unknown>).confirm = 'none';
    expect(issues(a).join('\n')).toMatch(/writes\.confirm: prod environments cannot use confirm: none/);
    const b = clone(SPEC_EXAMPLE);
    (b.servers[0]!.environments[0] as Record<string, unknown>).writes = { enabled: true, confirm: 'none' };
    expect(issues(b)).toEqual([]);
  });

  it('rejects bad and duplicate slugs', () => {
    const a = clone(SPEC_EXAMPLE);
    a.servers[0]!.slug = 'Git_Hub';
    expect(issues(a).join('\n')).toMatch(/servers\.0\.slug/);
    const b = clone(SPEC_EXAMPLE);
    b.servers.push(clone(b.servers[0]!));
    expect(issues(b).join('\n')).toMatch(/duplicate server slug "github"/);
    const c = clone(SPEC_EXAMPLE);
    c.servers[0]!.environments[1]!.slug = 'dev';
    expect(issues(c).join('\n')).toMatch(/duplicate environment slug "dev"/);
    const d = clone(SPEC_EXAMPLE);
    d.servers[0]!.environments[0]!.slug = '1dev';
    expect(issues(d).join('\n')).toMatch(/environments\.0\.slug/);
  });

  it('rejects unknown keys, bad base URLs, both url and path, and credentials on mock', () => {
    expect(issues({ ...clone(SPEC_EXAMPLE), extra: 1 }).length).toBeGreaterThan(0);
    const a = clone(SPEC_EXAMPLE);
    (prod(a) as Record<string, unknown>).baseUrl = 'ftp://x';
    expect(issues(a).join('\n')).toMatch(/baseUrl/);
    const b = clone(SPEC_EXAMPLE);
    (b.servers[0]!.spec as Record<string, unknown>).path = './x.yaml';
    expect(issues(b).join('\n')).toMatch(/exactly one of url or path/);
    const c = clone(SPEC_EXAMPLE);
    (c.servers[0]!.environments[0] as Record<string, unknown>).auth = { type: 'bearer', secret: 'env:X' };
    expect(issues(c).join('\n')).toMatch(/mock environments take no credentials/);
    expect(issues({ version: 2 }).length).toBeGreaterThan(0);
  });

  it('validates upstream auth variants', () => {
    const ok = (auth: unknown) => {
      const f = clone(SPEC_EXAMPLE);
      prod(f).auth = auth;
      return issues(f);
    };
    expect(ok({ type: 'header', header: { name: 'X-API-Key', secret: 'env:KEY' } })).toEqual([]);
    expect(ok({ type: 'basic', username: 'svc', secret: 'secret:svc-pw' })).toEqual([]);
    expect(ok({ type: 'oauth_client_credentials', oauth_client_credentials: { tokenUrl: 'https://auth.acme.dev/token', clientId: 'c', clientSecret: 'env:CS' } })).toEqual([]);
    expect(ok({ type: 'oauth_passthrough', oauth_passthrough: { authorizationUrl: 'https://github.com/login/oauth/authorize', tokenUrl: 'https://github.com/login/oauth/access_token', clientId: 'c', clientSecret: 'env:GH_CS', scopes: ['repo'] } })).toEqual([]);
    expect(ok({ type: 'oauth_passthrough', forwardInboundToken: true })).not.toEqual([]);
    expect(ok({ type: 'oauth_passthrough', forwardInboundToken: true, upstreamAudience: 'https://api.acme.dev' })).toEqual([]);
    expect(ok({ type: 'oauth_passthrough' }).join('\n')).toMatch(/broker mode/);
  });

  it('exports a JSON Schema', () => {
    const s = neurouterYamlJsonSchema();
    expect(s.title).toBe('neurouter.yaml');
    expect(JSON.stringify(s)).toContain('"servers"');
  });
});

describe('secret refs, limits, policies', () => {
  it('parses refs', () => {
    expect(parseSecretRef('env:GITHUB_TOKEN')).toEqual({ kind: 'env', name: 'GITHUB_TOKEN' });
    expect(parseSecretRef('secret:acme.key-1')).toEqual({ kind: 'secret', name: 'acme.key-1' });
    expect(parseSecretRef('ghp_x')).toBeNull();
    expect(parseSecretRef('env:')).toBeNull();
  });
  it('merges limits over the defaults', () => {
    const l = mergeLimits({ timeoutMs: 5000, code: { maxToolCalls: 50 } });
    expect(l.timeoutMs).toBe(5000);
    expect(l.code.maxToolCalls).toBe(50);
    expect(l.code.wallTimeSec).toBe(30);
    expect(l.rateLimit).toEqual(DEFAULT_LIMITS.rateLimit);
    expect(DEFAULT_LIMITS.code.maxMemoryMb).toBe(64);
  });
  it('validates policies', () => {
    expect(Policy.parse({ name: 'no-deletes', deny: { tools: ['delete_pet'] }, message: 'Deletes are off' })).toBeTruthy();
    expect(Policy.parse({ name: 'hours', deny: { tags: ['external-write'], when: { outsideHours: '08:00-18:00 Europe/Helsinki', argMatches: { repo: '^prod-' } } } })).toBeTruthy();
    expect(() => Policy.parse({ name: 'empty', deny: {} })).toThrow();
    expect(() => Policy.parse({ name: 'bad', deny: { when: { argMatches: { a: '(' } } } })).toThrow(/regular expression/);
    expect(() => Policy.parse({ name: 'bad', deny: { when: { outsideHours: '8-18' } } })).toThrow();
  });
});
