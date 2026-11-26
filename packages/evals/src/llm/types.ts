/**
 * The subset of the Anthropic Messages API the evals use, as a provider-neutral interface so the
 * runner, generator and judge are testable with fake and stub clients. Shapes mirror
 * `@anthropic-ai/sdk` 1.14.0 (`Anthropic.MessageCreateParams`, `Anthropic.Message`).
 */

export type LlmTextBlock = { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } };
export type LlmToolUseBlock = { type: 'tool_use'; id: string; name: string; input: unknown };
export type LlmToolResultBlock = { type: 'tool_result'; tool_use_id: string; content: string | LlmTextBlock[]; is_error?: boolean };
export type LlmContentBlock = LlmTextBlock | LlmToolUseBlock | { type: string; [k: string]: unknown };

export interface LlmMessageParam {
  role: 'user' | 'assistant';
  content: string | Array<LlmTextBlock | LlmToolUseBlock | LlmToolResultBlock | { type: string; [k: string]: unknown }>;
}

export interface LlmTool {
  name: string;
  description?: string;
  input_schema: Record<string, unknown>;
}

export interface LlmRequest {
  model: string;
  max_tokens: number;
  system?: string | LlmTextBlock[];
  messages: LlmMessageParam[];
  tools?: LlmTool[];
  tool_choice?: { type: 'auto' } | { type: 'none' };
  output_config?: { effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; format?: { type: 'json_schema'; schema: Record<string, unknown> } };
  cache_control?: { type: 'ephemeral' };
  metadata?: { user_id?: string };
  /** Beta: server-side refusal fallbacks (`server-side-fallback-2026-07-01`). Sent through the beta endpoint. */
  fallbacks?: 'default';
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  iterations?: Array<{ type: string; model?: string; input_tokens?: number; output_tokens?: number }> | null;
}

export interface LlmResponse {
  id: string;
  model: string;
  role: 'assistant';
  content: LlmContentBlock[];
  stop_reason: string | null;
  usage: LlmUsage;
}

export interface LlmCreateOptions {
  signal?: AbortSignal;
  /** Beta headers; non-empty → the beta endpoint (`client.beta.messages.create`). */
  betas?: string[];
}

export interface LlmClient {
  /** `anthropic` | `stub` | `fake` — reported so a stub is never mistaken for a real model. */
  readonly provider: 'anthropic' | 'stub' | 'fake' | 'scripted';
  create(req: LlmRequest, opts?: LlmCreateOptions): Promise<LlmResponse>;
}

export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/** Typed errors raised by every LlmClient. */
export class LlmError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
    this.name = 'LlmError';
  }
}
/** Missing or invalid API key (→ problem `llm_key_missing`). Fails the whole run. */
export class LlmKeyError extends LlmError {
  constructor(message = 'Anthropic API key missing or invalid') {
    super(message, 401);
    this.name = 'LlmKeyError';
  }
}
export class LlmRateLimitError extends LlmError {
  constructor(message: string, readonly retryAfterMs: number | null = null) {
    super(message, 429);
    this.name = 'LlmRateLimitError';
  }
}

export function textOf(res: LlmResponse): string {
  return res.content
    .filter((b): b is LlmTextBlock => b.type === 'text' && typeof (b as LlmTextBlock).text === 'string')
    .map((b) => b.text)
    .join('');
}

export function fallbackUsed(res: LlmResponse): boolean {
  return (res.usage.iterations ?? []).some((i) => i.type === 'fallback_message');
}

/** Parses the first JSON object in a text answer (structured outputs return the JSON as text). */
export function parseJsonText(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const start = t.indexOf('{');
    const end = t.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw new LlmError('model did not return JSON');
  }
}
