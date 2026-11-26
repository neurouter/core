import { GoogleGenAI, type GoogleGenAIInteraction, type Interactions } from '@google/genai';
import { LlmError, LlmKeyError, LlmRateLimitError, type LlmClient, type LlmContentBlock, type LlmCreateOptions, type LlmMessageParam, type LlmRequest, type LlmResponse, type LlmTextBlock, type LlmToolResultBlock, type LlmToolUseBlock } from './types.js';

type CreateParams = Parameters<GoogleGenAI['interactions']['create']>[0];
type CreateOptions = Parameters<GoogleGenAI['interactions']['create']>[1];
type Step = Interactions.Step;
/** The fields of `GoogleGenAIInteraction` the adapter reads. */
export type GeminiInteraction = Pick<GoogleGenAIInteraction, 'id' | 'status' | 'steps' | 'usage'> & { model?: string | undefined };

/** Opaque assistant block carrying the model's Interactions steps (thoughts with signatures, calls, output) verbatim. */
export interface GeminiStepsBlock {
  type: 'gemini_steps';
  steps: Step[];
}

/** The slice of the SDK this adapter calls (injectable for tests). */
export interface GeminiInteractionsApi {
  interactions: { create(params: CreateParams, options?: CreateOptions): Promise<GeminiInteraction> };
}

/** Our effort scale → Interactions `generation_config.thinking_level` (minimal | low | medium | high | xhigh). */
const THINKING_LEVEL = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'xhigh' } as const;

/**
 * Adapter over `@google/genai` 3.6.1, Interactions API (`ai.interactions.create`), as the Gemini
 * function-calling docs show it, in stateless mode: `store: false` and the full step history as
 * `input` each turn (the model's own steps — thoughts with their `signature` — sent back
 * unchanged). Tools are `{ type: 'function', name, description, parameters }`; results go back as
 * `function_result` steps. Effort → `generation_config.thinking_level`.
 */
export class GeminiLlmClient implements LlmClient {
  readonly provider = 'gemini' as const;
  private readonly client: GeminiInteractionsApi;

  constructor(opts: { apiKey: string; client?: GeminiInteractionsApi }) {
    if (!opts.apiKey && !opts.client) throw new LlmKeyError('GEMINI_API_KEY is not configured');
    this.client = opts.client ?? new GoogleGenAI({ apiKey: opts.apiKey });
  }

  async create(req: LlmRequest, opts: LlmCreateOptions = {}): Promise<LlmResponse> {
    let res: GeminiInteraction;
    try {
      res = await this.client.interactions.create(toGeminiRequest(req), opts.signal ? { signal: opts.signal } : undefined);
    } catch (err) {
      throw mapGeminiError(err);
    }
    if (res.status === 'failed') throw new LlmError(`Gemini interaction ${res.id} failed`);
    return fromGeminiInteraction(res, req.model);
  }
}

function systemText(system: LlmRequest['system']): string | undefined {
  if (!system) return undefined;
  return typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');
}

export function toGeminiRequest(req: LlmRequest): CreateParams {
  const system = systemText(req.system);
  const effort = req.output_config?.effort;
  const format = req.output_config?.format;
  return {
    model: req.model,
    input: toGeminiSteps(req.messages),
    store: false,
    ...(system ? { system_instruction: system } : {}),
    ...(req.tools?.length ? { tools: req.tools.map((t) => ({ type: 'function' as const, name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema })) } : {}),
    generation_config: {
      max_output_tokens: req.max_tokens,
      ...(effort ? { thinking_level: THINKING_LEVEL[effort] } : {}),
      ...(req.tools?.length && req.tool_choice ? { tool_choice: req.tool_choice.type } : {}),
    },
    ...(format ? { response_format: { type: 'text' as const, mime_type: 'application/json', schema: format.schema } } : {}),
  } as CreateParams;
}

export function toGeminiSteps(messages: LlmMessageParam[]): Step[] {
  const out: Step[] = [];
  const names = new Map<string, string>();
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push(m.role === 'user' ? { type: 'user_input', content: [{ type: 'text', text: m.content }] } : { type: 'model_output', content: [{ type: 'text', text: m.content }] });
      continue;
    }
    for (const b of m.content) if (b.type === 'tool_use') names.set((b as LlmToolUseBlock).id, (b as LlmToolUseBlock).name);
    if (m.role === 'assistant') {
      const raw = m.content.find((b): b is GeminiStepsBlock & { [k: string]: unknown } => b.type === 'gemini_steps');
      if (raw) {
        out.push(...raw.steps);
        continue;
      }
      const text = m.content.filter((b): b is LlmTextBlock => b.type === 'text').map((b) => b.text).join('');
      if (text) out.push({ type: 'model_output', content: [{ type: 'text', text }] });
      for (const b of m.content) if (b.type === 'tool_use') {
        const u = b as LlmToolUseBlock;
        out.push({ type: 'function_call', id: u.id, name: u.name, arguments: (u.input && typeof u.input === 'object' ? u.input : {}) as Record<string, unknown> });
      }
      continue;
    }
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const r = b as LlmToolResultBlock;
        const content = typeof r.content === 'string' ? r.content : r.content.map((x) => x.text).join('');
        const name = names.get(r.tool_use_id);
        out.push({ type: 'function_result', call_id: r.tool_use_id, ...(name ? { name } : {}), result: [{ type: 'text', text: content }], ...(r.is_error ? { is_error: true } : {}) });
      } else if (b.type === 'text') text.push((b as LlmTextBlock).text);
    }
    if (text.length) out.push({ type: 'user_input', content: [{ type: 'text', text: text.join('') }] });
  }
  return out;
}

export function fromGeminiInteraction(res: GeminiInteraction, requestedModel: string): LlmResponse {
  // only the model's own steps (the stateless request echoes nothing back, but be defensive)
  const steps = (res.steps ?? []).filter((s) => s.type !== 'user_input' && s.type !== 'function_result');
  const content: LlmContentBlock[] = [];
  for (const s of steps) {
    if (s.type === 'model_output') {
      for (const c of s.content ?? []) if (c.type === 'text') content.push({ type: 'text', text: c.text });
    } else if (s.type === 'function_call') {
      content.push({ type: 'tool_use', id: s.id, name: s.name, input: s.arguments ?? {} });
    }
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  content.push({ type: 'gemini_steps', steps } satisfies GeminiStepsBlock);
  const u: Interactions.Usage = res.usage ?? {};
  const cached = u.total_cached_tokens ?? 0;
  return {
    id: res.id,
    model: res.model || requestedModel,
    role: 'assistant',
    content,
    stop_reason: hasTools ? 'tool_use' : res.status === 'incomplete' || res.status === 'budget_exceeded' ? 'max_tokens' : 'end_turn',
    // Anthropic semantics: input excludes cache reads; output includes thinking tokens (billed as output).
    usage: { input_tokens: Math.max(0, (u.total_input_tokens ?? 0) - cached), output_tokens: (u.total_output_tokens ?? 0) + (u.total_thought_tokens ?? 0), cache_read_input_tokens: cached },
  };
}

/** Both SDK error families (`ApiError`, Interactions `APIError`) carry a numeric `status`. */
export function mapGeminiError(err: unknown): Error {
  if (!(err instanceof Error)) return new LlmError(String(err));
  if (err.name === 'AbortError' || err.name === 'APIUserAbortError') return err;
  const status = (err as { status?: unknown }).status;
  if (status === 401 || status === 403) return new LlmKeyError(err.message);
  if (status === 400 && /api key/i.test(err.message)) return new LlmKeyError(err.message);
  if (status === 429) {
    const h = (err as { headers?: { get?: (k: string) => string | null } }).headers;
    const ra = Number(h?.get?.('retry-after'));
    return new LlmRateLimitError(err.message, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
  }
  if (typeof status === 'number') return new LlmError(err.message, status);
  return err;
}
