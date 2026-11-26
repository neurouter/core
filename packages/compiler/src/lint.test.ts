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

  it('examples_present scales to 30%', () => {
    const noEx = Array.from({ length: 10 }, () => tool({ examples: [] }));
    expect(rule(lint(noEx), 'examples_present').score).toBe(0);
    noEx[0] = tool();
    expect(rule(lint(noEx), 'examples_present').score).toBeCloseTo(1 / 3, 5);
  });

  it('writes_marked: DELETE must be destructive', () => {
    const del = tool({ binding: { type: 'http', method: 'DELETE', pathTemplate: '/x', params: [], successStatuses: [204], responseContentType: null, security: [] }, risk: { readOnly: false, destructive: false, idempotent: true, openWorld: true, write: true } });
    expect(rule(lint([del]), 'writes_marked').score).toBe(0);
  });

  it('ignores hidden tools', () => {
    expect(lint([tool(), tool({ hidden: true, description: 'x' })]).score).toBe(100);
  });
});
