import { describe, expect, it } from 'vitest';
import { mockDataVersionOf, mockScaleOf } from '@neurouter/compiler';
import { attemptNamespace } from './evals.service.js';

/** The data plane's `EVAL_NS_RE` (dataplane/mock/namespace.ts; the plane boundary keeps the import out). */
const EVAL_NS_RE = /^eval:([0-9a-f-]{36}):[A-Za-z0-9:_-]{1,150}$/;
const RUN = '0b6f7c1e-0000-4000-8000-000000000000';

describe('attemptNamespace (long-workflow mock scale)', () => {
  it('keeps unscaled names as before', () => {
    expect(attemptNamespace(RUN, 'task|gpt-6-luna|tool|1', 2, null)).toBe(`eval:${RUN}:task_gpt-6-luna_tool_1`);
    expect(attemptNamespace(RUN, 'task|m|code|2', 1, null)).toBe(`eval:${RUN}:dv1:task_m_code_2`);
  });

  it('carries the task scale, stays within the accepted namespace pattern and keeps long keys apart', () => {
    const scale = { items: 200, resources: { review: [0, 2] as [number, number], issue: 150 } };
    const long = `${'github_lw_stale_open_prs_without_review_n200'.repeat(3)}|gpt-6-luna|tool|`;
    const a = attemptNamespace(RUN, `${long}1`, 1, scale);
    const b = attemptNamespace(RUN, `${long}2`, 1, scale);
    for (const ns of [a, b]) {
      expect(EVAL_NS_RE.test(ns)).toBe(true);
      expect(mockScaleOf(ns)).toEqual(scale);
      expect(mockDataVersionOf(ns)).toBe(1);
    }
    expect(a).not.toBe(b);
  });
});
