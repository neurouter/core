import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/client/validators/ajv';
import { compile, handleMockRequest, MockStore, wrapStructured, type OpenApiMockModel } from '@neurouter/compiler';
import { ArgValidator } from '../pipeline/arg-validate.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const enc = (s: string) => new TextEncoder().encode(s);

/** A recursive input (a tree) and an output that shares one component four times: both use `$defs`. */
const SPEC = JSON.stringify({
  openapi: '3.1.0',
  info: { title: 'Refs', version: '1' },
  paths: {
    '/trees': {
      post: {
        operationId: 'createTree',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } },
        responses: { '201': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Issue' } } } } },
      },
    },
    '/issues/{id}': {
      get: {
        operationId: 'getIssue',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
        responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Issue' } } } } },
      },
    },
  },
  components: {
    schemas: {
      Node: { type: 'object', required: ['name'], properties: { name: { type: 'string', minLength: 1 }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } },
      User: { type: 'object', required: ['login', 'created_at'], properties: { login: { type: 'string' }, email: { type: 'string', format: 'email' }, created_at: { type: 'string', format: 'date-time', example: '"2007-10-29T02:42:39.000-07:00"' }, ...Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`url_${i}`, { type: 'string', format: 'uri' }])) } },
      Issue: { type: 'object', required: ['id', 'author'], properties: { id: { type: 'integer' }, author: { $ref: '#/components/schemas/User' }, assignee: { $ref: '#/components/schemas/User' }, closed_by: { $ref: '#/components/schemas/User' }, merged_by: { $ref: '#/components/schemas/User' } } },
    },
  },
});

describe('$ref / $defs tool schemas', () => {
  it('validates tool-call arguments against an input schema with $defs (recursive body)', async () => {
    const r = await compile({ spec: { bytes: enc(SPEC) }, namespace: 'refs' });
    const t = r.tools.find((x) => x.name === 'create_tree')!;
    expect(JSON.stringify(t.inputSchema)).toContain('#/$defs/Node');
    const v = new ArgValidator();
    expect(v.check(t.defHash, t.inputSchema, { name: 'root', children: [{ name: 'a', children: [{ name: 'b' }] }] })).toEqual({ ok: true });
    const bad = v.check(t.defHash, t.inputSchema, { name: 'root', children: [{ name: 'a', children: [{ name: '' }] }] });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toContain('/children/0/children/0/name');
  });

  it('gives MCP clients (SDK validator) output schemas with $defs that mock results satisfy', async () => {
    const r = await compile({ spec: { bytes: enc(SPEC) }, namespace: 'refs' });
    const t = r.tools.find((x) => x.name === 'get_issue')!;
    expect(Object.keys((t.outputSchema!.$defs ?? {}) as object)).toEqual(['User']);
    const validate = new AjvJsonSchemaValidator().getValidator(t.outputSchema!);
    const res = await handleMockRequest(r.mockModel as OpenApiMockModel, new MockStore(), 'eval:x', { method: 'GET', path: '/issues/3' });
    expect(res.status).toBe(200);
    const out = validate(wrapStructured(res.body));
    expect(out.errorMessage).toBeUndefined();
    expect(out.valid).toBe(true);
    // a wrong shape is rejected through the reference
    expect(validate({ id: 1, author: { login: 'x', created_at: 'yesterday' } }).valid).toBe(false);
  });

  it('mock results of the GitHub subset satisfy the format constraints of their output schemas', async () => {
    const r = await compile({ spec: { bytes: readFileSync(resolve(REPO, 'examples/github/github-subset.json')) }, namespace: 'github' });
    const sdk = new AjvJsonSchemaValidator();
    const store = new MockStore();
    const failures: string[] = [];
    let checked = 0;
    for (const t of r.tools) {
      if (t.binding.type !== 'http' || t.binding.method !== 'GET' || !t.outputSchema) continue;
      const path = t.binding.pathTemplate.replace(/\{([^}]+)\}/g, (_, n: string) => (n === 'owner' ? 'octocat' : n === 'repo' ? 'Hello-World' : '1'));
      const res = await handleMockRequest(r.mockModel as OpenApiMockModel, store, 'eval:x', { method: 'GET', path });
      if (res.status >= 300) continue;
      checked++;
      const out = sdk.getValidator(t.outputSchema)(wrapStructured(res.body));
      if (!out.valid && /format|pattern|maxLength|minLength|enum/.test(out.errorMessage ?? '')) failures.push(`${t.name}: ${out.errorMessage}`);
    }
    expect(checked).toBeGreaterThan(20);
    expect(failures).toEqual([]);
    // the demo's broken tool: commit dates are date-times now (the spec's example is a quoted string)
    const commits = r.tools.find((t) => t.name === 'repos_list_commits');
    if (commits) {
      const res = await handleMockRequest(r.mockModel as OpenApiMockModel, store, 'eval:x', { method: 'GET', path: '/repos/octocat/Hello-World/commits' });
      expect(sdk.getValidator(commits.outputSchema!)(wrapStructured(res.body)).valid).toBe(true);
    }
  }, 30_000);
});
