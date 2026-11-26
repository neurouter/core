import { describe, expect, it } from 'vitest';
import { planTopics, topicOf, topicWeights } from './select.js';
import type { GenTool } from './types.js';

const t = (name: string, group: string, pinned = false): GenTool => ({ name, group, description: '', inputSchema: {}, write: false, ...(pinned ? { pinned } : {}) });
const tools = [
  ...Array.from({ length: 16 }, (_, i) => t(`issues_${i}`, 'issues')),
  ...Array.from({ length: 4 }, (_, i) => t(`topups_${i}`, 'topups')),
  ...Array.from({ length: 4 }, (_, i) => t(`codespaces_${i}`, 'codespaces', i === 0)),
  t('gitignore_get', 'gitignore'),
];

describe('topic balance', () => {
  it('weights clusters by √operations × pinned × common resources', () => {
    const w = topicWeights(tools);
    expect(w.get('issues')).toBeCloseTo(4 * 1.5);
    expect(w.get('codespaces')).toBeCloseTo(2 * 2);
    expect(w.get('topups')).toBeCloseTo(2);
    expect(w.get('gitignore')).toBeCloseTo(1);
  });

  it('plans one topic per task: distinct while topics last, capped after, deterministic', () => {
    const p = planTopics(tools, 4, 7);
    expect(new Set(p).size).toBe(4);
    expect(planTopics(tools, 4, 7)).toEqual(p);
    const many = planTopics(tools, 12, 3);
    const counts = new Map<string, number>();
    for (const x of many) counts.set(x, (counts.get(x) ?? 0) + 1);
    expect(Math.max(...counts.values())).toBeLessThanOrEqual(4);
    // over many seeds the heaviest cluster leads most often
    const first = Array.from({ length: 200 }, (_, s) => planTopics(tools, 1, s)[0]);
    expect(first.filter((x) => x === 'issues').length).toBeGreaterThan(first.filter((x) => x === 'gitignore').length * 3);
  });

  it('topicOf: the cluster of the first reference tool', () => {
    expect(topicOf({ referenceCalls: [{ tool: 'topups_1' }], assertions: [] }, tools)).toBe('topups');
    expect(topicOf({ referenceCalls: [], assertions: [{ type: 'called', tool: 'issues_2' }] }, tools)).toBe('issues');
  });
});
