import { describe, expect, it } from 'vitest';
import { computeGroundTruth, groundTruthForCalls, outcomeFromResult, parseGroundTruthPath, resolveArgs, resolvePath, resultValue, unwrapV1, type GroundTruth, type RefSession } from './groundtruth.js';

const gt: GroundTruth = { refs: [{ tool: 'list', ok: true, data: { data: [{ id: 'a', n: 1 }, { id: 'b', n: 2 }], 'odd key': 'x' } }, { tool: 'get', ok: true, data: { id: 'a' } }] };

describe('ground truth', () => {
  it('parses and resolves paths (index, wildcard, quoted keys)', () => {
    expect(parseGroundTruthPath('ref[0].data.data[*].id')!.segs).toEqual([{ key: 'data' }, { key: 'data' }, { all: true }, { key: 'id' }]);
    expect(resolvePath(gt, 'ref[0].data.data[*].id')).toEqual(['a', 'b']);
    expect(resolvePath(gt, 'ref[0].data.data[1].n')).toEqual([2]);
    expect(resolvePath(gt, 'ref[0].data["odd key"]')).toEqual(['x']);
    expect(resolvePath(gt, 'ref[5].data')).toEqual([]);
    expect(resolveArgs({ id: { $from: 'ref[0].data.data[1].id' }, k: 1 }, gt)).toEqual({ id: 'b', k: 1 });
  });

  it('reads contract-1 bodies and contract-2 envelopes the same way', () => {
    const v1 = outcomeFromResult('t', { content: [{ type: 'text', text: JSON.stringify({ items: [{ login: 'x' }] }) }] });
    const v2 = outcomeFromResult('t', { content: [{ type: 'text', text: JSON.stringify({ ok: true, data: [{ login: 'x' }], page: null, truncated: null, error: null, state: {} }) }] });
    expect(v1).toEqual(v2);
    expect(v1.data).toEqual([{ login: 'x' }]);
    const err = outcomeFromResult('t', { isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, data: null, error: { code: 'not_found', message: 'No such pet' }, state: {} }) }] });
    expect(err).toMatchObject({ ok: false, error: 'No such pet' });
    expect(resultValue('{"ok":true,"data":{"a":1},"state":{}}')).toEqual({ a: 1 });
    expect(unwrapV1({ items: [1], total: 2 })).toEqual({ items: [1], total: 2 });
  });

  it('executes references in order with $from chaining, then alternatives', async () => {
    const seen: Array<[string, unknown]> = [];
    const session: RefSession = { call: async (tool, args) => (seen.push([tool, args]), { tool, ok: true, data: tool === 'list' ? { data: [{ id: 'r9' }] } : { id: args.id, by: tool } }) };
    const out = await computeGroundTruth(
      [
        { tool: 'list', arguments: {} },
        { tool: 'get', arguments: { id: { $from: 'ref[0].data.data[0].id' } }, alternatives: [{ tool: 'get_alt' }] },
      ],
      async () => session,
    );
    expect(seen).toEqual([['list', {}], ['get', { id: 'r9' }], ['get_alt', { id: 'r9' }]]);
    // an agent that used the equivalent tool is checked against that tool's outcome
    const view = groundTruthForCalls(out, [{ tool: 'list', arguments: {} }, { tool: 'get', arguments: {}, alternatives: [{ tool: 'get_alt' }] }], [{ tool: 'get_alt', status: 'ok' }]);
    expect(resolvePath(view, 'ref[1].data.by')).toEqual(['get_alt']);
  });
});
