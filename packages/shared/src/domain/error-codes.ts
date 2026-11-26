/**
 * Error catalog codes (backend §11.4), shared by the data plane (`neurouter_explain_error`) and the
 * console. Templates use `{placeholder}` filled from `error_events.detail`.
 */
export const ERROR_CODES = [
  'unknown_tool',
  'not_permitted',
  'writes_disabled',
  'invalid_args',
  'policy_denied',
  'rate_limited',
  'confirmation_declined',
  'confirmation_unsupported',
  'credential_missing',
  'upstream_auth',
  'upstream_auth_required',
  'upstream_not_found',
  'upstream_conflict',
  'upstream_validation',
  'upstream_rate_limited',
  'upstream_error',
  'timeout',
  'response_too_large',
  'script_rejected',
  'script_type_error',
  'script_error',
  'script_limit',
  'executor_unavailable',
  'executor_busy',
  'kill_switch',
  'audit_unavailable',
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorCatalogEntry {
  title: string;
  explanation: string;
  howToFix: string;
}

export const ERROR_CATALOG: Record<ErrorCode, ErrorCatalogEntry> = {
  unknown_tool: { title: 'Tool not found or not permitted', explanation: 'No tool named "{tool}" is available to you in this environment.', howToFix: 'Call search_tools with what you want to do and use the exact tool name it returns.' },
  not_permitted: { title: 'Not permitted', explanation: 'Your credential lacks the scope {scope} needed for "{tool}".', howToFix: 'Call neurouter_whoami to see your scopes; ask the operator for a key with {scope}.' },
  writes_disabled: { title: 'Writes are disabled', explanation: 'Write tools are off in the {environment} environment{allowList}.', howToFix: 'Use a read-only alternative, or ask the operator to enable writes for "{tool}" in {environment}.' },
  invalid_args: { title: 'Invalid arguments', explanation: 'The arguments for "{tool}" do not match its input schema: {errors}', howToFix: 'Fix the listed fields. Expected schema fragment: {schema}' },
  policy_denied: { title: 'Blocked by policy', explanation: 'The policy "{policy}" denied this call. {message}', howToFix: 'Do not retry the same call; choose another approach or tell the user it is not allowed.' },
  rate_limited: { title: 'Rate limited', explanation: 'Too many calls from your credential{scopeDetail}.', howToFix: 'Wait {retryAfterSec}s before retrying; batch work with run_script where possible.' },
  confirmation_declined: { title: 'Confirmation declined', explanation: 'The user declined the production change "{tool}".', howToFix: 'Do not retry. Ask the user what they want instead.' },
  confirmation_unsupported: { title: 'Confirmation not possible', explanation: 'This client cannot ask the user to confirm writes in this environment, so nothing was changed.', howToFix: 'Show the user the planned change if one was returned; they can run it from a client with MCP elicitation support (protocol 2026-07-28), or in a non-production environment.' },
  credential_missing: { title: 'Upstream credential missing', explanation: 'The {environment} environment has no credential configured ({ref}).', howToFix: 'Tell the user the operator must configure the credential; retrying will not help.' },
  upstream_auth: { title: 'Upstream rejected the credential', explanation: 'The API answered {status} for "{tool}".', howToFix: 'Call neurouter_whoami; the operator may need to update the credential or grant access.' },
  upstream_auth_required: { title: 'Connect your account', explanation: 'This environment calls the API with your own account, which is not connected yet.', howToFix: 'Ask the user to open {connectUrl} and connect their account, then retry.' },
  upstream_not_found: { title: 'Not found', explanation: 'The API answered 404 for "{tool}".', howToFix: 'Check identifiers (list the parent resource first to find valid ids).' },
  upstream_conflict: { title: 'Conflict', explanation: 'The API reported a conflict: {detail}', howToFix: 'Re-read the current state and retry with updated values.' },
  upstream_validation: { title: 'Rejected by the API', explanation: 'The API rejected the request: {detail}', howToFix: 'Fix the fields the API names and retry.' },
  upstream_rate_limited: { title: 'API rate limit', explanation: 'The API answered 429.', howToFix: 'Wait {retryAfterSec}s before retrying.' },
  upstream_error: { title: 'Upstream error', explanation: 'The API failed: {detail}', howToFix: 'Retry later; if it persists, call neurouter_report_issue.' },
  timeout: { title: 'Timed out', explanation: 'The API did not answer within {timeoutMs} ms.', howToFix: 'Retry with a narrower request (filters, smaller page size).' },
  response_too_large: { title: 'Response too large', explanation: 'The API response exceeded {maxBytes} bytes.', howToFix: 'Request fewer items or use filters.' },
  script_rejected: { title: 'Script rejected', explanation: '{message} (line {line}, column {col}).', howToFix: '{hint}' },
  script_type_error: { title: 'Script type error', explanation: '{message}', howToFix: 'Check function names and keyword arguments against search_tools(format="python").' },
  script_error: { title: 'Script error', explanation: '{message}', howToFix: 'Fix the script and run it again; use mode="dry_run" first for writes.' },
  script_limit: { title: 'Script limit exceeded', explanation: '{message}', howToFix: 'Do less work per script (fewer calls, smaller results) or split it.' },
  executor_unavailable: { title: 'Code mode unavailable', explanation: 'The code-mode executor is not available.', howToFix: 'Use the API tools directly instead of run_script.' },
  executor_busy: { title: 'Code mode busy', explanation: 'All code-mode workers are busy.', howToFix: 'Retry in {retryAfterSec}s.' },
  kill_switch: { title: 'Disabled by the operator', explanation: '{target} is disabled ({kind}){reason}.', howToFix: 'Do not retry; tell the user this capability is switched off.' },
  audit_unavailable: { title: 'Audit unavailable', explanation: 'The audit log cannot accept records right now, so calls are refused.', howToFix: 'Retry in a few seconds.' },
};

/** Fills `{name}` placeholders; unknown placeholders become empty strings. */
export function fillTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k: string) => {
    const v = vars[k];
    if (v === undefined || v === null) return '';
    return typeof v === 'string' ? v : JSON.stringify(v);
  });
}
