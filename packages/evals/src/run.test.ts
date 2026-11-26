import { describe, expect, it } from 'vitest';
import { attemptKey, callsFromAgent, runAttempt, runSuite } from './run.js';
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
    expect(r).toMatchObject({ inputTokens: 3 + 2000 + 4 + 50, cacheReadTokens: 2000 });
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

  it('aborts the whole run on key errors', async () => {
    await expect(runSuite({ llm: new ScriptedLlmClient([], () => Promise.reject(new LlmKeyError())), tasks: [task()], models: ['m'], modes: ['tool'], repeats: 3, openSession: async () => ({ mcp: fakePetstore() }) })).rejects.toBeInstanceOf(LlmKeyError);
  });

  it('callsFromAgent unwraps call_tool', () => {
    expect(callsFromAgent([{ name: 'call_tool', arguments: { name: 'x', arguments: { a: 1 } }, isError: false, latencyMs: 0 }])[0]).toMatchObject({ tool: 'x', arguments: { a: 1 }, via: 'call_tool' });
  });
});
