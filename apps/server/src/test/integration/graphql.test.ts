import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { bootServer, keyFor, mcpClient, REPO_ROOT } from '../fakes/server.js';

describe('GraphQL server on the mock', () => {
  let s: RunningServer;
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-gql-'));
    writeFileSync(join(dir, 'neurouter.yaml'), `version: 1\nservers:\n  - slug: countries\n    name: Countries\n    spec: { path: ${resolve(REPO_ROOT, 'examples/graphql-countries/schema.graphql')}, format: graphql-sdl }\n    environments: []\n`);
    s = await bootServer({ NEUROUTER_CONFIG: join(dir, 'neurouter.yaml'), NEUROUTER_EXECUTOR_MODE: 'off' });
  }, 60_000);
  afterAll(async () => s?.close());

  it('lists one tool per root field and executes a query against the seeded resolvers', async () => {
    const c = await mcpClient(s, 'countries', 'mock', await keyFor(s, 'countries', 'mock', ['tools:read']));
    const tools = (await c.listTools()).tools.filter((t) => !t.name.startsWith('neurouter_'));
    expect(tools.length).toBeGreaterThanOrEqual(3);
    const q = tools.find((t) => !(t._meta as Record<string, unknown>)['dev.neurouter/write'])!;
    const required = ((q.inputSchema as { required?: string[] }).required ?? []) as string[];
    const args = Object.fromEntries(required.map((k) => [k, 'FI']));
    const r = await c.callTool({ name: q.name, arguments: args });
    expect(r.isError, JSON.stringify(r.content)).toBeFalsy();
    expect(r.structuredContent).toBeTruthy();
    await c.close();
  });
});
