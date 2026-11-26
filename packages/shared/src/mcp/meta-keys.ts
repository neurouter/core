/** `_meta` keys defined by Neurouter (backend §9.5). */
export const META_PREFIX = 'dev.neurouter/';
// request
export const META_TASK_ID = 'dev.neurouter/task-id';
export const META_TRACEPARENT = 'traceparent';
export const META_TRACESTATE = 'tracestate';
// tools/list
export const META_WRITE = 'dev.neurouter/write';
export const META_WRITES_ENABLED = 'dev.neurouter/writes-enabled';
export const META_CONFIRM = 'dev.neurouter/confirm';
export const META_DEF_HASH = 'dev.neurouter/def-hash';
export const META_DEFER_LOADING = 'dev.neurouter/defer_loading';
// results
export const META_ERROR_ID = 'dev.neurouter/error-id';
export const META_NEXT_TOOLS = 'dev.neurouter/next-tools';
export const META_RETRY_AFTER_MS = 'dev.neurouter/retry-after-ms';
export const META_RESULT_HANDLE = 'dev.neurouter/result-handle';
export const META_TRUNCATED = 'dev.neurouter/truncated';
export const META_DRY_RUN = 'dev.neurouter/dry-run';
export const META_UNTRUSTED = 'dev.neurouter/untrusted-content';
export const META_CALL_ID = 'dev.neurouter/call-id';
export const META_GRAPHQL_ERRORS = 'dev.neurouter/graphql-errors';
export const META_UPSTREAM_HEADERS = 'dev.neurouter/upstream-headers';

/** Eval-only request headers (honoured only for `purpose = 'eval'` keys). */
export const HEADER_MOCK_STATE = 'x-neurouter-mock-state';
export const HEADER_EXPOSURE = 'x-neurouter-exposure';
