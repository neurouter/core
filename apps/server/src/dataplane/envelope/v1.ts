import { META_ERROR_ID, META_NEXT_TOOLS, META_RETRY_AFTER_MS, type ErrorCode } from '@neurouter/shared';

/**
 * Contract v1 result builders (the 0.2.x response shapes, kept byte-identical for v1 sessions). Together
 * with `render.ts` (contract 2) this module is the only place that builds an MCP tool result: the
 * `no-raw-tool-result` lint rule and the bypass test enforce it.
 */

export interface McpToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface ToolErrorResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  structuredContent?: Record<string, unknown>;
  _meta: Record<string, unknown>;
}

/** Placeholder result next to an MRTR `input_required` answer (never sent). */
export const NO_RESULT: McpToolResult = Object.freeze({ content: [] }) as McpToolResult;

/** One text block (+ structuredContent / `_meta` / isError when given), in that key order. */
export function v1Result(text: string, structured?: Record<string, unknown>, meta?: Record<string, unknown>, isError = false): McpToolResult {
  return { content: [{ type: 'text', text }], ...(structured ? { structuredContent: structured } : {}), ...(isError ? { isError: true } : {}), ...(meta ? { _meta: meta } : {}) };
}

/** Hints at the moment of need (§11.3). */
export function hintsFor(code: ErrorCode): string[] {
  const out = ['neurouter_explain_error'];
  if (['not_permitted', 'writes_disabled', 'unknown_tool', 'upstream_auth'].includes(code)) out.push('neurouter_whoami');
  return out;
}

/** MCP error result (`isError: true`, not a JSON-RPC error) carrying error_id + next-tools (§9.6, §11.3). */
export function errorResult(message: string, errorId: string | null, code: ErrorCode, extra: { retryAfterMs?: number; nextTools?: string[]; meta?: Record<string, unknown> } = {}): ToolErrorResult {
  const next = [...new Set([...(extra.nextTools ?? []), ...hintsFor(code)])];
  const suffix = errorId ? ` (error_id=${errorId}; call neurouter_explain_error for how to fix)` : '';
  const meta: Record<string, unknown> = { [META_NEXT_TOOLS]: next, ...(extra.meta ?? {}) };
  if (errorId) meta[META_ERROR_ID] = errorId;
  if (extra.retryAfterMs !== undefined) meta[META_RETRY_AFTER_MS] = extra.retryAfterMs;
  return { content: [{ type: 'text', text: `${message}${suffix}` }], isError: true, structuredContent: { error: { code, message, ...(errorId ? { error_id: errorId } : {}) } }, _meta: meta };
}

/** Appends a text block (v1 one-time tips). */
export function withExtraText(r: McpToolResult, text: string, meta: Record<string, unknown>): McpToolResult {
  return { ...r, content: [...r.content, { type: 'text', text }], _meta: meta };
}
