/**
 * Long-workflow tasks: a task's `seedState.mockScale` sizes the mock collections its attempts and its
 * ground truth run on (`MockScale` in @neurouter/compiler: items per collection, per-resource counts or
 * ranges). Tasks without it run on the default mock (20 items per collection). A reference call to
 * `run_script` computes ground truth that needs a loop over a variable number of items (every page,
 * every item's sub-resource): the reference session then opens with code-mode exposure.
 */
import { normalizeMockScale, type MockScale } from '@neurouter/compiler';
import { RUN_SCRIPT } from '@neurouter/shared';
import type { EvalTask } from './types.js';

/** The task's mock scale (`seedState.mockScale`), normalized; `null` = the default mock. Throws when malformed. */
export function taskMockScale(task: Pick<EvalTask, 'seedState'>): MockScale | null {
  const s = task.seedState;
  return s && typeof s === 'object' && 'mockScale' in s ? normalizeMockScale(s.mockScale) : null;
}

/** Whether the task's reference solution runs a script (its reference session needs code-mode exposure). */
export function hasScriptReference(task: Pick<EvalTask, 'referenceCalls'>): boolean {
  return task.referenceCalls.some((r) => r.tool === RUN_SCRIPT);
}
