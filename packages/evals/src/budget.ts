/**
 * Call budgets (efficiency, not correctness). A task's budget is derived from its reference path:
 * `max(MIN_CALL_BUDGET, ceil(2 × reference upstream calls) + 2 per paginated reference call)`.
 * Only upstream API calls count: inner `run_script` calls do, `search_tools`, `run_script` itself,
 * ops tools (`neurouter_*`, incl. read_result and begin/end task) and calls rejected before the
 * upstream (`invalid_args`) do not. An attempt over budget still passes (reported as over budget);
 * one beyond `runawayCeiling(n)` fails as `over_budget`. `n: 0` and `hard` budgets are strict.
 */
import type { ReferenceCall } from '@neurouter/shared';
import type { AttemptRecord } from './types.js';

export const MIN_CALL_BUDGET = 3;
export const PAGINATION_ALLOWANCE = 2;

/** Arguments that page, size or expand a result: never pinned by `called` assertions. */
export const INCIDENTAL_ARGS = new Set(['per_page', 'page', 'limit', 'page_size', 'pagesize', 'pagelimit', 'starting_after', 'ending_before', 'cursor', 'after', 'before', 'offset', 'page_token', 'next_token', 'continuation_token', 'expand', 'include_total_count', 'count']);

export function isIncidentalArg(name: string): boolean {
  return INCIDENTAL_ARGS.has(name.toLowerCase());
}

/** The arguments without the incidental (paging) ones. */
export function withoutIncidental(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([k]) => !isIncidentalArg(k)));
}

const PAGING = ['per_page', 'page', 'limit', 'page_size', 'starting_after', 'cursor', 'page_token', 'offset', 'after'];

/** Whether a tool pages its results (has a paging parameter). */
export function isPaginated(inputSchema: Record<string, unknown> | undefined, args?: Record<string, unknown>): boolean {
  const props = inputSchema && typeof inputSchema.properties === 'object' && inputSchema.properties ? Object.keys(inputSchema.properties) : [];
  if (props.length) return props.some((p) => PAGING.includes(p.toLowerCase()));
  return Object.keys(args ?? {}).some((k) => PAGING.includes(k.toLowerCase()));
}

/** `max(MIN_CALL_BUDGET, ceil(2 × upstream reference calls) + PAGINATION_ALLOWANCE × paginated ones)`. */
export function deriveCallBudget(refs: Pick<ReferenceCall, 'tool' | 'arguments'>[], schemaOf?: (tool: string) => Record<string, unknown> | undefined): number {
  const paginated = refs.filter((r) => isPaginated(schemaOf?.(r.tool), r.arguments)).length;
  return Math.max(MIN_CALL_BUDGET, Math.ceil(2 * refs.length) + PAGINATION_ALLOWANCE * paginated);
}

/** Beyond this many upstream calls a soft budget of `n` fails (a runaway loop, not inefficiency). */
export function runawayCeiling(n: number): number {
  return Math.max(10, 4 * n);
}

const isOps = (t: string) => t.startsWith('neurouter_');
const isMeta = (t: string) => t === 'search_tools' || t === 'call_tool' || t === 'run_script';

/** Upstream API calls of an attempt (see the module comment). */
export function upstreamCalls(rec: Pick<AttemptRecord, 'calls'>): number {
  return rec.calls.filter((c) => !isOps(c.tool) && !isMeta(c.tool) && c.status !== 'invalid_args').length;
}
