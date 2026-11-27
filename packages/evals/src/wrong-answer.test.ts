import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Assertion } from '@neurouter/shared';
import { checkAttempt } from './check.js';
import type { GroundTruth, RefOutcome } from './groundtruth.js';
import { suggest, type SuggestTool } from './suggest.js';
import type { LlmClient } from './llm/types.js';
import { call, record, result, task } from './test/fixtures.js';
import type { AgentCall, EndReason, EvalTask, ObservedCall } from './types.js';

/**
 * 0.3.4, B2: the long-workflow probe on 0.3.3, Stripe tool mode at 100 and 200 charges. The agent paged through every
 * charge correctly, every call ok, and answered with a complete table whose sums were wrong (AUD, and AUD + JPY): a
 * wrong answer. It was classified `gave_up`, and the LLM suggestion step then invented a paging diagnosis
 * ("requested the first page with limit: 100") and proposed a `describe get_charges` fix (+45 pts predicted).
 */
interface Probe {
  size: number;
  task: Pick<EvalTask, 'key' | 'category' | 'prompt' | 'referenceCalls'> & { assertions: Assertion[] };
  endReason: EndReason;
  finalAnswer: string;
  toolCallsByAgent: number;
  calls: ObservedCall[];
  agentCalls: AgentCall[];
  groundTruthRefs: RefOutcome[];
  recorded: { failureCause: string; assertionResults: Array<{ passed: boolean; detail: string }> };
}
const PROBE = (JSON.parse(readFileSync(resolve(import.meta.dirname, 'test/lw033-stripe-tool.json'), 'utf8')) as { attempts: Probe[] }).attempts;

const grade = (p: Probe, over: Partial<Parameters<typeof record>[0]> = {}) =>
  checkAttempt(task({ ...p.task, rubric: '' }), record({ finalAnswer: p.finalAnswer, endReason: p.endReason, calls: p.calls, agentCalls: p.agentCalls, toolCallsByAgent: p.toolCallsByAgent, ...over }), { groundTruth: { refs: p.groundTruthRefs } as GroundTruth });

describe('B2: a finished attempt with a wrong answer is wrong_answer, not gave_up', () => {
  it.each(PROBE.map((p) => [p.size, p] as const))('stripe n%i tool (0.3.3 probe): wrong sums → wrong_answer', async (_n, p) => {
    expect(p.recorded.failureCause).toBe('gave_up');
    const r = await grade(p);
    expect(r.passed).toBe(false);
    // the same verdict as recorded: the amounts miss the ground truth (exact values)
    expect(r.results.map((x) => x.passed)).toEqual(p.recorded.assertionResults.map((x) => x.passed));
    expect(r.failureCause).toBe('wrong_answer');
  });

  it('still gave_up when the agent stopped without an answer, or declined', async () => {
    const p = PROBE[0]!;
    expect((await grade(p, { finalAnswer: '' })).failureCause).toBe('gave_up');
    expect((await grade(p, { finalAnswer: "I couldn't page through all charges, so I can't give the totals." })).failureCause).toBe('gave_up');
  });

  it('not wrong_answer when an action check failed too (the earlier causes keep their order)', async () => {
    const t = task({ assertions: [{ type: 'called', tool: 'get_pet_by_id', args: { petId: 1 } }, { type: 'answer_contains', anyOf: ['Rex'] }] });
    expect((await checkAttempt(t, record({ finalAnswer: 'It is Max.', calls: [call('get_pet_by_id', { petId: 9 })] }))).failureCause).toBe('bad_arguments');
    // a literal answer check (no ground truth) that fails on a finished answer is wrong_answer too
    expect((await checkAttempt(t, record({ finalAnswer: 'It is Max.', calls: [call('get_pet_by_id', { petId: 1 })] }))).failureCause).toBe('wrong_answer');
    // an answer_matches miss as well
    const m = task({ assertions: [{ type: 'answer_matches', regex: 'largest[^.]*\\bAUD\\b' }] });
    expect((await checkAttempt(m, record({ finalAnswer: 'USD has the largest failed total.' }))).failureCause).toBe('wrong_answer');
  });

  it('suggestions: wrong_answer gets no description fix and no LLM call', async () => {
    const p = PROBE[0]!;
    const r = await grade(p);
    let llmCalls = 0;
    const llm = { provider: 'scripted', create: async () => { llmCalls++; throw new Error('not expected'); } } as unknown as LlmClient;
    const tools: SuggestTool[] = [{ name: 'get_charges', key: 'operationId:GetCharges', description: 'List charges.', inputSchema: { type: 'object' }, hidden: false, tags: [], write: false }];
    const out = await suggest({
      results: [result({ taskKey: p.task.key, passed: false, failureCause: r.failureCause, primaryTool: 'get_charges', calls: p.calls, assertionResults: r.results })],
      tasks: [task({ ...p.task, rubric: '' })],
      tools,
      llm,
      model: 'm',
      validatePatch: async () => ({ ok: true, diagnostics: [] }),
    });
    expect(out).toEqual([]);
    expect(llmCalls).toBe(0);
  });
});
