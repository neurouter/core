import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor, REPO_ROOT } from '../fakes/server.js';

type Env = Record<string, any>;
const V2_CODE = { 'x-neurouter-contract': '2', 'x-neurouter-exposure': 'code' };

/**
 * H5 (0.3.1 A/B, stripe, code, contract 2, stripe_support_case_transcript_unavailable #3): one
 * `search_tools({"query": "support case ticket conversations messages list retrieve Stripe support account review",
 * "limit": 25, "detail": "full"})` returned 45,271 chars (25 hits, each with its input schema and docstring).
 * The same call shape on the GitHub subset in the repo.
 */
describe('contract 2: search_tools output is capped (H5)', () => {
  let s: RunningServer;
  let key: string;
  let keySmall: string;
  const gh = resolve(REPO_ROOT, 'examples/github');
  const search = async (args: Record<string, unknown>, env = 'mock'): Promise<{ r: Env; chars: number }> => {
    const c = rawMcp(`${s.url}/mcp/github/${env}`, env === 'mock' ? key : keySmall, { headers: V2_CODE });
    await c.initialize();
    const res = (await c.call('search_tools', args)).result as Env;
    return { r: assertEnvelope(res, 'search_tools'), chars: (res.content[0].text as string).length };
  };

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-h5-'));
    const file = join(dir, 'neurouter.yaml');
    const env = (slug: string, extra = '') => `{ slug: ${slug}, kind: dev, baseUrl: "mock:", writes: { enabled: true }, codeMode: true${extra} }`;
    writeFileSync(
      file,
      [
        'version: 1',
        'settings:',
        '  codeMode: { enabled: true }',
        'servers:',
        `  - { slug: github, name: GitHub REST, spec: { path: ${JSON.stringify(join(gh, 'github-subset.json'))} }, overlay: ${JSON.stringify(join(gh, 'agent-ready.overlay.yaml'))}, exposure: { contract: 2 }, environments: [${env('mock')}, ${env('small', ', limits: { searchResultChars: 3000 }')}] }`,
      ].join('\n'),
    );
    s = await bootServer({ NEUROUTER_CONFIG: file });
    key = await keyFor(s, 'github', 'mock', ['tools:read', 'tools:write', 'code:run']);
    keySmall = await keyFor(s, 'github', 'small', ['tools:read', 'tools:write', 'code:run']);
  }, 120_000);
  afterAll(async () => {
    await s?.close();
  });

  it('limit 25 + detail "full": the result fits the default 8,192-char budget, keeps the best hits whole, and says how to get more', async () => {
    const { r, chars } = await search({ query: 'list repositories issues pull requests commits branches releases for an organization or user', limit: 25, detail: 'full' });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(JSON.stringify(r.data).length).toBeLessThanOrEqual(8192);
    expect(chars).toBeLessThan(8192 + 1200);
    const tools = r.data.tools as Env[];
    // the top hits keep their full detail (code mode: the docstring); later hits keep purpose and signature
    expect(tools[0]!.doc).toBeDefined();
    expect(tools.at(-1)!.doc).toBeUndefined();
    expect(tools.at(-1)!.signature).toBeDefined();
    // marked: what was dropped, and the call that gets one tool in full
    expect(r.truncated).toMatchObject({ next: { tool: 'search_tools', args: { limit: 1, detail: 'full' } } });
    expect(r.truncated.omitted_bytes).toBeGreaterThan(0);
    expect(r.hint).toMatch(/narrower query|detail/i);
    // the next call returns that one tool with its full detail
    const one = await search(r.truncated.next.args);
    expect(one.r.data.tools[0].name).toBe(r.truncated.next.args.query);
    expect(one.r.data.tools[0].doc).toBeDefined();
    expect(one.r.truncated).toBeNull();
  });

  it('a small result is untouched; the budget is configurable per environment (limits.searchResultChars)', async () => {
    const brief = await search({ query: 'get a repository', limit: 3 });
    expect(brief.r.truncated).toBeNull();
    const small = await search({ query: 'list repositories issues pull requests commits branches releases for an organization or user', limit: 25, detail: 'full' }, 'small');
    expect(JSON.stringify(small.r.data).length).toBeLessThanOrEqual(3000);
    expect(small.r.data.tools.length).toBeGreaterThan(0);
    expect(small.r.truncated).not.toBeNull();
  });
});
