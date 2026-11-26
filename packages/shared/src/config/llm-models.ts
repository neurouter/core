import { z } from 'zod';

/**
 * LLM providers the evals (generator, agent runs, judge, fix suggestions) can call, and the model
 * ids the console offers for each. Any other id is accepted too (typed in the console, yaml or
 * `--models`); the provider comes from its prefix, or from an explicit `provider:model` form.
 */
export const LlmProviderKind = z.enum(['openai', 'anthropic', 'gemini']);
export type LlmProviderKind = z.infer<typeof LlmProviderKind>;
export const LLM_PROVIDER_KINDS = LlmProviderKind.options;

/** The default model everywhere (evals, judge, generator). */
export const DEFAULT_EVAL_MODEL = 'gpt-6-luna';

/*
 * Per-provider console lists. Ids verified against each provider's live /models endpoint
 * (2026-11-26); docs: https://developers.openai.com/api/docs/models,
 * https://platform.claude.com/docs/en/about-claude/models/overview, https://ai.google.dev/gemini-api/docs/models.
 */
export const OPENAI_MODELS = ['gpt-6-luna', 'gpt-6-sol', 'gpt-6-astra', 'gpt-6.1-sol', 'gpt-6.1-terra', 'gpt-6.2-sol', 'gpt-6.2-astra'] as const;
export const ANTHROPIC_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-2'] as const;
export const GEMINI_MODELS = ['gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-3.1-flash-lite'] as const;

/**
 * Default judge when no judge model is set and a Gemini key is available: Gemini accepts temperature 0 and a fixed
 * seed, so verdicts are reproducible (2026-11-27: 12/12 identical verdicts across two runs on the disputed P6
 * ambiguous attempts, where the unpinnable OpenAI judge flipped even with best-of-3 voting). Without a Gemini key
 * the judge falls back to the eval model with borderline voting.
 */
export const DETERMINISTIC_JUDGE_MODEL = 'gemini-3.5-flash-lite';

export const PROVIDER_MODELS: Record<LlmProviderKind, readonly string[]> = { openai: OPENAI_MODELS, anthropic: ANTHROPIC_MODELS, gemini: GEMINI_MODELS };

export const PROVIDER_LABELS: Record<LlmProviderKind, string> = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' };

/** The environment variable holding each provider's key (all optional). */
export const PROVIDER_ENV_KEYS: Record<LlmProviderKind, 'OPENAI_API_KEY' | 'ANTHROPIC_API_KEY' | 'GEMINI_API_KEY'> = { openai: 'OPENAI_API_KEY', anthropic: 'ANTHROPIC_API_KEY', gemini: 'GEMINI_API_KEY' };

/**
 * Splits a model reference: `openai:my-finetune` → explicit provider; otherwise the provider is
 * inferred from the id (`gpt-*`, `chatgpt-*`, `o<digit>*` → openai, `claude-*` → anthropic,
 * `gemini-*` → gemini). `provider` is null when it cannot be told.
 */
export function parseModelRef(ref: string): { provider: LlmProviderKind | null; model: string } {
  const m = /^(openai|anthropic|gemini):(.+)$/.exec(ref.trim());
  if (m) return { provider: m[1] as LlmProviderKind, model: m[2]! };
  return { provider: providerForModel(ref), model: ref.trim() };
}

/** Provider inferred from a bare model id (null when unknown). */
export function providerForModel(model: string): LlmProviderKind | null {
  const id = model.trim().toLowerCase();
  const explicit = /^(openai|anthropic|gemini):/.exec(id);
  if (explicit) return explicit[1] as LlmProviderKind;
  if (/^(gpt-|chatgpt-|o\d)/.test(id)) return 'openai';
  if (id.startsWith('claude-')) return 'anthropic';
  if (id.startsWith('gemini-')) return 'gemini';
  return null;
}
