import { DEFAULT_EVAL_MODEL, parseModelRef, PROVIDER_ENV_KEYS, PROVIDER_LABELS, type LlmProviderKind } from '@neurouter/shared';
import { AnthropicLlmClient } from './anthropic.js';
import { FakeLlmClient } from './fake.js';
import { GeminiLlmClient } from './gemini.js';
import { OpenAiLlmClient } from './openai.js';
import { StubLlmClient } from './stub.js';
import { LlmError, LlmKeyError, type LlmClient, type LlmCreateOptions, type LlmRequest, type LlmResponse } from './types.js';

export type LlmProvider = LlmProviderKind | 'stub' | 'fake';

/** Per-provider API keys (null/undefined = not configured). */
export type LlmKeys = Partial<Record<LlmProviderKind, string | null | undefined>>;

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
    case 'openai':
      if (!opts.apiKey) throw new LlmKeyError('OPENAI_API_KEY is not configured');
      return new OpenAiLlmClient({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
    case 'anthropic':
      if (!opts.apiKey) throw new LlmKeyError('ANTHROPIC_API_KEY is not configured');
      return new AnthropicLlmClient({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
    case 'gemini':
      if (!opts.apiKey) throw new LlmKeyError('GEMINI_API_KEY is not configured');
      return new GeminiLlmClient({ apiKey: opts.apiKey });
    case 'stub':
      return new StubLlmClient();
    case 'fake':
      if (!opts.fakeDir) throw new LlmError('fake LLM needs a fixture directory');
      return new FakeLlmClient(opts.fakeDir, { env: opts.nodeEnv ?? process.env.NODE_ENV });
  }
}

/**
 * Routes each request to the provider its model belongs to (`gpt-*`/`o<digit>*` → OpenAI,
 * `claude-*` → Anthropic, `gemini-*` → Gemini, or an explicit `provider:model`), creating one SDK
 * client per provider on first use. A model whose provider has no key fails with `LlmKeyError`.
 */
export class RoutingLlmClient implements LlmClient {
  readonly provider: LlmProviderKind;
  private readonly clients = new Map<LlmProviderKind, LlmClient>();
  private readonly create_: (provider: LlmProviderKind, apiKey: string) => LlmClient;

  constructor(
    private readonly keys: LlmKeys,
    opts: { defaultModel?: string; create?: (provider: LlmProviderKind, apiKey: string) => LlmClient } = {},
  ) {
    this.provider = parseModelRef(opts.defaultModel ?? DEFAULT_EVAL_MODEL).provider ?? 'openai';
    this.create_ = opts.create ?? ((provider, apiKey) => createLlmClient({ provider, apiKey }));
  }

  /** The provider and bare model id a model reference resolves to (throws when unroutable or keyless). */
  resolve(modelRef: string): { provider: LlmProviderKind; model: string } {
    const { provider, model } = parseModelRef(modelRef);
    if (!provider) throw new LlmError(`Cannot tell which provider serves model "${modelRef}"; prefix it with openai:, anthropic: or gemini:`, 400);
    if (!this.keys[provider]) throw new LlmKeyError(`${PROVIDER_LABELS[provider]} API key missing for model ${model} (set ${PROVIDER_ENV_KEYS[provider]} or add it in Settings › Models)`);
    return { provider, model };
  }

  hasKeyFor(modelRef: string): boolean {
    const { provider } = parseModelRef(modelRef);
    return Boolean(provider && this.keys[provider]);
  }

  async create(req: LlmRequest, opts?: LlmCreateOptions): Promise<LlmResponse> {
    const { provider, model } = this.resolve(req.model);
    let client = this.clients.get(provider);
    if (!client) {
      client = this.create_(provider, this.keys[provider]!);
      this.clients.set(provider, client);
    }
    return client.create(model === req.model ? req : { ...req, model }, opts);
  }
}

/** Keys from the environment (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY), overlaid by `stored` where env is unset. */
export function keysFromEnv(env: Record<string, string | undefined>, stored: LlmKeys = {}): LlmKeys {
  const out: LlmKeys = {};
  for (const k of ['openai', 'anthropic', 'gemini'] as const) out[k] = env[PROVIDER_ENV_KEYS[k]] || stored[k] || null;
  return out;
}

/**
 * Provider from the environment: `NEUROUTER_EVAL_FAKE_LLM=<dir>` (tests) → fake;
 * `NEUROUTER_EVAL_LLM=stub` → deterministic stub; otherwise a router over the providers that have
 * a key (env wins over `stored`; a bare string is a legacy stored Anthropic key). No key at all →
 * `LlmKeyError`.
 */
export function llmFromEnv(env: Record<string, string | undefined> = process.env, stored?: LlmKeys | string | null, opts: { defaultModel?: string } = {}): LlmClient {
  if (env.NEUROUTER_EVAL_FAKE_LLM) return createLlmClient({ provider: 'fake', fakeDir: env.NEUROUTER_EVAL_FAKE_LLM, ...(env.NODE_ENV ? { nodeEnv: env.NODE_ENV } : {}) });
  if (env.NEUROUTER_EVAL_LLM === 'stub') return createLlmClient({ provider: 'stub' });
  const keys = keysFromEnv(env, typeof stored === 'string' ? { anthropic: stored } : (stored ?? {}));
  if (!Object.values(keys).some(Boolean)) throw new LlmKeyError('No model provider key is configured (set OPENAI_API_KEY, ANTHROPIC_API_KEY or GEMINI_API_KEY, or add a key in Settings › Models)');
  return new RoutingLlmClient(keys, { defaultModel: opts.defaultModel ?? env.NEUROUTER_EVAL_MODEL ?? DEFAULT_EVAL_MODEL });
}
