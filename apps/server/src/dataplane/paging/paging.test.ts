import type { ToolDef } from '@neurouter/shared';
import { describe, expect, it } from 'vitest';
import { CursorCodec, CursorError, type CursorBinding } from './cursor.js';
import { clippedFields, projectFields } from './fields.js';
import { applyPosition, linkNext, linkQuery, nextSignals, pagingPlan, splitArgs, v2InputSchema } from './plan.js';

function listTool(name: string, params: Array<{ name: string; type?: string; default?: unknown }>, outputSchema: Record<string, unknown>, extra: Partial<ToolDef> = {}): ToolDef {
  return {
    name,
    pyName: `t.${name}`,
    title: name,
    description: name,
    kind: 'operation' as ToolDef['kind'],
    inputSchema: { type: 'object', additionalProperties: false, properties: Object.fromEntries(params.map((p) => [p.name, { type: p.type ?? 'string', ...(p.default !== undefined ? { default: p.default } : {}) }])) },
    outputSchema,
    binding: { type: 'http', method: 'GET', pathTemplate: `/${name}`, params: params.map((p) => ({ arg: p.name, in: 'query' as const, name: p.name, required: false })), successStatuses: [200], responseContentType: 'application/json', security: [] },
    risk: { readOnly: true, destructive: false, idempotent: true, openWorld: true, write: false },
    tags: [],
    hidden: false,
    pinned: false,
    deprecated: false,
    examples: [],
    pySignature: '',
    sourceRef: { pointer: '' },
    overlayApplied: [],
    key: name,
    defHash: `h-${name}`,
    ...extra,
  };
}
const ARRAY = { type: 'object', properties: { items: { type: 'array' } }, 'x-neurouter-wrapped': 'items' };
const wrapper = (key: string, extra: Record<string, unknown> = {}) => ({ type: 'object', properties: { [key]: { type: 'array' }, ...extra } });

const cursorTool = listTool('list_widgets', [{ name: 'status' }, { name: 'cursor' }, { name: 'limit', type: 'integer', default: 5 }], wrapper('data', { next_cursor: { type: ['string', 'null'] } }));
const pageTool = listTool('list_gadgets', [{ name: 'page', type: 'integer' }, { name: 'per_page', type: 'integer', default: 5 }], ARRAY);
const offsetTool = listTool('list_gizmos', [{ name: 'offset', type: 'integer' }, { name: 'limit', type: 'integer', default: 5 }], wrapper('items', { total: { type: 'integer' } }));
const stripeTool = listTool('list_charges', [{ name: 'starting_after' }, { name: 'limit', type: 'integer', default: 5 }], wrapper('data', { has_more: { type: 'boolean' }, object: { type: 'string' }, url: { type: 'string' } }));
const tokenTool = listTool('list_docs', [{ name: 'pageToken' }, { name: 'pageSize', type: 'integer', default: 5 }], wrapper('documents', { nextPageToken: { type: 'string' } }));
const collide = listTool('list_reports', [{ name: 'page', type: 'integer' }, { name: 'per_page', type: 'integer', default: 5 }, { name: 'limit', type: 'number' }, { name: 'fields' }], ARRAY);
const getTool = listTool('get_note', [{ name: 'note_id' }], { type: 'object', properties: { id: { type: 'string' }, tags: { type: 'array' } } });

describe('cursor codec (contract-v2 §2.1)', () => {
  let now = 1_000_000;
  const codec = new CursorCodec(() => Buffer.alloc(32, 7), () => now);
  const b: CursorBinding = { tenantId: 't1', credentialKey: 'k1', tool: 'list_widgets', args: { status: 'a' }, contract: 2 };

  it('round-trips, is short and opaque-ish, and is bound to tool, arguments, credential, tenant and contract', () => {
    const c = codec.encode({ k: 'u', v: '15' }, b);
    expect(c).toMatch(/^c_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{16}$/);
    expect(c.length).toBeLessThan(80);
    expect(codec.decode(c, b)).toEqual({ k: 'u', v: '15' });
    for (const other of [{ ...b, tool: 'list_gadgets' }, { ...b, args: { status: 'b' } }, { ...b, args: {} }, { ...b, credentialKey: 'k2' }, { ...b, tenantId: 't2' }, { ...b, contract: 1 }]) {
      expect(() => codec.decode(c, other)).toThrow(CursorError);
      try {
        codec.decode(c, other);
      } catch (e) {
        expect((e as CursorError).problem).toBe('mismatch');
      }
    }
  });

  it('is tamper-evident and expires after 1 hour', () => {
    const c = codec.encode({ k: 'p', n: 2 }, b);
    const [body, mac] = c.slice(2).split('.') as [string, string];
    const forged = `c_${Buffer.from(JSON.stringify([9e9, { k: 'p', n: 9 }])).toString('base64url')}.${mac}`;
    expect(() => codec.decode(forged, b)).toThrow(/does not belong/);
    expect(() => codec.decode(`c_${body}.${mac.slice(0, -1)}${mac.endsWith('A') ? 'B' : 'A'}`, b)).toThrow(CursorError);
    expect(() => codec.decode('c_nope', b)).toThrow(/not a cursor/);
    now += 3_600_001;
    expect(() => codec.decode(c, b)).toThrow(/expired/);
  });
});

describe('paging plan and the contract-2 input schema (D6)', () => {
  it('detects the upstream style and replaces its position/size parameters with cursor + limit', () => {
    expect(pagingPlan(cursorTool)).toMatchObject({ list: true, cursor: { arg: 'cursor' }, size: { arg: 'limit' }, names: { cursor: 'cursor', limit: 'limit', fields: 'fields' }, replaced: [] });
    expect(pagingPlan(pageTool)).toMatchObject({ page: { arg: 'page' }, size: { arg: 'per_page' }, names: { cursor: 'cursor', limit: 'limit' }, replaced: ['page', 'per_page'] });
    expect(pagingPlan(stripeTool)).toMatchObject({ cursor: { arg: 'starting_after' }, startingAfter: true, replaced: ['starting_after'] });
    expect(pagingPlan(tokenTool)).toMatchObject({ cursor: { arg: 'pageToken' }, size: { arg: 'pageSize' }, replaced: ['pageToken', 'pageSize'] });
    const s = v2InputSchema(pageTool, ['id', 'name']);
    expect(Object.keys(s.properties as object)).toEqual(['cursor', 'limit', 'fields']);
    expect((s.properties as Record<string, Record<string, unknown>>).limit).toMatchObject({ type: 'integer', default: 5 });
    expect(String((s.properties as Record<string, Record<string, unknown>>).fields!.description)).toContain('Default: id, name.');
  });

  it('prefixes nr_ on collisions with upstream arguments that mean something else; non-list tools only get fields', () => {
    expect(pagingPlan(collide).names).toEqual({ cursor: 'cursor', limit: 'nr_limit', fields: 'nr_fields' });
    expect(Object.keys(v2InputSchema(collide).properties as object).sort()).toEqual(['cursor', 'fields', 'limit', 'nr_fields', 'nr_limit']);
    expect(pagingPlan(getTool)).toMatchObject({ list: false, names: { cursor: null, limit: null, fields: 'fields' } });
    expect(Object.keys(v2InputSchema(getTool).properties as object)).toEqual(['note_id', 'fields']);
  });

  it('splits the contract-2 arguments out of a call and checks them', () => {
    expect(splitArgs(pagingPlan(pageTool), { limit: 10, cursor: 'c_x', fields: ['id'] })).toEqual({ upstream: { per_page: 10 }, cursor: 'c_x', fields: ['id'], issues: [] });
    expect(splitArgs(pagingPlan(collide), { limit: 3, nr_limit: 7, nr_fields: ['a'], fields: 'x' })).toMatchObject({ upstream: { limit: 3, per_page: 7, fields: 'x' }, fields: ['a'] });
    expect(splitArgs(pagingPlan(cursorTool), { cursor: 5, fields: ['a..b'] }).issues.map((i) => i.path)).toEqual(['/cursor', '/fields']);
  });
});

describe('next-page signals per upstream style', () => {
  const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => ({ id: `w_${from + i}` }));
  it('cursor token, page/per_page (+Link), offset/limit (+total), starting_after (+has_more), page tokens', () => {
    expect(nextSignals(pagingPlan(cursorTool), {}, { data: ids(5), next_cursor: '5' }, {}, 'https://api.test', 5)).toEqual({ more: true, next: { k: 'u', v: '5' }, total: null, first: true });
    expect(nextSignals(pagingPlan(cursorTool), { cursor: '15' }, { data: ids(5), next_cursor: null }, {}, 'https://api.test', 5)).toMatchObject({ more: false, next: null, first: false });
    expect(nextSignals(pagingPlan(pageTool), { page: 2 }, ids(5), {}, 'https://api.test', 5)).toMatchObject({ more: true, next: { k: 'p', n: 3 } });
    expect(nextSignals(pagingPlan(pageTool), { page: 4 }, ids(3), {}, 'https://api.test', 5)).toMatchObject({ more: false });
    expect(nextSignals(pagingPlan(pageTool), {}, ids(5), { link: '<https://api.test/gadgets?page=2&per_page=5>; rel="next", <https://api.test/gadgets?page=4>; rel="last"' }, 'https://api.test/v3', 5)).toMatchObject({ more: true, next: { k: 'l', q: { page: '2', per_page: '5' } } });
    expect(nextSignals(pagingPlan(offsetTool), { offset: 15 }, { items: ids(5), total: 20 }, {}, 'https://api.test', 5)).toMatchObject({ more: false, total: 20 });
    expect(nextSignals(pagingPlan(offsetTool), { offset: 5 }, { items: ids(5), total: 20 }, {}, 'https://api.test', 5)).toMatchObject({ more: true, next: { k: 'o', n: 10 } });
    expect(nextSignals(pagingPlan(stripeTool), {}, { object: 'list', data: ids(5), has_more: true, url: '/v1/charges' }, {}, 'https://api.test', 5)).toMatchObject({ more: true, next: { k: 'u', v: 'w_5' } });
    expect(nextSignals(pagingPlan(stripeTool), {}, { object: 'list', data: ids(5), has_more: false, url: '/v1/charges' }, {}, 'https://api.test', 5)).toMatchObject({ more: false });
    expect(nextSignals(pagingPlan(tokenTool), {}, { documents: ids(5), nextPageToken: 'abc' }, {}, 'https://api.test', 5)).toMatchObject({ more: true, next: { k: 'u', v: 'abc' } });
    expect(nextSignals(pagingPlan(cursorTool), {}, { data: [], next_cursor: 'x' }, {}, 'https://api.test', 5).more).toBe(false);
  });

  it('applies a position to the spec arguments; Link parameters without an argument become extra query parameters', () => {
    const a: Record<string, unknown> = { per_page: 5 };
    expect(applyPosition(pageTool, pagingPlan(pageTool), a, { k: 'l', q: { page: '3', per_page: '5', after: 'Y3' } })).toEqual({ extraQuery: { after: 'Y3' } });
    expect(a).toEqual({ page: 3, per_page: 5 });
    const b: Record<string, unknown> = {};
    applyPosition(stripeTool, pagingPlan(stripeTool), b, { k: 'u', v: 'w_5' });
    expect(b).toEqual({ starting_after: 'w_5' });
    expect(linkNext('<https://x/a?page=2>; rel="next"')).toBe('https://x/a?page=2');
    expect(linkQuery('https://other/a?page=2', 'https://x')).toBeNull();
    expect(linkQuery('?page=2&per_page=5', 'http://mock.invalid')).toEqual({ page: '2', per_page: '5' });
  });
});

describe('fields projection', () => {
  it('per item on lists (the wrapper keeps totals and cursors), dot paths through arrays on objects', () => {
    expect(projectFields({ total: 2, next_cursor: 'x', data: [{ id: 1, name: 'a', x: 1 }, { id: 2, name: 'b', x: 2 }] }, ['id'], true)).toEqual({ total: 2, next_cursor: 'x', data: [{ id: 1 }, { id: 2 }] });
    expect(projectFields([{ id: 1, c: { n: 'a', z: 1 } }], ['c.n'], true)).toEqual([{ c: { n: 'a' } }]);
    expect(projectFields({ id: 'o', items: [{ sku: 'a', q: 1 }], total: 3 }, ['id', 'items.sku'], false)).toEqual({ id: 'o', items: [{ sku: 'a' }] });
    expect(clippedFields(['body', 'items[3].body', 'items[4].body'])).toEqual(['body', 'items.body']);
  });
});
