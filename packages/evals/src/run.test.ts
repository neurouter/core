import { describe, expect, it } from 'vitest';
import { attemptKey, callsFromAgent, gradeAttempt, runAttempt, runSuite, runSuiteDetailed } from './run.js';
import { EQUIV_MARKER, JUDGE_MARKER } from './prompts.js';
import { record } from './test/fixtures.js';
import type { LlmClient, LlmRequest } from './llm/types.js';
import { ScriptedLlmClient, llmResponse } from './llm/fake.js';
import { LlmError, LlmKeyError, LlmRateLimitError } from './llm/types.js';
import { fakePetstore, task } from './test/fixtures.js';

const use = (id: string, name: string, input: Record<string, unknown>) => ({ type: 'tool_use' as const, id, name, input });
const text = (t: string) => ({ type: 'text' as const, text: t });

describe('runAttempt', () => {
  it('maps MCP tools 1:1, runs parallel tool_use blocks and returns all results in one message', async () => {
    const mcp = fakePetstore();
    const llm = new ScriptedLlmClient([
      llmResponse([use('u1', 'neurouter_begin_task', { goal: 'g' })]),
      llmResponse([use('u2', 'get_pet_by_id', { petId: 1 }), use('u3', 'list_pets', {})]),
      llmResponse([use('u4', 'neurouter_end_task', { outcome: 'success' })]),
      llmResponse([text('Rex is available.')], { input: 50, output: 5 }),
    ]);
    const r = await runAttempt({ llm, mcp, prompt: 'Find pet 1', model: 'claude-sonnet-5-5', mode: 'tool' });
    const req = llm.requests[0]!;
    expect(req.tools!.map((t) => t.name)).toEqual(['neurouter_begin_task', 'neurouter_end_task', 'neurouter_report_unmet_need', 'list_pets', 'get_pet_by_id', 'add_pet']);
    expect(req.tools![4]!.input_schema).toMatchObject({ required: ['petId'] });
    expect(req).toMatchObject({ tool_choice: { type: 'auto' }, output_config: { effort: 'medium' }, cache_control: { type: 'ephemeral' }, fallbacks: 'default', max_tokens: 16000 });
    expect(req).not.toHaveProperty('thinking');
    expect(String(req.system)).toContain('Petstore API');
    const third = llm.requests[2]!.messages.at(-1)!;
    expect(third.role).toBe('user');
    expect((third.content as unknown[]).map((b) => (b as { tool_use_id: string }).tool_use_id)).toEqual(['u2', 'u3']);
    expect(r).toMatchObject({ endReason: 'end_turn', finalAnswer: 'Rex is available.', toolCallsByAgent: 2, turns: 4, neurouterTaskId: 'task_1', fallbackUsed: false });
    expect(r.inputTokens).toBe(350);
    expect(r.transcript.filter((t) => t.kind === 'tool_result')).toHaveLength(4);
  });

  it('counts Anthropic cache writes as input tokens (input_tokens excludes them)', async () => {
    const mcp = fakePetstore();
    const cached = (r: ReturnType<typeof llmResponse>, write: number, read: number) => ({ ...r, usage: { ...r.usage, cache_creation_input_tokens: write, cache_read_input_tokens: read } });
    const llm = new ScriptedLlmClient([cached(llmResponse([use('u1', 'list_pets', {})], { input: 3 }), 2000, 0), cached(llmResponse([text('done')], { input: 4 }), 50, 2000)]);
    const r = await runAttempt({ llm, mcp, prompt: 'p', model: 'claude-haiku-5-5', mode: 'tool' });
    expect(r).toMatchObject({ inputTokens: 3 + 2000 + 4 + 50, cacheReadTokens: 2000, cacheWriteTokens: 2050 });
  });

  it('keeps full transcripts when transcriptMaxChars is null (eval --transcripts), trims to 4,096 by default', async () => {
    const long = 'x'.repeat(10_000);
    const mk = () => new ScriptedLlmClient([llmResponse([text(long), use('u1', 'list_pets', {})]), llmResponse([text('done')])]);
    const full = await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: long, model: 'm', mode: 'tool', settings: { transcriptMaxChars: null } });
    expect(full.transcript[0]).toEqual({ kind: 'user', text: long });
    expect(full.transcript.find((t) => t.kind === 'assistant')).toEqual({ kind: 'assistant', text: long });
    const trimmed = await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: long, model: 'm', mode: 'tool' });
    expect((trimmed.transcript[0] as { text: string }).text).toBe(`${'x'.repeat(4096)}… [5904 more characters trimmed]`);
    const custom = await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: long, model: 'm', mode: 'tool', settings: { transcriptMaxChars: 100 } });
    expect((custom.transcript[0] as { text: string }).text.startsWith(`${'x'.repeat(100)}…`)).toBe(true);
  });

  it('marks errors from tools as is_error and counts run_script once', async () => {
    const mcp = fakePetstore({ mode: 'code', failTool: 'search_tools' });
    const llm = new ScriptedLlmClient([llmResponse([use('a', 'search_tools', { query: 'x' }), use('b', 'run_script', { code: 'r1 = petstore.list_pets()\nreturn r1' })]), llmResponse([text('done')])]);
    const r = await runAttempt({ llm, mcp, prompt: 'p', model: 'm', mode: 'code' });
    const res = llm.requests[1]!.messages.at(-1)!.content as Array<{ is_error?: boolean }>;
    expect(res[0]!.is_error).toBe(true);
    expect(r.scripts).toBe(1);
    expect(r.toolCallsByAgent).toBe(2);
  });

  it('stops on limits: turns, tool calls, tokens, wall time', async () => {
    const loop = () => llmResponse([use(`x${Math.random()}`, 'list_pets', {})], { input: 1000, output: 10 });
    const mk = () => new ScriptedLlmClient([], loop);
    expect((await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool', limits: { maxTurns: 3 } })).endReason).toBe('max_turns');
    expect((await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool', limits: { maxToolCalls: 2 } })).endReason).toBe('max_tool_calls');
    expect((await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool', limits: { maxTotalTokens: 2500 } })).endReason).toBe('over_budget');
    let t = 0;
    expect((await runAttempt({ llm: mk(), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool', now: () => (t += 100_000) })).endReason).toBe('timeout');
  });

  it('refusal ends the attempt as a failure; fallback-served answers are flagged', async () => {
    const r = await runAttempt({ llm: new ScriptedLlmClient([llmResponse([text('no')], { stop: 'refusal' })]), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool' });
    expect(r.endReason).toBe('refusal');
    const fb = await runAttempt({ llm: new ScriptedLlmClient([llmResponse([text('ok')], { model: 'm', iterations: [{ type: 'message' }, { type: 'fallback_message', model: 'claude-opus-5-5' }] })]), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool' });
    expect(fb).toMatchObject({ fallbackUsed: true, servedByModel: 'claude-opus-5-5' });
  });

  it('retries rate limits with backoff, fails the attempt on other API errors and throws on key errors', async () => {
    const sleeps: number[] = [];
    const llm = new ScriptedLlmClient([new LlmRateLimitError('slow', 2000), new LlmRateLimitError('slow'), llmResponse([text('ok')])]);
    const r = await runAttempt({ llm, mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool', sleep: async (ms) => void sleeps.push(ms), random: () => 0 });
    expect(r.endReason).toBe('end_turn');
    expect(sleeps).toEqual([2000, 2000]);
    const four = new ScriptedLlmClient([new LlmRateLimitError('a'), new LlmRateLimitError('b'), new LlmRateLimitError('c'), new LlmRateLimitError('d')]);
    expect((await runAttempt({ llm: four, mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool', sleep: async () => {} })).endReason).toBe('error');
    expect((await runAttempt({ llm: new ScriptedLlmClient([new LlmError('500', 500)]), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool' })).error).toBe('500');
    await expect(runAttempt({ llm: new ScriptedLlmClient([new LlmKeyError()]), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool' })).rejects.toBeInstanceOf(LlmKeyError);
  });
});

describe('runSuite', () => {
  it('runs task × model × mode × attempt with resumability, progress and checking', async () => {
    const t = task({ key: 'get', assertions: [{ type: 'called', tool: 'get_pet_by_id', args: { petId: 1 } }], referenceCalls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 } }] });
    const llm = new ScriptedLlmClient([], (req) => (req.messages.length === 1 ? llmResponse([use(`u${req.model}`, 'get_pet_by_id', { petId: 1 })]) : llmResponse([text('Rex')])));
    const progress: number[] = [];
    const opened: string[] = [];
    const results = await runSuite({
      llm,
      tasks: [t],
      models: ['m1', 'm2'],
      modes: ['tool'],
      repeats: 2,
      openSession: async (ctx) => {
        opened.push(ctx.key);
        return { mcp: fakePetstore() };
      },
      hasResult: (k) => k === attemptKey('get', 'm2', 'tool', 2),
      onProgress: (d) => progress.push(d),
    });
    expect(results).toHaveLength(3);
    expect(opened).not.toContain('get|m2|tool|2');
    expect(results.every((r) => r.passed && r.toolCalls === 1)).toBe(true);
    expect(progress.sort()).toEqual([1, 2, 3, 4]);
  });

  it('efficiency counts work calls only: search_tools discovery in code mode is excluded (as for max_calls)', async () => {
    const t = task({ key: 'code', assertions: [{ type: 'max_calls', n: 1 }], referenceCalls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 } }] });
    let n = 0;
    const llm = new ScriptedLlmClient([], () => {
      n++;
      if (n === 1) return llmResponse([use('s1', 'search_tools', { query: 'pet by id' })]);
      if (n === 2) return llmResponse([use('r1', 'run_script', { code: 'return petstore.get_pet_by_id(pet_id=1)' })]);
      return llmResponse([text('Rex')]);
    });
    const results = await runSuite({ llm, tasks: [t], models: ['m'], modes: ['code'], repeats: 1, openSession: async () => ({ mcp: fakePetstore({ mode: 'code' }) }) });
    expect(results[0]).toMatchObject({ passed: true, toolCalls: 1 });
  });

  it('aborts the whole run on key errors', async () => {
    await expect(runSuite({ llm: new ScriptedLlmClient([], () => Promise.reject(new LlmKeyError())), tasks: [task()], models: ['m'], modes: ['tool'], repeats: 3, openSession: async () => ({ mcp: fakePetstore() }) })).rejects.toBeInstanceOf(LlmKeyError);
  });

  it('callsFromAgent unwraps call_tool', () => {
    expect(callsFromAgent([{ name: 'call_tool', arguments: { name: 'x', arguments: { a: 1 } }, isError: false, latencyMs: 0 }])[0]).toMatchObject({ tool: 'x', arguments: { a: 1 }, via: 'call_tool' });
  });
});

describe('ground truth, judges, spend (0.2.2)', () => {
  const answerTask = task({ key: 'g', category: 'single', referenceCalls: [{ tool: 'get_pet_by_id', arguments: { petId: 1 } }], assertions: [{ type: 'answer_contains', from: 'ref[0].data.name' }] });
  const script = (answer: string) => [llmResponse([use('u1', 'get_pet_by_id', { petId: 1 })], { input: 100, output: 10 }), llmResponse([text(answer)], { input: 100, output: 10 })];

  it('records framing availability and the tools/list size', async () => {
    const r = await runAttempt({ llm: new ScriptedLlmClient(script('Rex')), mcp: fakePetstore(), prompt: 'p', model: 'm', mode: 'tool' });
    expect(r.framingAvailable).toBe(true);
    expect(r.toolsListBytes).toBeGreaterThan(200);
  });

  it('checks answers against the ground truth computed once per task', async () => {
    let computed = 0;
    const llm = new ScriptedLlmClient([...script('The pet is Rex.'), ...script('The pet is Rex.')]);
    const out = await runSuiteDetailed({
      llm,
      tasks: [answerTask],
      models: ['m'],
      modes: ['tool'],
      repeats: 2,
      concurrency: 1,
      equivalenceJudge: false,
      openSession: async () => ({ mcp: fakePetstore() }),
      groundTruth: async () => (computed++, { refs: [{ tool: 'get_pet_by_id', ok: true, data: { id: 1, name: 'Rex' } }] }),
    });
    expect(computed).toBe(1);
    expect(out.results.map((r) => r.passed)).toEqual([true, true]);
    expect(out.results[0]).toMatchObject({ upstreamCalls: 1, overBudget: false });
    expect(out.incomplete).toBeNull();
    expect(out.tokensUsed).toBe(2 * 220);
  });

  it('--max-run-tokens stops starting attempts and marks the run incomplete', async () => {
    const llm = new ScriptedLlmClient([...script('Rex'), ...script('Rex'), ...script('Rex')]);
    const out = await runSuiteDetailed({ llm, tasks: [answerTask], models: ['m'], modes: ['tool'], repeats: 3, concurrency: 1, maxRunTokens: 300, openSession: async () => ({ mcp: fakePetstore() }) });
    expect(out.results).toHaveLength(2);
    expect(out.incomplete).toMatchObject({ attemptsRun: 2, attemptsPlanned: 3 });
    expect(out.incomplete!.reason).toContain('--max-run-tokens 300');
  });

  it('gradeAttempt: the equivalence judge can pass a failed answer check (matched_by: judge); judge usage is counted', async () => {
    const reqs: LlmRequest[] = [];
    const judge: LlmClient = {
      provider: 'fake',
      create: async (req) => {
        reqs.push(req);
        const body = String(req.messages[0]!.content);
        if (body.includes(EQUIV_MARKER)) return llmResponse([text('{"items":[{"index":0,"equivalent":true,"reason":"Rex the dog"}]}')], { input: 300, output: 20 });
        expect(body).toContain(JUDGE_MARKER);
        return llmResponse([text('{"score":0.9,"verdict":"pass","reasons":["ok"]}')], { input: 200, output: 10 });
      },
    } as LlmClient;
    const t = task({ ...answerTask, assertions: [{ type: 'answer_contains', from: 'ref[0].data.name' }, { type: 'judge', criterion: 'names the pet', groundTruth: true }] });
    const gt = { refs: [{ tool: 'get_pet_by_id', ok: true, data: { name: 'R3x' } }] };
    const { check, judgeUsage } = await gradeAttempt(t, record({ finalAnswer: 'It is the dog called Rex' }), { llm: judge, judgeModel: 'j', groundTruth: gt });
    expect(check.passed).toBe(true);
    expect(check.results[0]!.matchedBy).toBe('judge');
    expect(judgeUsage).toEqual({ calls: 2, inputTokens: 500, outputTokens: 30, cacheReadTokens: 0 });
    // the rubric judge saw the ground truth
    expect(String(reqs[0]!.messages[0]!.content)).toContain('groundTruth');
  });
});
