import { AnthropicLlmClient } from './anthropic.js';
import { FakeLlmClient } from './fake.js';
import { StubLlmClient } from './stub.js';
import { LlmError, LlmKeyError, type LlmClient } from './types.js';

export type LlmProvider = 'anthropic' | 'stub' | 'fake';

export interface CreateLlmClientOptions {
  provider: LlmProvider;
  apiKey?: string | null;
  /** fixture dir for `fake`. */
  fakeDir?: string;
  baseURL?: string;
  nodeEnv?: string;
}

/** Explicit provider selection: the stub and the fake are never picked implicitly. */
export function createLlmClient(opts: CreateLlmClientOptions): LlmClient {
  switch (opts.provider) {
    case 'anthropic':
      if (!opts.apiKey) throw new LlmKeyError('ANTHROPIC_API_KEY is not configured');
      return new AnthropicLlmClient({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
    case 'stub':
      return new StubLlmClient();
    case 'fake':
      if (!opts.fakeDir) throw new LlmError('fake LLM needs a fixture directory');
      return new FakeLlmClient(opts.fakeDir, { env: opts.nodeEnv ?? process.env.NODE_ENV });
  }
}

/**
 * Provider from the environment: `NEUROUTER_EVAL_FAKE_LLM=<dir>` (tests) → fake;
 * `NEUROUTER_EVAL_LLM=stub` → deterministic stub; otherwise Anthropic with the given/env key.
 */
export function llmFromEnv(env: Record<string, string | undefined> = process.env, apiKey?: string | null): LlmClient {
  if (env.NEUROUTER_EVAL_FAKE_LLM) return createLlmClient({ provider: 'fake', fakeDir: env.NEUROUTER_EVAL_FAKE_LLM, ...(env.NODE_ENV ? { nodeEnv: env.NODE_ENV } : {}) });
  if (env.NEUROUTER_EVAL_LLM === 'stub') return createLlmClient({ provider: 'stub' });
  return createLlmClient({ provider: 'anthropic', apiKey: apiKey ?? env.ANTHROPIC_API_KEY ?? null });
}
