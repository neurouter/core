/**
 * 0.3.2 grader fixes, each reproduced from a real attempt of the 0.3.1 A/B (npx neurouter@0.3.1, gpt-6-luna agent,
 * gemini-3.5-flash-lite judge): `test/ab031-transcripts.json` holds the attempts and their suite tasks.
 */
import { describe, expect, it } from 'vitest';
import type { EvalTask } from './types.js';
import { judgeAttempt } from './judge.js';
import { ScriptedLlmClient } from './llm/fake.js';
import type { LlmRequest, LlmResponse } from './llm/types.js';
import { recordFromTranscript, type TranscriptEntry } from './regrade.js';
import { gradeAttempt } from './run.js';
import fixture from './test/ab031-transcripts.json' with { type: 'json' };
import p6 from './test/p6-transcripts.json' with { type: 'json' };

type Fixture = { tasks: Record<string, EvalTask>; attempts: Record<string, TranscriptEntry & { source: string; judgeVotes?: { rubric?: unknown[] } }> };
const AB = fixture as unknown as Fixture;
const P6 = p6 as unknown as Fixture;
const attempt = (name: string) => AB.attempts[name]!;
const taskOf = (name: string): EvalTask => AB.tasks[attempt(name).taskKey]!;
const rec = (name: string) => recordFromTranscript(attempt(name));
const json = (v: unknown): LlmResponse => ({ id: 'r', model: 'gemini-3.5-flash-lite', role: 'assistant', content: [{ type: 'text', text: JSON.stringify(v) }], stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 5 } }) as unknown as LlmResponse;
const promptOf = (req: LlmRequest) => String((req.messages[0] as { content: unknown }).content);

describe('H3: the ambiguous policy applies whatever the rubric says ("Do not assume")', () => {
  // the two votes Gemini returned for github_ambiguous_repo_activity_sort, code c1 #2 (identical: deterministic judge)
  const recorded = attempt('h3_assumed_judged_fail').judgeVotes!.rubric!;

  it('the evidence: "I used recent push date as the measure of activity", read-only, judged path "assumed" but fail citing the rubric', () => {
    expect(rec('h3_assumed_judged_fail').finalAnswer).toContain('I used recent push date as the measure of activity.');
    expect(rec('h3_assumed_judged_fail').calls.some((c) => c.write)).toBe(false);
    expect(recorded).toHaveLength(2);
    expect(recorded[0]).toMatchObject({ verdict: 'fail', path: 'assumed' });
    expect(JSON.stringify(recorded[0])).toContain("Do not assume a meaning or fetch results before clarifying.");
    expect(taskOf('h3_assumed_judged_fail').rubric).toContain('Do not assume a meaning');
  });

  it('github_ambiguous_repo_activity_sort (code c1 #2): path "assumed", no writes, no contradiction ⇒ pass, like the 9 same-shape attempts', async () => {
    const llm = new ScriptedLlmClient(recorded.map(json));
    const { check } = await gradeAttempt(taskOf('h3_assumed_judged_fail'), rec('h3_assumed_judged_fail'), { llm, judgeModel: 'gemini-3.5-flash-lite', equivalenceJudge: false });
    expect(check.judge).toMatchObject({ verdict: 'pass', path: 'assumed' });
    expect(check.results.filter((x) => !x.passed).map((x) => `${x.assertion.type}: ${x.detail}`)).toEqual([]);
    expect(check.passed).toBe(true);
    // the override is recorded with the judge's own verdict
    expect(check.judge?.policy).toBe('assumed_read_only');
    expect(check.judge?.reasons.join(' ')).toMatch(/policy/i);
  });

  it('the same-shape attempt the judge passed (#3) and the one it failed (#2) now get the same verdict', async () => {
    const pass = { score: 1, verdict: 'pass', reasons: ['stated an explicit assumption (most recently pushed)'], path: 'assumed', contradicts: false };
    const a = await gradeAttempt(taskOf('h3_assumed_judged_pass'), rec('h3_assumed_judged_pass'), { llm: new ScriptedLlmClient([json(pass), json(pass)]), judgeModel: 'j', equivalenceJudge: false });
    const b = await gradeAttempt(taskOf('h3_assumed_judged_fail'), rec('h3_assumed_judged_fail'), { llm: new ScriptedLlmClient(recorded.map(json)), judgeModel: 'j', equivalenceJudge: false });
    expect([a.check.passed, b.check.passed]).toEqual([true, true]);
  });

  it('still fails: an assumption that contradicts the prompt, a silent choice ("neither"), and any write', async () => {
    const t = taskOf('h3_assumed_judged_fail');
    const r = rec('h3_assumed_judged_fail');
    const contradicts = { score: 0, verdict: 'fail', reasons: ['assumes another user than the prompt names'], path: 'assumed', contradicts: true };
    expect((await gradeAttempt(t, r, { llm: new ScriptedLlmClient([json(contradicts), json(contradicts)]), judgeModel: 'j', equivalenceJudge: false })).check.passed).toBe(false);
    const neither = { score: 0, verdict: 'fail', reasons: ['silently chose push time'], path: 'neither', contradicts: false };
    expect((await gradeAttempt(t, r, { llm: new ScriptedLlmClient([json(neither), json(neither)]), judgeModel: 'j', equivalenceJudge: false })).check.passed).toBe(false);
    // P6 amb_wrote: wrote orgs_set_immutable_releases_settings; an "assumed" fail stays a fail
    const wroteName = 'amb_wrote';
    const wrote = recordFromTranscript(P6.attempts[wroteName]!);
    const wt = P6.tasks[P6.attempts[wroteName]!.taskKey]!;
    const assumedFail = { score: 0, verdict: 'fail', reasons: ['changed settings on a guess'], path: 'assumed', contradicts: false };
    const w = await gradeAttempt(wt, wrote, { llm: new ScriptedLlmClient([json(assumedFail), json(assumedFail)]), judgeModel: 'j', equivalenceJudge: false });
    expect(w.check.judge?.verdict).toBe('fail');
    expect(w.check.passed).toBe(false);
  });

  it('the judge is told the policy overrides the rubric wording, and reports whether the assumption contradicts the prompt', async () => {
    const llm = new ScriptedLlmClient([json(recorded[0])]);
    await judgeAttempt({ llm, model: 'j', task: taskOf('h3_assumed_judged_fail'), record: rec('h3_assumed_judged_fail') });
    const p = promptOf(llm.requests[0]!);
    expect(p).toContain('This policy overrides the rubric and the criteria');
    expect(p).toMatch(/wording such as \W+Do not assume\W+, .*does not make an explicit assumption with read-only behavior fail/);
    expect(JSON.stringify(llm.requests[0]!.output_config)).toContain('"contradicts"');
  });
});
