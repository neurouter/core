import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createLlmClient, llmFromEnv } from './factory.js';
import { FakeLlmClient, llmResponse, promptHash } from './fake.js';
import { LlmKeyError, type LlmRequest } from './types.js';

const req: LlmRequest = { model: 'm', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }] };

describe('llm clients', () => {
  it('fake replays fixtures by prompt hash and refuses outside NODE_ENV=test', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nr-fake-'));
    fs.writeFileSync(path.join(dir, `${promptHash(req)}.json`), JSON.stringify(llmResponse([{ type: 'text', text: 'hello' }])));
    const fake = new FakeLlmClient(dir, { env: 'test' });
    expect((await fake.create(req)).content[0]).toEqual({ type: 'text', text: 'hello' });
    await expect(fake.create({ ...req, model: 'other' })).rejects.toThrow(/no fixture/);
    expect(() => new FakeLlmClient(dir, { env: 'production' })).toThrow(/NODE_ENV=test/);
  });

  it('factory selects providers explicitly; anthropic needs a key', () => {
    expect(createLlmClient({ provider: 'stub' }).provider).toBe('stub');
    expect(() => createLlmClient({ provider: 'anthropic' })).toThrow(LlmKeyError);
    expect(createLlmClient({ provider: 'anthropic', apiKey: 'sk-test' }).provider).toBe('anthropic');
    expect(llmFromEnv({ NEUROUTER_EVAL_LLM: 'stub' }).provider).toBe('stub');
    expect(() => llmFromEnv({})).toThrow(LlmKeyError);
  });
});
