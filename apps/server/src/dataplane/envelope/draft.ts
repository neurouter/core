import type { ErrorCode, ToolDef } from '@neurouter/shared';
import type { Call, EnvelopeErrorCode, ErrorInfo, Page, Retry, StateFlag, Truncated } from './types.js';

/** One structured argument-validation failure (from Ajv). */
export interface ArgIssue {
  /** instance path, `/status` or `/items/0/sku` ('' = root) */
  path: string;
  keyword: string;
  params: Record<string, unknown>;
  message: string;
}

/**
 * What a producer knows about a failure. The error builder turns it into the agent-facing `ErrorInfo`
 * (code mapping, Neurouter-authored message, fields, retry, next calls, closest, upstream excerpt).
 */
export interface ErrorSpec {
  /** v1 catalog code (mapped by the builder) or a contract-2 code */
  code: ErrorCode | EnvelopeErrorCode;
  /** the v1 message (fallback text) */
  message: string;
  /** a contract-2 message authored by the producer (≤ 200 chars) */
  text?: string;
  errorId?: string | null;
  retryAfterMs?: number;
  retry?: Retry;
  /** the tool the failure is about, and the name/arguments as the agent sent them */
  tool?: ToolDef | null;
  name?: string;
  args?: Record<string, unknown>;
  /** upstream status + body (moved into the marked `upstream` field, never into the message) */
  upstream?: { status: number; body: unknown };
  issues?: ArgIssue[];
  line?: number;
  /** producer-provided next calls / closest names (override the derived ones) */
  next?: Call[];
  closest?: string[];
  /** an already built error (a tool error raised inside a script): used as is, plus `line` */
  info?: ErrorInfo;
}

/**
 * A producer's answer in contract-neutral form. Every producer (pipeline, ops, search, call_tool, run_script,
 * composites) returns one next to its v1 result; the renderer turns it into the envelope for contract 2.
 */
export interface Draft {
  ok: boolean;
  data?: unknown;
  page?: Page | null;
  truncated?: Truncated | null;
  error?: ErrorSpec;
  hint?: string;
  flags?: StateFlag[];
  flagPaths?: string[];
  /** a write was executed: `"<tool> → <entity label>"` */
  wrote?: string;
  /** the call wrote or tried to write (state is shown in full) without an API write tool behind it (scripts) */
  write?: boolean;
  left?: { calls?: number; seconds?: number };
  scriptCalls?: number;
  /** contract-2 `_meta` (call id, task id, script run id) */
  meta?: Record<string, unknown>;
}

export const okDraft = (data: unknown, extra: Omit<Draft, 'ok' | 'data'> = {}): Draft => ({ ok: true, data, ...extra });
export const errorDraft = (error: ErrorSpec, extra: Omit<Draft, 'ok' | 'error'> = {}): Draft => ({ ok: false, error, ...extra });

/** A result in both renderings: the v1 result (byte-identical to 0.2.x) and the contract-neutral draft. */
export interface Reply<R> {
  result: R;
  draft: Draft;
}
