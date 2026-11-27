import { describe, expect, it } from 'vitest';
import type { ToolDef } from '@neurouter/shared';
import { handleMockRequest } from './mock/handler.js';
import type { OpenApiMockModel } from './mock/model.js';
import { MockStore } from './mock/store.js';
import { defRefName, OMITTED_KEY, OUTPUT_SCHEMA_LIMITS, SchemaResolver } from './openapi/schema.js';
import { compileFile, compileText, GITHUB_SUBSET, spec31 } from './test/fixtures.js';

const size = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Every `#/$defs/X` reference in a root schema names an entry of its `$defs`. */
function danglingRefs(root: Record<string, unknown>): string[] {
  const defs = (root.$defs ?? {}) as Record<string, unknown>;
  const out: string[] = [];
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.$ref === 'string') {
      const n = defRefName(o.$ref);
      if (n === null || !(n in defs)) out.push(o.$ref);
    }
    Object.values(o).forEach(visit);
  };
  visit(root);
  return out;
}

/**
 * A Stripe-shaped spec: `n` objects whose fields are "expandable" (`anyOf: [string id, $ref Other]`)
 * and point at `fanout` other objects, each with a long description. Inlining every reference copies
 * the graph exponentially (Stripe's customer schema was ~14 MB per tool).
 */
function expandableSpec(n = 60, fanout = 8): string {
  const schemas: Record<string, unknown> = {};
  for (let i = 0; i < n; i++) {
    const props: Record<string, unknown> = {
      id: { type: 'string', maxLength: 5000 },
      object: { type: 'string', enum: [`obj${i}`] },
      created: { type: 'integer', format: 'unix-time' },
      description: { type: 'string', nullable: true, description: 'x'.repeat(300) },
    };
    for (let k = 1; k <= fanout; k++) {
      const j = (i * 7 + k * 13) % n;
      props[`link_${k}`] = { anyOf: [{ type: 'string', maxLength: 5000 }, { $ref: `#/components/schemas/obj${j}` }], nullable: true, description: `Expandable obj${j}. ${'d'.repeat(200)}` };
    }
    schemas[`obj${i}`] = { type: 'object', description: `Object ${i}`, properties: props, required: ['id', 'object', 'created'] };
  }
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 12; i++) {
    paths[`/v1/obj${i}`] = {
      get: {
        operationId: `GetObj${i}`,
        summary: `List obj${i}`,
        parameters: [{ name: 'limit', in: 'query', schema: { type: 'integer' } }],
        responses: {
          '200': {
            description: 'ok',
            content: { 'application/json': { schema: { type: 'object', required: ['data', 'has_more', 'object', 'url'], properties: { data: { type: 'array', items: { $ref: `#/components/schemas/obj${i}` } }, has_more: { type: 'boolean' }, object: { type: 'string', enum: ['list'] }, url: { type: 'string' } } } } },
          },
        },
      },
    };
    paths[`/v1/obj${i}/{id}`] = {
      get: { operationId: `GetObj${i}Id`, summary: `Get obj${i}`, parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: `#/components/schemas/obj${i}` } } } } } },
    };
  }
  return JSON.stringify({ openapi: '3.0.3', info: { title: 'Expandable', version: '1' }, paths, components: { schemas } });
}

describe('schema budgets ($defs, dedupe, trimming)', () => {
  it('compiles a densely linked (Stripe-like) spec to bounded output schemas', async () => {
    const t0 = Date.now();
    const r = await compileText(expandableSpec());
    expect(r.ok).toBe(true);
    expect(Date.now() - t0).toBeLessThan(20_000);
    expect(r.tools).toHaveLength(24);
    for (const t of r.tools) {
      expect(t.outputSchema, t.name).toBeDefined();
      expect(size(t.outputSchema), t.name).toBeLessThanOrEqual(OUTPUT_SCHEMA_LIMITS.maxBytes + 256);
      expect(danglingRefs(t.outputSchema!), t.name).toEqual([]);
    }
    // the listed object itself keeps its full schema; far components are left open
    const list = r.tools.find((t) => t.name === 'get_obj0')!;
    const defs = list.outputSchema!.$defs as Record<string, Record<string, unknown>>;
    expect(((list.outputSchema!.properties as Record<string, Record<string, unknown>>).data!.items as Record<string, unknown>).$ref).toBe('#/$defs/obj0');
    expect(Object.keys(defs.obj0!.properties as object)).toContain('link_1');
    expect(JSON.stringify(list.outputSchema)).toContain(OMITTED_KEY);
    expect(r.diagnostics.some((d) => d.code === 'output_schema_trimmed')).toBe(true);
  }, 30_000);

  it('references a repeated component once in $defs (never larger than inlining)', async () => {
    const user = { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`field_${i}`, { type: 'string', description: `Field ${i} of the user record.` }])) };
    const text = spec31(
      { '/issue': { get: { operationId: 'getIssue', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { $ref: '#/components/schemas/Issue' } } } } } } } },
      { schemas: { User: user, Issue: { type: 'object', properties: { author: { $ref: '#/components/schemas/User' }, assignee: { $ref: '#/components/schemas/User' }, closed_by: { $ref: '#/components/schemas/User' }, assignees: { type: 'array', items: { $ref: '#/components/schemas/User' } } } } } },
    );
    const r = await compileText(text);
    const out = r.tools[0]!.outputSchema!;
    expect(Object.keys(out.$defs as object)).toEqual(['User']);
    const props = out.properties as Record<string, Record<string, unknown>>;
    // first use inline, the rest reference the shared definition
    expect(props.author!['x-schema-name']).toBe('User');
    expect(props.assignee).toEqual({ $ref: '#/$defs/User' });
    expect(danglingRefs(out)).toEqual([]);
    // the plain inlined form would be larger
    const plain = new SchemaResolver(JSON.parse(text)).convert({ $ref: '#/components/schemas/Issue' }, { drop: 'writeOnly', limits: { ...OUTPUT_SCHEMA_LIMITS, dedupeMinBytes: Infinity, inlineMaxBytes: 1e9 } });
    expect(size(out)).toBeLessThan(size(plain.schema));
  });

  it('keeps input schemas inlined (agents fill them in)', async () => {
    const addr = { type: 'object', properties: Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`line_${i}`, { type: 'string', description: `Address line ${i}.` }])) };
    const text = spec31(
      { '/orders': { post: { operationId: 'createOrder', requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { billing: { $ref: '#/components/schemas/Addr' }, shipping: { $ref: '#/components/schemas/Addr' } } } } } }, responses: { '201': { description: 'ok' } } } } },
      { schemas: { Addr: addr } },
    );
    const t = (await compileText(text)).tools[0]!;
    expect(JSON.stringify(t.inputSchema)).not.toContain('$ref');
    expect((t.inputSchema.properties as Record<string, Record<string, unknown>>).shipping!['x-schema-name']).toBe('Addr');
  });

  it('shapes output schemas through $defs references (include/exclude/flatten) and prunes unused defs', async () => {
    const user = { type: 'object', properties: { login: { type: 'string' }, ...Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`url_${i}`, { type: 'string', format: 'uri', description: `URL ${i}` }])) } };
    const text = spec31(
      { '/issues': { get: { operationId: 'listIssues', responses: { '200': { description: 'ok', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Issue' } } } } } } } } },
      { schemas: { User: user, Issue: { type: 'object', properties: { number: { type: 'integer' }, user: { $ref: '#/components/schemas/User' }, closed_by: { $ref: '#/components/schemas/User' }, merged_by: { $ref: '#/components/schemas/User' }, assignee: { $ref: '#/components/schemas/User' } } } } },
    );
    const raw = (await compileText(text)).tools[0]!.outputSchema!;
    expect(JSON.stringify(raw)).toContain('#/$defs/User');
    const overlay = 'overlay: 1\ntools:\n  "operationId:listIssues":\n    response: { include: ["[].number", "[].closed_by.login"], flatten: { "[].closed_by.login": closer } }\n';
    const compiled = await compileText(text, overlay);
    expect(compiled.ok).toBe(true);
    const shaped = compiled.tools[0]!.outputSchema!;
    const item = (shaped.properties as Record<string, Record<string, unknown>>).items!.items as Record<string, unknown>;
    expect(Object.keys(item.properties as object).sort()).toEqual(['closer', 'number']);
    expect((item.properties as Record<string, unknown>).closer).toEqual({ type: 'string' });
    expect(shaped.$defs).toBeUndefined();
  });

  it('mocks lists whose items are $defs references, with the envelope fields the schema requires', async () => {
    const r = await compileText(expandableSpec(30, 6));
    const m = r.mockModel as OpenApiMockModel;
    expect(m.resources['/v1/obj0']).toBeDefined();
    const res = await handleMockRequest(m, new MockStore(), 'ns', { method: 'GET', path: '/v1/obj0' });
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(body).toMatchObject({ object: 'list', has_more: false });
    expect(typeof body.url).toBe('string');
    const first = (body.data as Array<Record<string, unknown>>)[0]!;
    expect(first.object).toBe('obj0');
    expect(typeof first.created).toBe('number');
  });

  it('leaves GitHub subset tool names, arguments and input schemas as inlined before (no $ref in inputs)', async () => {
    const r = await compileFile(GITHUB_SUBSET);
    const tools: ToolDef[] = r.tools;
    expect(tools.length).toBeGreaterThan(40);
    for (const t of tools) expect(danglingRefs(t.inputSchema), t.name).toEqual([]);
    for (const t of tools) if (t.outputSchema) expect(danglingRefs(t.outputSchema), t.name).toEqual([]);
    expect(tools.filter((t) => JSON.stringify(t.inputSchema).includes('$ref'))).toEqual([]);
  });
});
