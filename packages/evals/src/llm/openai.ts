import OpenAI from 'openai';
import type { ResponseCreateParamsNonStreaming, ResponseInputItem, ResponseOutputItem, Response as OpenAIResponse } from 'openai/resources/responses/responses';
import { LlmError, LlmKeyError, LlmRateLimitError, type LlmClient, type LlmContentBlock, type LlmCreateOptions, type LlmMessageParam, type LlmRequest, type LlmResponse, type LlmTextBlock, type LlmToolResultBlock, type LlmToolUseBlock } from './types.js';

/** Opaque assistant block carrying the Responses API output items (reasoning, function_call, message) verbatim. */
export interface OpenAiItemsBlock {
  type: 'openai_items';
  items: ResponseOutputItem[];
}

/** The slice of the SDK this adapter calls (injectable for tests). */
export interface OpenAiResponsesApi {
  responses: { create(body: ResponseCreateParamsNonStreaming, options?: { signal?: AbortSignal }): Promise<OpenAIResponse> };
}

/**
 * Adapter over `openai` 7.65.0, Responses API (`client.responses.create`), stateless: `store: false`
 * and `include: ['reasoning.encrypted_content']`, so the reasoning items of one turn are sent back
 * verbatim with the next (tool-calling loop) without OpenAI keeping the conversation.
 * Effort → `reasoning.effort`; JSON output → `text.format` `json_schema`; tool results →
 * `function_call_output` items.
 */
export class OpenAiLlmClient implements LlmClient {
  readonly provider = 'openai' as const;
  private readonly client: OpenAiResponsesApi;

  constructor(opts: { apiKey: string; baseURL?: string; maxRetries?: number; client?: OpenAiResponsesApi; fetch?: typeof fetch }) {
    if (!opts.apiKey && !opts.client) throw new LlmKeyError('OPENAI_API_KEY is not configured');
    this.client = opts.client ?? new OpenAI({ apiKey: opts.apiKey, ...(opts.baseURL ? { baseURL: opts.baseURL } : {}), maxRetries: opts.maxRetries ?? 2, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
  }

  async create(req: LlmRequest, opts: LlmCreateOptions = {}): Promise<LlmResponse> {
    const body = toOpenAiRequest(req);
    let res: OpenAIResponse;
    try {
      res = await this.client.responses.create(body, opts.signal ? { signal: opts.signal } : undefined);
    } catch (err) {
      throw mapOpenAiError(err);
    }
    return fromOpenAiResponse(res, req.model);
  }
}

function systemText(system: LlmRequest['system']): string | undefined {
  if (!system) return undefined;
  return typeof system === 'string' ? system : system.map((b) => b.text).join('\n\n');
}

export function toOpenAiRequest(req: LlmRequest): ResponseCreateParamsNonStreaming {
  const instructions = systemText(req.system);
  const effort = req.output_config?.effort;
  const format = req.output_config?.format;
  return {
    model: req.model,
    input: toOpenAiInput(req.messages),
    ...(instructions ? { instructions } : {}),
    max_output_tokens: req.max_tokens,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({ type: 'function' as const, name: t.name, ...(t.description ? { description: t.description } : {}), parameters: t.input_schema, strict: false })),
          ...(req.tool_choice ? { tool_choice: req.tool_choice.type } : {}),
        }
      : {}),
    ...(effort ? { reasoning: { effort } } : {}),
    ...(format ? { text: { format: { type: 'json_schema' as const, name: 'result', schema: format.schema, strict: false } } } : {}),
  };
}

export function toOpenAiInput(messages: LlmMessageParam[]): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    if (m.role === 'assistant') {
      const raw = m.content.find((b): b is OpenAiItemsBlock & { [k: string]: unknown } => b.type === 'openai_items');
      if (raw) {
        out.push(...(raw.items as unknown as ResponseInputItem[]));
        continue;
      }
      const text = m.content.filter((b): b is LlmTextBlock => b.type === 'text').map((b) => b.text).join('');
      if (text) out.push({ role: 'assistant', content: text });
      for (const b of m.content) if (b.type === 'tool_use') {
        const u = b as LlmToolUseBlock;
        out.push({ type: 'function_call', call_id: u.id, name: u.name, arguments: JSON.stringify(u.input ?? {}) });
      }
      continue;
    }
    const text: string[] = [];
    for (const b of m.content) {
      if (b.type === 'tool_result') {
        const r = b as LlmToolResultBlock;
        const content = typeof r.content === 'string' ? r.content : r.content.map((x) => x.text).join('');
        out.push({ type: 'function_call_output', call_id: r.tool_use_id, output: r.is_error ? `Error: ${content}` : content });
      } else if (b.type === 'text') text.push((b as LlmTextBlock).text);
    }
    if (text.length) out.push({ role: 'user', content: text.join('') });
  }
  return out;
}

export function fromOpenAiResponse(res: OpenAIResponse, requestedModel: string): LlmResponse {
  const content: LlmContentBlock[] = [];
  let refused = false;
  for (const item of res.output ?? []) {
    if (item.type === 'message') {
      for (const c of item.content) {
        if (c.type === 'output_text') content.push({ type: 'text', text: c.text });
        else if (c.type === 'refusal') refused = true;
      }
    } else if (item.type === 'function_call') {
      let input: unknown;
      try {
        input = item.arguments ? JSON.parse(item.arguments) : {};
      } catch {
        input = { _raw: item.arguments };
      }
      content.push({ type: 'tool_use', id: item.call_id, name: item.name, input });
    }
  }
  const hasTools = content.some((b) => b.type === 'tool_use');
  content.push({ type: 'openai_items', items: res.output ?? [] } satisfies OpenAiItemsBlock);
  const incomplete = res.status === 'incomplete' ? res.incomplete_details?.reason : null;
  const stop = refused && !hasTools ? 'refusal' : hasTools ? 'tool_use' : incomplete === 'max_output_tokens' ? 'max_tokens' : incomplete === 'content_filter' ? 'refusal' : 'end_turn';
  const cached = res.usage?.input_tokens_details?.cached_tokens ?? 0;
  return {
    id: res.id,
    model: res.model || requestedModel,
    role: 'assistant',
    content,
    stop_reason: stop,
    // Anthropic semantics: input_tokens excludes cache reads (OpenAI's includes them).
    usage: { input_tokens: Math.max(0, (res.usage?.input_tokens ?? 0) - cached), output_tokens: res.usage?.output_tokens ?? 0, cache_read_input_tokens: cached },
  };
}

export function mapOpenAiError(err: unknown): Error {
  if (err instanceof OpenAI.AuthenticationError || err instanceof OpenAI.PermissionDeniedError) return new LlmKeyError(err.message);
  if (err instanceof OpenAI.RateLimitError) {
    const ra = Number(err.headers?.get?.('retry-after'));
    return new LlmRateLimitError(err.message, Number.isFinite(ra) && ra > 0 ? ra * 1000 : null);
  }
  if (err instanceof OpenAI.APIUserAbortError) return err;
  if (err instanceof OpenAI.APIError) return new LlmError(err.message, typeof err.status === 'number' ? err.status : null);
  return err instanceof Error ? err : new LlmError(String(err));
}
