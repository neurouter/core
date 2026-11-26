import { describe, expect, it } from 'vitest';
import { bindAnswerLiterals, bindDerivedArgs, calibrateSuite, calibrateTask, findLiteralPaths, renderCalibration } from './calibrate.js';
import type { GroundTruth } from './groundtruth.js';
import { equivalentTools, isJudgmentTask, migrateSuite, suiteDataVersion, upgradeTask } from './migrate.js';
import { task } from './test/fixtures.js';
import type { SuiteFile } from './types.js';

const listGt: GroundTruth = {
  refs: [
    { tool: 'list_refunds', ok: true, data: { object: 'list', data: [{ id: 'refund_1', amount: 17, currency: 'usd' }, { id: 'refund_2', amount: 76, currency: 'usd' }] } },
    { tool: 'get_refund', ok: true, data: { id: 'refund_1', amount: 17, status: 'succeeded', valid: false, livemode: false } },
  ],
};

describe('binding literals to the ground truth', () => {
  it('ranks paths by fields the prompt mentions, then by depth', () => {
    expect(findLiteralPaths(listGt, 'false', { hint: 'tell me whether it is valid' })[0]).toEqual({ ref: 1, segs: ['data', 'valid'] });
    expect(findLiteralPaths(listGt, 'refund_1')[0]).toEqual({ ref: 1, segs: ['data', 'id'] });
  });

  it('single literals become paths; sibling list items become one wildcard (match all); unknown literals stay', () => {
    const b = bindAnswerLiterals(
      [
        { type: 'answer_contains', anyOf: ['refund_1'] },
        { type: 'answer_contains', anyOf: ['76'] },
        { type: 'answer_contains', anyOf: ['nope'] },
      ],
      { refs: [listGt.refs[0]!] },
    );
    expect(b.assertions).toEqual([
      { type: 'answer_contains', from: 'ref[0].data.data[0].id', anyOf: ['refund_1'] },
      { type: 'answer_contains', from: 'ref[0].data.data[1].amount', anyOf: ['76'] },
      { type: 'answer_contains', anyOf: ['nope'] },
    ]);
    const all = bindAnswerLiterals([{ type: 'answer_contains', anyOf: ['refund_1'] }, { type: 'answer_contains', anyOf: ['refund_2'] }], { refs: [listGt.refs[0]!] });
    expect(all.assertions).toEqual([{ type: 'answer_contains', from: 'ref[0].data.data[*].id', match: 'all', anyOf: ['refund_1', 'refund_2'] }]);
  });

  it('later reference arguments taken from earlier results become $from', () => {
    const t = task({ referenceCalls: [{ tool: 'list_refunds', arguments: {} }, { tool: 'get_refund', arguments: { refund: 'refund_1' } }] });
    const b = bindDerivedArgs(t, listGt);
    expect(b.refs[1]!.arguments).toEqual({ refund: { $from: 'ref[0].data.data[0].id' } });
  });
});

describe('calibration gate', () => {
  const good = task({
    key: 'good',
    category: 'multi',
    referenceCalls: [{ tool: 'list_refunds', arguments: {} }, { tool: 'get_refund', arguments: { refund: { $from: 'ref[0].data.data[0].id' } } }],
    assertions: [{ type: 'called', tool: 'get_refund', args: { refund: { $from: 'ref[0].data.data[0].id' } } }, { type: 'answer_contains', from: 'ref[1].data.status' }, { type: 'max_calls', n: 6 }, { type: 'judge', criterion: 'x' }, { type: 'framing' }],
  });

  it('passes a task whose reference solution passes its own assertions (judge not run)', async () => {
    expect(await calibrateTask(good, listGt)).toMatchObject({ key: 'good', status: 'passed', reasons: [] });
  });

  it('rejects failing references, unresolvable paths, literals absent from the outcome, own-assertion failures', async () => {
    const failing: GroundTruth = { refs: [{ tool: 'list_refunds', ok: false, data: null, error: 'boom' }, listGt.refs[1]!] };
    const r1 = await calibrateTask(good, failing);
    expect(r1.status).toBe('rejected');
    expect(r1.reasons.join(' ')).toContain('reference call 1 (list_refunds) failed: boom');
    const r2 = await calibrateTask(task({ category: 'single', referenceCalls: [{ tool: 'get_refund', arguments: {} }], assertions: [{ type: 'answer_contains', from: 'ref[0].data.nothing' }, { type: 'answer_contains', anyOf: ['Hello-World'] }] }), { refs: [listGt.refs[1]!] });
    expect(r2.reasons).toEqual(['expected value ref[0].data.nothing resolves to nothing in the reference outcome', 'expected answer value ["Hello-World"] is not in the reference outcome', expect.stringContaining('fails its own answer_contains')]);
    const r3 = await calibrateTask(task({ category: 'single', referenceCalls: [{ tool: 'get_refund', arguments: { refund: 'refund_1' } }], assertions: [{ type: 'called', tool: 'get_refund', args: { refund: 'refund_9' } }] }), { refs: [listGt.refs[1]!] });
    expect(r3.reasons[0]).toContain('fails its own called assertion');
  });

  it('calibrateSuite summarizes; impossible and clarify tasks pass on their reference behaviour', async () => {
    const imp = task({ key: 'imp', category: 'impossible', assertions: [{ type: 'unmet_need_reported_or_declined' }, { type: 'no_writes' }] });
    const amb = task({ key: 'amb', category: 'ambiguous', assertions: [{ type: 'max_calls', n: 0, hard: true }, { type: 'judge', criterion: 'asks' }] });
    const cal = await calibrateSuite([good, imp, amb], async (t) => (t.key === 'good' ? listGt : { refs: [] }), { mockDataVersion: 1, now: () => new Date(0) });
    expect(cal).toMatchObject({ passed: 3, rejected: 0, mockDataVersion: 1, at: '1970-01-01T00:00:00.000Z' });
    expect(renderCalibration(cal)).toContain('3 passed');
  });
});

describe('task upgrade and suite migration', () => {
  const tools = [
    { name: 'agents_get_repo_public_key', method: 'GET', path: '/repos/{owner}/{repo}/agents/secrets/public-key' },
    { name: 'actions_get_repo_public_key', method: 'GET', path: '/repos/{owner}/{repo}/actions/secrets/public-key' },
    { name: 'orgs_get_public_key', method: 'GET', path: '/orgs/{org}/actions/secrets/public-key' },
    { name: 'list_refunds', method: 'GET', path: '/refunds', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
  ];

  it('finds equivalent tools (same GET path tail and params)', () => {
    expect(equivalentTools('agents_get_repo_public_key', tools).map((t) => t.name)).toEqual(['actions_get_repo_public_key']);
  });

  it('keeps required args only, derives soft budgets, makes judgment tasks choice-judged', () => {
    const up = upgradeTask(
      task({
        category: 'single',
        prompt: 'List refunds',
        referenceCalls: [{ tool: 'list_refunds', arguments: { limit: 10, status: 'open' } }],
        assertions: [{ type: 'called', tool: 'list_refunds', args: { limit: 10, status: 'open' } }, { type: 'max_calls', n: 1 }],
      }),
      { tools },
    );
    expect(up.task.assertions).toEqual([{ type: 'called', tool: 'list_refunds', args: { status: 'open' }, incidental: { limit: 10 } }, { type: 'max_calls', n: 4 }]);
    expect(up.task.referenceCalls[0]!.required).toEqual(['status']);
    const judgment = task({ category: 'ambiguous', prompt: 'Show me the high-value top-ups. Use your best judgment for the cutoff and tell me what you chose.', referenceCalls: [{ tool: 'list_refunds', arguments: { amount: { gte: 50 } } }], assertions: [{ type: 'called', tool: 'list_refunds', args: { amount: { gte: 50 } } }, { type: 'answer_contains', anyOf: ['50'] }] });
    expect(isJudgmentTask(judgment)).toBe(true);
    const j = upgradeTask(judgment, { tools }).task.assertions;
    expect(j[0]).toEqual({ type: 'called', tool: 'list_refunds', incidental: { amount: { gte: 50 } } });
    expect(j.some((a) => a.type === 'answer_contains')).toBe(false);
    expect(j).toContainEqual(expect.objectContaining({ type: 'judge', kind: 'choice' }));
    // n: 0 ("do not call the API") stays strict
    expect(upgradeTask(task({ category: 'ambiguous', assertions: [{ type: 'max_calls', n: 0 }] })).task.assertions).toEqual([{ type: 'max_calls', n: 0, hard: true }]);
  });

  it('migrateSuite: version 2, mock data version 1, notes per task', async () => {
    const file: SuiteFile = { version: 1, server: 's', generatedFrom: null, tasks: [task({ key: 'k', category: 'single', referenceCalls: [{ tool: 'get_refund', arguments: {} }], assertions: [{ type: 'answer_contains', anyOf: ['succeeded'] }] })] };
    expect(suiteDataVersion(file)).toBe(1);
    const out = await migrateSuite(file, { groundTruthOf: async () => ({ refs: [listGt.refs[1]!] }), now: () => new Date(0) });
    expect(out).toMatchObject({ version: 2, mockDataVersion: 1 });
    expect(out.tasks[0]!.assertions[0]).toEqual({ type: 'answer_contains', from: 'ref[0].data.status', anyOf: ['succeeded'] });
    expect(out.migration!.notes.k!.join(' ')).toContain('ref[0].data.status');
    expect(suiteDataVersion(out)).toBe(1);
    expect(suiteDataVersion({ version: 2 })).toBe(2);
  });
});
