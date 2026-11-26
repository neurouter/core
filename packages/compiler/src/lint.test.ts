import { describe, expect, it } from 'vitest';
import type { ToolDef } from '@neurouter/shared';
import { finalize } from './compile.js';
import { lint, LINT_WEIGHTS } from './lint.js';

function tool(over: Partial<ToolDef> = {}): ToolDef {
  return finalize(
    {
      name: 'list_items',
      pyName: '',
      title: 'List items',
      description: 'List the items in the inventory, newest first, with their state.',
      kind: 'http',
      inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'Search text' } } },
      outputSchema: { type: 'object', properties: { id: { type: 'integer' } } },
      binding: { type: 'http', method: 'GET', pathTemplate: '/items', params: [], successStatuses: [200], responseContentType: 'application/json', security: [] },
      risk: { readOnly: true, destructive: false, idempotent: true, openWorld: true, write: false },
      tags: [],
      hidden: false,
      pinned: false,
      deprecated: false,
      examples: [{ arguments: { q: 'x' } }],
      pySignature: '',
      sourceRef: { pointer: '/' },
      overlayApplied: [],
      key: 'k',
      defHash: '',
      ...over,
    },
    'ns',
  );
}

const rule = (r: ReturnType<typeof lint>, name: string) => r.rules.find((x) => x.rule === name)!;

describe('lint', () => {
  it('scores a clean toolset 100 and weights sum to 100', () => {
    const r = lint([tool()]);
    expect(r.score).toBe(100);
    expect(r.findings).toEqual([]);
    expect(Object.values(LINT_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it('description_present / description_actionable', () => {
    expect(rule(lint([tool({ description: 'GET /items' })]), 'description_present').score).toBe(0);
    expect(rule(lint([tool({ description: 'Short.' })]), 'description_present').score).toBe(0);
    expect(rule(lint([tool({ description: 'The items of the inventory are returned by this endpoint.' })]), 'description_actionable').score).toBe(0);
    expect(rule(lint([tool({ description: 'Returns <b>items</b> of the inventory for the account.' })]), 'description_actionable').passed).toBe(false);
  });

  it('params_described / params_typed / schema_depth', () => {
    const undescribed = tool({ inputSchema: { type: 'object', properties: { a: { type: 'string' }, b: { type: 'string', description: 'B' } } } });
    expect(rule(lint([undescribed]), 'params_described').score).toBe(0);
    expect(rule(lint([tool({ inputSchema: { type: 'object', properties: { a: { description: 'A' } } } })]), 'params_typed').score).toBe(0);
    const deep = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'object', properties: { d: { type: 'object', properties: { e: { type: 'string' } } } } } } } } } } };
    expect(rule(lint([tool({ inputSchema: deep })]), 'schema_depth').score).toBe(0);
  });

  it('names_clear', () => {
    for (const name of ['items_list', 'get_items_2', 'get_by_by_id', 'x'.repeat(41)]) expect(rule(lint([tool({ name })]), 'names_clear').score, name).toBe(0);
  });

  it('toolset_size: ≤ 40, search with pins, > 200', () => {
    const many = (n: number, pinned = false) => Array.from({ length: n }, (_, i) => tool({ name: `get_item_n${i}`.replace(/\d+$/, (d) => 'abcdefghij'.split('').map((c, k) => (d.includes(String(k)) ? c : '')).join('') + 'x'), pinned: pinned && i === 0 }));
    expect(rule(lint(many(40)), 'toolset_size').score).toBe(1);
    expect(rule(lint(many(41)), 'toolset_size').score).toBe(0);
    expect(rule(lint(many(41, true)), 'toolset_size').score).toBe(1);
    expect(rule(lint(many(41, true), { discovery: 'full' }), 'toolset_size').score).toBe(0);
    expect(rule(lint(many(201, true)), 'toolset_size').score).toBe(0);
    expect(lint(many(41)).findings.find((f) => f.rule === 'toolset_size')?.fix).toEqual([{ op: 'set_default', field: 'hidden', value: true }]);
  });

  it('output_shaped: large lists need shaping', () => {
    const props = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`f${i}`, { type: 'string' }]));
    const big = { type: 'object', 'x-neurouter-wrapped': 'items', properties: { items: { type: 'array', items: { type: 'object', properties: props } } } };
    expect(rule(lint([tool({ outputSchema: big })]), 'output_shaped').score).toBe(0);
    expect(rule(lint([tool({ outputSchema: big, shaping: { maxItems: 10 } })]), 'output_shaped').score).toBe(1);
  });

  it('example_runs: checked examples must validate and run; without checks an example must exist', () => {
    expect(rule(lint([tool({ examples: [] })]), 'example_runs').score).toBe(0);
    expect(rule(lint([tool()]), 'example_runs').score).toBe(1);
    const t = tool();
    const ok = new Map([[t.name, { arguments: { q: 'x' }, source: 'overlay' as const, runs: true, conforms: true }]]);
    expect(rule(lint([t], { examples: ok }), 'example_runs').score).toBe(1);
    const bad = new Map([[t.name, { arguments: { q: 1 }, source: 'overlay' as const, runs: false, conforms: null, problem: 'does not match the input schema: /q must be string' }]]);
    const r = lint([t], { examples: bad });
    expect(rule(r, 'example_runs').score).toBe(0);
    expect(r.findings.find((f) => f.rule === 'example_runs')?.message).toContain('/q must be string');
    expect(rule(lint([t], { examples: new Map() }), 'example_runs').score).toBe(0);
  });

  it('envelope_conformance: an example response that does not match the output schema fails', () => {
    const t = tool();
    const ex = new Map([[t.name, { arguments: {}, source: 'synthesized' as const, runs: true, conforms: false, problem: 'the response does not match the output schema: /id must be integer' }]]);
    expect(rule(lint([t], { examples: ex }), 'envelope_conformance').score).toBe(0);
  });

  it('destructive_marked: verb/DELETE writes are destructive and the first sentence names what is destroyed', () => {
    const write = { readOnly: false, destructive: false, idempotent: false, openWorld: true, write: true };
    const post = (path: string) => ({ type: 'http' as const, method: 'POST' as const, pathTemplate: path, params: [], successStatuses: [200], responseContentType: null, security: [] });
    expect(rule(lint([tool({ name: 'cancel_item', description: 'Cancels the item in the inventory before it ships.', binding: post('/items/{id}/cancel'), risk: write })]), 'destructive_marked').score).toBe(0);
    const marked = { ...write, destructive: true };
    expect(rule(lint([tool({ name: 'cancel_item', description: 'Cancels the item in the inventory before it ships.', binding: post('/items/{id}/cancel'), risk: marked })]), 'destructive_marked').score).toBe(1);
    expect(rule(lint([tool({ name: 'purge_item', description: 'Purges the item.', binding: post('/items/{id}/purge'), risk: marked })]), 'destructive_marked').score).toBe(1);
    expect(rule(lint([tool({ name: 'archive_item', description: 'Moves an item to the attic.', binding: post('/items/{id}/archive'), risk: marked })]), 'destructive_marked').score).toBe(0);
    expect(rule(lint([tool({ name: 'archive_item', description: 'Moves an item to the attic. This cannot be undone.', binding: post('/items/{id}/archive'), risk: marked })]), 'destructive_marked').score).toBe(1);
  });

  it('has_more_without_cursor: a page size without a position parameter fails', () => {
    const q = (...names: string[]) => names.map((n) => ({ arg: n, in: 'query' as const, name: n, required: false }));
    const list = (params: ReturnType<typeof q>, pagination?: { style: 'link' }) => tool({ binding: { type: 'http', method: 'GET', pathTemplate: '/items', params, successStatuses: [200], responseContentType: 'application/json', security: [], ...(pagination ? { pagination } : {}) } });
    expect(rule(lint([list(q('limit'))]), 'has_more_without_cursor').score).toBe(0);
    expect(rule(lint([list(q('limit', 'cursor'))]), 'has_more_without_cursor').score).toBe(1);
    expect(rule(lint([list(q('per_page', 'page'))]), 'has_more_without_cursor').score).toBe(1);
    expect(rule(lint([list(q('per_page'), { style: 'link' })]), 'has_more_without_cursor').score).toBe(1);
    expect(rule(lint([list(q('q'))]), 'has_more_without_cursor').score).toBe(1);
  });

  it('first_sentence: verb first, 10–200 chars; a leading summary paragraph is skipped', () => {
    expect(rule(lint([tool({ description: 'The items.' })]), 'first_sentence').score).toBe(0);
    expect(rule(lint([tool({ description: `List ${'very '.repeat(50)}many items.` })]), 'first_sentence').score).toBe(0);
    expect(rule(lint([tool({ description: 'List items\n\nReturns the items of the inventory, newest first.' })]), 'first_sentence').score).toBe(1);
  });

  it('description_length: the agent description stays within the limit', () => {
    const long = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`argument_number_${i}`, { type: 'string', description: 'x' }]));
    expect(rule(lint([tool({ description: `List items. ${'More detail on how listing works here. '.repeat(30)}`, inputSchema: { type: 'object', properties: long } })]), 'description_length').score).toBe(1);
    const huge = { q: 'x'.repeat(900) };
    expect(rule(lint([tool({ examples: [{ arguments: huge }] })], { examples: new Map([['list_items', { arguments: huge, source: 'overlay' as const, runs: true, conforms: true }]]) }), 'description_length').score).toBe(0);
  });

  it('enum_in_schema: allowed values only in prose fail; repeated ones are info', () => {
    const r = lint([tool({ inputSchema: { type: 'object', properties: { state: { type: 'string', description: 'open, closed or all' } } } })]);
    expect(rule(r, 'enum_in_schema').score).toBe(0);
    expect(r.findings.find((f) => f.rule === 'enum_in_schema')?.fix).toEqual([{ op: 'set', selector: 'k', field: 'args', value: { enum: { state: ['open', 'closed', 'all'] } } }]);
    const dup = lint([tool({ inputSchema: { type: 'object', properties: { state: { type: 'string', enum: ['open', 'closed'], description: 'One of `open` or `closed`.' } } } })]);
    expect(rule(dup, 'enum_in_schema').score).toBe(1);
    expect(dup.findings.find((f) => f.rule === 'enum_in_schema')?.severity).toBe('info');
    // booleans and values of another argument's enum are not prose enums
    expect(rule(lint([tool({ inputSchema: { type: 'object', properties: { flag: { type: 'boolean', description: 'true or false' }, body: { type: 'string', description: 'Required when event is `APPROVE` or `COMMENT`.' }, event: { type: 'string', enum: ['APPROVE', 'COMMENT'] } } } })]), 'enum_in_schema').score).toBe(1);
  });

  it('writes_marked: DELETE must be destructive', () => {
    const del = tool({ binding: { type: 'http', method: 'DELETE', pathTemplate: '/x', params: [], successStatuses: [204], responseContentType: null, security: [] }, risk: { readOnly: false, destructive: false, idempotent: true, openWorld: true, write: true } });
    expect(rule(lint([del]), 'writes_marked').score).toBe(0);
  });

  it('ignores hidden tools', () => {
    expect(lint([tool(), tool({ hidden: true, description: 'x' })]).score).toBe(100);
  });
});
