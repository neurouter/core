import type Anthropic from '@anthropic-ai/sdk';
import type * as AnthropicSdk from '@anthropic-ai/sdk';
import { FALLBACK_BETA, LlmError, LlmKeyError, LlmRateLimitError, type LlmClient, type LlmCreateOptions, type LlmRequest, type LlmResponse } from './types.js';

/**
 * Real adapter over `@anthropic-ai/sdk` 1.14.0. `output_config` (effort, format) and top-level
 * `cache_control` are typed params of `messages.create`; `fallbacks` exists only on the beta
 * endpoint (`client.beta.messages.create` with `betas: ['server-side-fallback-2026-07-01']`).
 */
export class AnthropicLlmClient implements LlmClient {
  readonly provider = 'anthropic' as const;
  private client?: Promise<Anthropic>;

  constructor(private readonly opts: { apiKey: string; baseURL?: string; maxRetries?: number }) {
    if (!opts.apiKey) throw new LlmKeyError();
  }

  /** The SDK is imported on first use, not at boot (cold start: it is ~270 files). */
  private sdk(): Promise<Anthropic> {
    const { apiKey, baseURL, maxRetries } = this.opts;
    return (this.client ??= loadSdk().then(({ default: A }) => new A({ apiKey, ...(baseURL ? { baseURL } : {}), maxRetries: maxRetries ?? 2 })));
  }

  async create(req: LlmRequest, opts: LlmCreateOptions = {}): Promise<LlmResponse> {
    const { fallbacks, ...rest } = req;
    const betas = [...(opts.betas ?? [])];
    if (fallbacks && !betas.includes(FALLBACK_BETA)) betas.push(FALLBACK_BETA);
    const client = await this.sdk();
    try {
      if (betas.length) {
        const res = await client.beta.messages.create({ ...(rest as Record<string, unknown>), ...(fallbacks ? { fallbacks } : {}), betas } as never, opts.signal ? { signal: opts.signal } : undefined);
        return res as unknown as LlmResponse;
      }
      const res = await client.messages.create(rest as never, opts.signal ? { signal: opts.signal } : undefined);
      return res as unknown as LlmResponse;
    } catch (err) {
      throw mapSdkError(err, (await loadSdk()).default);
    }
  }
}

let sdkModule: Promise<typeof AnthropicSdk> | undefined;
const loadSdk = () => (sdkModule ??= import('@anthropic-ai/sdk'));

export function mapSdkError(err: unknown, Anthropic: typeof AnthropicSdk.default): Error {
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) return new LlmKeyError(err.message);
  if (err instanceof Anthropic.RateLimitError) {
    const ra = Number(err.headers?.get?.('retry-after'));
    return new LlmRateLimitError(err.message, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
  }
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIError) return new LlmError(err.message, typeof err.status === 'number' ? err.status : null);
  return err instanceof Error ? err : new LlmError(String(err));
}
