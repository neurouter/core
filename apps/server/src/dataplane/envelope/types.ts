/**
 * Agent contract v2 (contract-v2.md §2): one envelope for every `tools/call` result. Key order is fixed:
 * `ok, data, page, truncated, error, state[, hint]`. Neurouter-authored keys are snake_case; `data` keeps
 * the upstream's shape and casing.
 */

/** An exact call the agent can make next. */
export interface Call {
  tool: string;
  args: Record<string, unknown>;
}

export interface Page {
  /** items in this response (0 allowed) */
  count: number;
  /** when known (upstream total or Neurouter-held full result) */
  total: number | null;
  /** always explicit */
  has_more: boolean;
  /** opaque; P2 fills it (pass as `cursor` to the same tool). Until then null, and `truncated.next` fetches Neurouter cuts. */
  next_cursor: string | null;
  /** effective filters incl. defaults; set when count = 0 or Neurouter cut the list */
  scope?: Record<string, unknown>;
}

export interface Truncated {
  items_omitted?: number;
  /** dotted paths whose values were clipped or dropped */
  fields?: string[];
  omitted_bytes: number;
  /** the exact call that returns the omitted part */
  next: Call;
}

/** contract-v2 §2.3 error codes (the v1 catalog codes, renamed for agents). */
export const ENVELOPE_ERROR_CODES = [
  'not_found',
  'invalid_args',
  'unknown_tool',
  'forbidden',
  'writes_disabled',
  'policy_denied',
  'rate_limited',
  'confirmation_required',
  'confirmation_declined',
  'confirmation_unsupported',
  'upstream_auth',
  'upstream_conflict',
  'upstream_rejected',
  'upstream_error',
  'timeout',
  'too_large',
  'script_error',
  'limit_exceeded',
  'unavailable',
] as const;
export type EnvelopeErrorCode = (typeof ENVELOPE_ERROR_CODES)[number];

export type Retry = 'no' | 'after_fix' | 'after_wait' | 'yes';

export interface FieldIssue {
  field: string;
  received?: unknown;
  allowed?: unknown[] | string;
  problem: string;
}

export interface ErrorInfo {
  code: EnvelopeErrorCode;
  /** Neurouter-authored, ≤ 200 chars; says what failed and that nothing changed when true */
  message: string;
  fields?: FieldIssue[];
  retry: Retry;
  retry_after_ms?: number;
  /** ≥ 1 exact next call when any valid one exists */
  next: Call[];
  /** nearest tool names / enum values / ids (≤ 5) */
  closest?: string[];
  /** upstream excerpt (≤ 300 chars, redacted): untrusted content */
  upstream?: { status: number; detail: string };
  error_id?: string;
  /** run_script only */
  line?: number;
}

export type StateFlag = 'instruction_like_text' | 'prod' | 'dry_run' | 'schema_mismatch';

export interface State {
  env?: string;
  writes?: 'off' | 'on' | 'confirm';
  task: string;
  call: number;
  streak?: number;
  left?: { calls?: number; seconds?: number };
  wrote?: string;
  /** run_script: tool calls the script made */
  script_calls?: number;
  flags?: StateFlag[];
  flag_paths?: string[];
}

export interface Envelope {
  ok: boolean;
  data: unknown;
  page: Page | null;
  truncated: Truncated | null;
  error: ErrorInfo | null;
  state: State;
  hint?: string;
}

/** Size budgets (contract-v2 §7): characters ÷ 4 ≈ tokens. */
export const BUDGET = { stateChars: 200, errorChars: 600, hintChars: 200, messageChars: 200, upstreamChars: 300 } as const;
