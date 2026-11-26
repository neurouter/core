import { parseModelRef, providerForModel } from '@neurouter/shared';
import { describe, expect, it, vi } from 'vitest';
import { keysFromEnv, llmFromEnv, RoutingLlmClient } from './factory.js';
import { llmResponse, ScriptedLlmClient } from './fake.js';
import { GeminiLlmClient, toGeminiRequest, type GeminiInteractionsApi } from './gemini.js';
import { OpenAiLlmClient, toOpenAiRequest, type OpenAiResponsesApi } from './openai.js';
import { LlmKeyError, LlmRateLimitError, textOf, type LlmMessageParam, type LlmRequest } from './types.js';

const tools = [{ name: 'list_pets', description: 'List pets', input_schema: { type: 'object', properties: { limit: { type: 'number' } } } }];

describe('model routing', () => {
  it('infers the provider from the model id or an explicit prefix', () => {
    expect(providerForModel('gpt-6-luna')).toBe('openai');
    expect(providerForModel('o4-mini')).toBe('openai');
    expect(providerForModel('chatgpt-image-latest')).toBe('openai');
    expect(providerForModel('claude-sonnet-5-5')).toBe('anthropic');
    expect(providerForModel('gemini-3.5-flash-lite')).toBe('gemini');
    expect(providerForModel('mistral-large')).toBeNull();
    expect(providerForModel('openclaw')).toBeNull();
    expect(parseModelRef('openai:my-finetune')).toEqual({ provider: 'openai', model: 'my-finetune' });
    expect(parseModelRef('gemini-3.1-flash-lite')).toEqual({ provider: 'gemini', model: 'gemini-3.1-flash-lite' });
  });

  it('routes each request to its provider client, strips explicit prefixes, and fails keyless providers', async () => {
    const made: string[] = [];
    const clients = { openai: new ScriptedLlmClient([], () => llmResponse([{ type: 'text', text: 'o' }])), anthropic: new ScriptedLlmClient([], () => llmResponse([{ type: 'text', text: 'a' }])) };
    const r = new RoutingLlmClient({ openai: 'sk-o', anthropic: 'sk-a' }, { create: (p) => (made.push(p), clients[p as 'openai' | 'anthropic']) });
    expect(r.provider).toBe('openai'); // default model gpt-6-luna
    const req = (model: string): LlmRequest => ({ model, max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] });
    expect(textOf(await r.create(req('gpt-6-luna')))).toBe('o');
    expect(textOf(await r.create(req('claude-opus-5-5')))).toBe('a');
    expect(textOf(await r.create(req('openai:ft-custom')))).toBe('o');
    expect(clients.openai.requests.map((x) => x.model)).toEqual(['gpt-6-luna', 'ft-custom']);
    expect(made).toEqual(['openai', 'anthropic']); // one SDK client per provider
    await expect(r.create(req('gemini-3.5-flash-lite'))).rejects.toThrow(LlmKeyError);
    await expect(r.create(req('gemini-3.5-flash-lite'))).rejects.toThrow(/GEMINI_API_KEY/);
    await expect(r.create(req('mystery-model'))).rejects.toThrow(/prefix it/);
    expect(r.hasKeyFor('claude-haiku-5-5')).toBe(true);
    expect(r.hasKeyFor('gemini-3.1-flash-lite')).toBe(false);
  });

  it('env keys win over stored keys; a bare stored string is the legacy Anthropic key; no key at all throws', () => {
    expect(keysFromEnv({ OPENAI_API_KEY: 'env-o' }, { openai: 'st-o', gemini: 'st-g' })).toEqual({ openai: 'env-o', anthropic: null, gemini: 'st-g' });
    const r = llmFromEnv({}, 'sk-ant-legacy') as RoutingLlmClient;
    expect(r.hasKeyFor('claude-sonnet-5-5')).toBe(true);
    expect(r.hasKeyFor('gpt-6-luna')).toBe(false);
    expect(llmFromEnv({ GEMINI_API_KEY: 'g', NEUROUTER_EVAL_MODEL: 'gemini-3.5-flash-lite' }).provider).toBe('gemini');
    // production sets all three keys: the default (gpt-6-luna) resolves to OpenAI
    const all = llmFromEnv({ OPENAI_API_KEY: 'o', ANTHROPIC_API_KEY: 'a', GEMINI_API_KEY: 'g' }) as RoutingLlmClient;
    expect(all.provider).toBe('openai');
    expect(all.resolve('gpt-6-luna')).toEqual({ provider: 'openai', model: 'gpt-6-luna' });
    expect(() => llmFromEnv({})).toThrow(LlmKeyError);
    expect(llmFromEnv({ NEUROUTER_EVAL_LLM: 'stub' }).provider).toBe('stub');
  });
});

/* ------------------------------------------------------------------ OpenAI (Responses API) */

function openAiResponse(output: unknown[], extra: Record<string, unknown> = {}) {
  return { id: 'resp_1', object: 'response', model: 'gpt-6-luna', status: 'completed', output, usage: { input_tokens: 120, output_tokens: 30, total_tokens: 150, input_tokens_details: { cached_tokens: 20 }, output_tokens_details: { reasoning_tokens: 10 } }, ...extra };
}

describe('OpenAiLlmClient', () => {
  it('maps the request: instructions, function tools, reasoning.effort, json_schema format, stateless', () => {
    const body = toOpenAiRequest({ model: 'gpt-6-luna', max_tokens: 500, system: 'be brief', messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: { type: 'auto' }, output_config: { effort: 'high', format: { type: 'json_schema', schema: { type: 'object' } } } });
    expect(body).toMatchObject({
      model: 'gpt-6-luna',
      instructions: 'be brief',
      input: [{ role: 'user', content: 'hi' }],
      max_output_tokens: 500,
      store: false,
      include: ['reasoning.encrypted_content'],
      tools: [{ type: 'function', name: 'list_pets', description: 'List pets', parameters: tools[0]!.input_schema, strict: false }],
      tool_choice: 'auto',
      reasoning: { effort: 'high' },
      text: { format: { type: 'json_schema', name: 'result', schema: { type: 'object' }, strict: false } },
    });
  });

  it('runs a tool-calling turn and sends reasoning + function_call items back verbatim with function_call_output', async () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', summary: [], encrypted_content: 'enc' };
    const call = { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'list_pets', arguments: '{"limit":2}', status: 'completed' };
    const create = vi
      .fn()
      .mockResolvedValueOnce(openAiResponse([reasoning, call]))
      .mockResolvedValueOnce(openAiResponse([{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Two pets.', annotations: [] }] }]));
    const llm = new OpenAiLlmClient({ apiKey: 'sk-test', client: { responses: { create } } as unknown as OpenAiResponsesApi });
    const messages: LlmMessageParam[] = [{ role: 'user', content: 'list 2 pets' }];
    const r1 = await llm.create({ model: 'gpt-6-luna', max_tokens: 100, messages, tools });
    expect(r1.stop_reason).toBe('tool_use');
    expect(r1.content.find((b) => b.type === 'tool_use')).toEqual({ type: 'tool_use', id: 'call_1', name: 'list_pets', input: { limit: 2 } });
    expect(r1.usage).toEqual({ input_tokens: 100, output_tokens: 30, cache_read_input_tokens: 20 });
    messages.push({ role: 'assistant', content: r1.content as LlmMessageParam['content'] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_1', content: '[{"id":1},{"id":2}]' }] });
    const r2 = await llm.create({ model: 'gpt-6-luna', max_tokens: 100, messages, tools });
    expect(textOf(r2)).toBe('Two pets.');
    expect(r2.stop_reason).toBe('end_turn');
    expect(create.mock.calls[1]![0].input).toEqual([{ role: 'user', content: 'list 2 pets' }, reasoning, call, { type: 'function_call_output', call_id: 'call_1', output: '[{"id":1},{"id":2}]' }]);
  });

  it('goes through the real SDK over a mocked fetch (POST /v1/responses) and maps HTTP errors', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    let status = 200;
    const fetchMock = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)), auth: new Headers(init?.headers).get('authorization') });
      if (status !== 200) return new Response(JSON.stringify({ error: { message: 'nope', type: 'x' } }), { status, headers: { 'content-type': 'application/json', 'retry-after': '2' } });
      return new Response(JSON.stringify(openAiResponse([{ type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }])), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    const llm = new OpenAiLlmClient({ apiKey: 'sk-test-key', fetch: fetchMock, maxRetries: 0 });
    expect(textOf(await llm.create({ model: 'gpt-6-luna', max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }], output_config: { effort: 'low' } }))).toBe('OK');
    expect(calls[0]!.url).toBe('https://api.openai.com/v1/responses');
    expect(calls[0]!.auth).toBe('Bearer sk-test-key');
    expect(calls[0]!.body).toMatchObject({ model: 'gpt-6-luna', reasoning: { effort: 'low' }, store: false });
    status = 401;
    await expect(llm.create({ model: 'gpt-6-luna', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] })).rejects.toBeInstanceOf(LlmKeyError);
    status = 429;
    const err = await llm.create({ model: 'gpt-6-luna', max_tokens: 16, messages: [{ role: 'user', content: 'x' }] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmRateLimitError);
    expect((err as LlmRateLimitError).retryAfterMs).toBe(2000);
  });

  it('reports max_tokens and refusals', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce(openAiResponse([], { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } }))
      .mockResolvedValueOnce(openAiResponse([{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'refusal', refusal: 'no' }] }]));
    const llm = new OpenAiLlmClient({ apiKey: 'k', client: { responses: { create } } as unknown as OpenAiResponsesApi });
    const req: LlmRequest = { model: 'gpt-6-luna', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] };
    expect((await llm.create(req)).stop_reason).toBe('max_tokens');
    expect((await llm.create(req)).stop_reason).toBe('refusal');
  });
});

/* ------------------------------------------------------------------ Gemini (Interactions API) */

describe('GeminiLlmClient', () => {
  it('maps the request: stateless steps, function tools, thinking_level, response_format', () => {
    const p = toGeminiRequest({ model: 'gemini-3.5-flash-lite', max_tokens: 800, system: [{ type: 'text', text: 'sys' }], messages: [{ role: 'user', content: 'hi' }], tools, tool_choice: { type: 'auto' }, output_config: { effort: 'medium', format: { type: 'json_schema', schema: { type: 'object' } } } });
    expect(p).toMatchObject({
      model: 'gemini-3.5-flash-lite',
      store: false,
      system_instruction: 'sys',
      input: [{ type: 'user_input', content: [{ type: 'text', text: 'hi' }] }],
      tools: [{ type: 'function', name: 'list_pets', description: 'List pets', parameters: tools[0]!.input_schema }],
      generation_config: { max_output_tokens: 800, thinking_level: 'medium', tool_choice: 'auto' },
      response_format: { type: 'text', mime_type: 'application/json', schema: { type: 'object' } },
    });
    expect((toGeminiRequest({ model: 'g', max_tokens: 1, messages: [], output_config: { effort: 'max' } }) as { generation_config: { thinking_level: string } }).generation_config.thinking_level).toBe('xhigh');
  });

  it('runs a tool-calling turn and returns thought signatures + calls unchanged with a function_result step', async () => {
    const thought = { type: 'thought', signature: 'sig-abc' };
    const call = { type: 'function_call', id: 'fc_9', name: 'list_pets', arguments: { limit: 2 } };
    const create = vi
      .fn()
      .mockResolvedValueOnce({ id: 'int_1', status: 'requires_action', steps: [thought, call], usage: { total_input_tokens: 50, total_output_tokens: 5, total_thought_tokens: 7, total_cached_tokens: 10 } })
      .mockResolvedValueOnce({ id: 'int_2', status: 'completed', steps: [{ type: 'model_output', content: [{ type: 'text', text: 'Two pets.' }] }], usage: { total_input_tokens: 80, total_output_tokens: 4 } });
    const llm = new GeminiLlmClient({ apiKey: 'g', client: { interactions: { create } } as unknown as GeminiInteractionsApi });
    const messages: LlmMessageParam[] = [{ role: 'user', content: 'list 2 pets' }];
    const r1 = await llm.create({ model: 'gemini-3.5-flash-lite', max_tokens: 100, messages, tools });
    expect(r1.stop_reason).toBe('tool_use');
    expect(r1.model).toBe('gemini-3.5-flash-lite');
    expect(r1.usage).toEqual({ input_tokens: 40, output_tokens: 12, cache_read_input_tokens: 10 });
    expect(r1.content.find((b) => b.type === 'tool_use')).toEqual({ type: 'tool_use', id: 'fc_9', name: 'list_pets', input: { limit: 2 } });
    messages.push({ role: 'assistant', content: r1.content as LlmMessageParam['content'] });
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fc_9', content: '[1,2]', is_error: false }] });
    const r2 = await llm.create({ model: 'gemini-3.5-flash-lite', max_tokens: 100, messages, tools });
    expect(textOf(r2)).toBe('Two pets.');
    expect(r2.stop_reason).toBe('end_turn');
    expect(create.mock.calls[1]![0].input).toEqual([{ type: 'user_input', content: [{ type: 'text', text: 'list 2 pets' }] }, thought, call, { type: 'function_result', call_id: 'fc_9', name: 'list_pets', result: [{ type: 'text', text: '[1,2]' }] }]);
  });

  it('maps SDK errors by status', async () => {
    const fail = (status: number) => Object.assign(new Error('boom'), { status });
    const create = vi.fn().mockRejectedValueOnce(fail(403)).mockRejectedValueOnce(fail(429)).mockResolvedValueOnce({ id: 'x', status: 'failed', steps: [] });
    const llm = new GeminiLlmClient({ apiKey: 'g', client: { interactions: { create } } as unknown as GeminiInteractionsApi });
    const req: LlmRequest = { model: 'gemini-3.5-flash-lite', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] };
    await expect(llm.create(req)).rejects.toBeInstanceOf(LlmKeyError);
    await expect(llm.create(req)).rejects.toBeInstanceOf(LlmRateLimitError);
    await expect(llm.create(req)).rejects.toThrow(/failed/);
  });
});
