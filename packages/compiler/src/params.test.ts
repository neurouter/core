import { describe, expect, it } from 'vitest';
import type { HttpBinding } from '@neurouter/shared';
import { compileText, NOTES_SPEC, spec31 } from './test/fixtures.js';

const ok = { '200': { description: 'ok' } };

describe('parameters and bodies', () => {
  it('spreads small object bodies and drops readOnly inputs / writeOnly outputs', async () => {
    const r = await compileText(NOTES_SPEC);
    const create = r.tools.find((t) => t.name === 'create_note')!;
    const props = create.inputSchema.properties as Record<string, unknown>;
    expect(Object.keys(props)).toEqual(['project', 'title', 'body', 'state']);
    expect(create.inputSchema.required).toEqual(['project', 'title']);
    expect(create.inputSchema.additionalProperties).toBe(false);
    expect((create.binding as HttpBinding).body).toEqual({ arg: null, contentType: 'application/json', spread: true, properties: ['id', 'title', 'body', 'state'].filter((p) => p !== 'id') });
    const out = create.outputSchema as { properties: Record<string, unknown> };
    expect(Object.keys(out.properties)).not.toContain('secret');
    expect(Object.keys(out.properties)).toContain('id');
  });

  it('keeps a single body arg when spreading would clash or exceed 20 props', async () => {
    const big = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, { type: 'string' }]));
    const r = await compileText(
      spec31({
        '/a/{id}': { post: { operationId: 'clash', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } } }, responses: ok } },
        '/b': { post: { operationId: 'big', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: big } } } }, responses: ok } },
        '/c': { post: { operationId: 'arr', requestBody: { content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } }, responses: ok } },
      }),
    );
    expect((r.tools[0]!.binding as HttpBinding).body).toMatchObject({ arg: 'body', spread: false });
    expect(r.tools[0]!.inputSchema.required).toEqual(['id', 'body']);
    expect((r.tools[1]!.binding as HttpBinding).body).toMatchObject({ arg: 'body', spread: false });
    expect((r.tools[2]!.binding as HttpBinding).body).toMatchObject({ arg: 'body', spread: false });
  });

  it('prefixes colliding parameter names with their location and snake_cases names', async () => {
    const r = await compileText(
      spec31({
        '/x/{id}': {
          get: {
            operationId: 'x',
            parameters: [
              { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
              { name: 'id', in: 'query', schema: { type: 'string' } },
              { name: 'pageSize', in: 'query', schema: { type: 'integer' } },
            ],
            responses: ok,
          },
        },
      }),
    );
    expect((r.tools[0]!.binding as HttpBinding).params.map((p) => [p.arg, p.in, p.name])).toEqual([
      ['path_id', 'path', 'id'],
      ['query_id', 'query', 'id'],
      ['page_size', 'query', 'pageSize'],
    ]);
  });

  it('strips credential parameters (Authorization, Cookie, apiKey scheme names)', async () => {
    const r = await compileText(
      spec31(
        {
          '/x': {
            get: {
              operationId: 'x',
              parameters: [
                { name: 'Authorization', in: 'header', schema: { type: 'string' } },
                { name: 'X-Api-Key', in: 'header', schema: { type: 'string' } },
                { name: 'X-Trace', in: 'header', schema: { type: 'string' } },
              ],
              responses: ok,
            },
          },
        },
        { securitySchemes: { key: { type: 'apiKey', in: 'header', name: 'X-Api-Key' } } },
      ),
    );
    expect(Object.keys(r.tools[0]!.inputSchema.properties as object)).toEqual(['x_trace']);
    expect(r.diagnostics.filter((d) => d.code === 'auth_param_stripped')).toHaveLength(2);
  });

  it('keeps recursive schemas as $defs references', async () => {
    const r = await compileText(
      spec31(
        { '/tree': { post: { operationId: 'tree', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Node' } } } }, responses: ok } } },
        { schemas: { Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } } } } } },
      ),
    );
    const t = r.tools[0]!;
    expect(t.inputSchema.$defs).toHaveProperty('Node');
    expect((t.inputSchema.properties as Record<string, { items?: unknown }>).children!.items).toEqual({ $ref: '#/$defs/Node' });
  });

  it('builds examples from parameter and body examples', async () => {
    const r = await compileText(
      spec31({ '/p/{id}': { get: { operationId: 'p', parameters: [{ name: 'id', in: 'path', required: true, example: 7, schema: { type: 'integer' } }], responses: ok } } }),
    );
    expect(r.tools[0]!.examples).toEqual([{ title: 'From the spec', arguments: { id: 7 }, source: 'spec' }]);
  });
});
