import { DEFAULT_EVAL_MODEL, LLM_PROVIDER_KINDS, PROVIDER_MODELS, providerForModel, type LlmProviderKind, type Settings } from '@/contract';

/** Kinds with a key (env or stored). */
export function configuredKinds(s: Settings | undefined): LlmProviderKind[] {
  if (!s) return [];
  return LLM_PROVIDER_KINDS.filter((k) => s.models.keys[k].configured);
}

/** Models offered in pickers: the eval model first, then the lists of providers that have a key. */
export function availableModels(s: Settings | undefined): string[] {
  const evalModel = s?.models.evalModel ?? DEFAULT_EVAL_MODEL;
  return [evalModel, ...configuredKinds(s).flatMap((k) => PROVIDER_MODELS[k])].filter((v, i, a) => a.indexOf(v) === i);
}

/** Model picker options grouped by provider (all providers; the current value is kept when it is custom). */
export function modelGroups(current: string): Array<{ kind: LlmProviderKind | null; models: string[] }> {
  const groups: Array<{ kind: LlmProviderKind | null; models: string[] }> = LLM_PROVIDER_KINDS.map((k) => ({ kind: k, models: [...PROVIDER_MODELS[k]] }));
  if (!groups.some((g) => g.models.includes(current))) {
    const kind = providerForModel(current);
    const g = groups.find((x) => x.kind === kind);
    if (g) g.models.unshift(current);
    else groups.push({ kind: null, models: [current] });
  }
  return groups;
}
