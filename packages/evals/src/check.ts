import { JUDGE_PASS_SCORE, type Assertion, type FailureCause } from '@neurouter/shared';
import type { AssertionResult, AttemptRecord, CheckResult, EvalTask, JudgeResult, ObservedCall } from './types.js';

export const UNMET_NEED_TOOL = 'neurouter_report_unmet_need';
export const BEGIN_TASK_TOOL = 'neurouter_begin_task';
export const END_TASK_TOOL = 'neurouter_end_task';

/** Reads the attempt's mock state namespace: matching items of `resource` within `scope`. */
export type StateReader = (resource: string, scope: Record<string, string> | undefined, where: Record<string, unknown>) => Promise<unknown[]> | unknown[];

export interface CheckOptions {
  stateReader?: StateReader;
  /** Judge verdict for tasks with `judge` assertions (computed by the caller with `judgeAttempt`). */
  judge?: JudgeResult | null;
}

const isOps = (tool: string) => tool.startsWith('neurouter_');
const isMeta = (tool: string) => tool === 'search_tools' || tool === 'call_tool' || tool === 'run_script';
/** Calls that reached the API tool layer (ops and meta tools excluded). */
export function apiCalls(calls: ObservedCall[]): ObservedCall[] {
  return calls.filter((c) => !isOps(c.tool) && !isMeta(c.tool));
}
/** A write that really happened (dry runs and blocked calls are not writes). */
export function effectiveWrite(c: ObservedCall): boolean {
  return c.write && (c.decision === 'allowed' || c.decision === 'confirmed') && c.status === 'ok';
}

/** Deep subset match: every key in `expected` equals (recursively) the actual value. Numbers and numeric strings compare loosely. */
export function argsSubset(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected === 'number' && typeof actual === 'string') return String(expected) === actual;
  if (typeof expected === 'string' && typeof actual === 'number') return expected === String(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((e, i) => argsSubset(e, actual[i]));
  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    return Object.entries(expected as Record<string, unknown>).every(([k, v]) => argsSubset(v, (actual as Record<string, unknown>)[k]));
  }
  return false;
}

export function argsExact(expected: unknown, actual: unknown): boolean {
  return argsSubset(expected, actual) && argsSubset(actual, expected);
}

const DECLINE_RE = /\b(can(?:no|')t|cannot|unable|not (?:able|possible|supported|available)|no (?:tool|way|capability)|isn'?t (?:possible|supported)|don'?t have (?:a|any|the) (?:tool|way))\b/i;

function checkOne(a: Assertion, rec: AttemptRecord, opts: CheckOptions): Promise<AssertionResult> | AssertionResult {
  const r = (passed: boolean, detail: string): AssertionResult => ({ assertion: a, passed, detail });
  switch (a.type) {
    case 'called': {
      const same = rec.calls.filter((c) => c.tool === a.tool);
      const matching = a.args ? same.filter((c) => (a.argsMatch === 'exact' ? argsExact(a.args, c.arguments) : argsSubset(a.args, c.arguments))) : same;
      const ok = matching.filter((c) => c.status === 'ok' || c.decision === 'dry_run');
      const need = a.minTimes ?? 1;
      if (ok.length >= need) return r(true, `${a.tool} called ${ok.length}×`);
      if (!same.length) return r(false, `${a.tool} was never called`);
      if (!matching.length) return r(false, `${a.tool} called with other arguments: ${JSON.stringify(same[0]?.arguments ?? {}).slice(0, 300)}`);
      return r(false, `${a.tool} called ${matching.length}× but ${matching.length - ok.length} failed (${matching.map((c) => c.status).join(', ')})`);
    }
    case 'not_called': {
      const n = rec.calls.filter((c) => c.tool === a.tool).length;
      return r(n === 0, n ? `${a.tool} called ${n}×` : `${a.tool} not called`);
    }
    case 'no_writes': {
      const w = rec.calls.filter(effectiveWrite);
      return r(w.length === 0, w.length ? `writes: ${w.map((c) => c.tool).join(', ')}` : 'no writes');
    }
    case 'max_calls':
      return r(rec.toolCallsByAgent <= a.n, `${rec.toolCallsByAgent} calls (max ${a.n})`);
    case 'state':
      return (async () => {
        if (!opts.stateReader) return r(false, 'state assertions need a state reader');
        const items = await opts.stateReader(a.resource, a.scope, a.where);
        const n = items.length;
        if (a.expect === 'exists') return r(n > 0, `${n} matching ${a.resource}`);
        if (a.expect === 'absent') return r(n === 0, `${n} matching ${a.resource}`);
        return r(n === a.expect.count, `${n} matching ${a.resource} (expected ${a.expect.count})`);
      })();
    case 'answer_contains': {
      const ans = a.caseInsensitive ? rec.finalAnswer.toLowerCase() : rec.finalAnswer;
      const hit = a.anyOf.find((s) => ans.includes(a.caseInsensitive ? s.toLowerCase() : s));
      return r(hit !== undefined, hit !== undefined ? `answer contains "${hit}"` : `answer contains none of ${JSON.stringify(a.anyOf)}`);
    }
    case 'answer_matches': {
      let re: RegExp;
      try {
        re = new RegExp(a.regex, 'i');
      } catch {
        return r(false, `invalid regex ${a.regex}`);
      }
      return r(re.test(rec.finalAnswer), `answer ${re.test(rec.finalAnswer) ? 'matches' : 'does not match'} /${a.regex}/`);
    }
    case 'unmet_need_reported_or_declined': {
      const reported = rec.calls.some((c) => c.tool === UNMET_NEED_TOOL && c.status === 'ok') || rec.agentCalls.some((c) => c.name === UNMET_NEED_TOOL && !c.isError);
      const wrote = rec.calls.some(effectiveWrite);
      if (reported) return r(true, 'unmet need reported');
      if (!wrote && DECLINE_RE.test(rec.finalAnswer)) return r(true, 'declined without writing');
      return r(false, wrote ? 'wrote instead of declining' : 'neither reported nor declined');
    }
    case 'framing':
      return r(framingOk(rec), framingOk(rec) ? 'begin_task first, end_task last' : 'missing or misplaced begin_task/end_task');
    case 'judge':
      if (!opts.judge) return r(false, 'not judged');
      return r(opts.judge.verdict === 'pass' && opts.judge.score >= JUDGE_PASS_SCORE, `judge ${opts.judge.verdict} (${opts.judge.score.toFixed(2)}): ${opts.judge.reasons.join('; ')}`);
  }
}

/** begin_task before the first API call and end_task after the last one. */
export function framingOk(rec: AttemptRecord): boolean {
  const seq = rec.agentCalls.map((c) => c.name);
  const begin = seq.indexOf(BEGIN_TASK_TOOL);
  const end = seq.lastIndexOf(END_TASK_TOOL);
  if (begin < 0 || end < 0) return false;
  const apiIdx = seq.map((n, i) => (isOps(n) ? -1 : i)).filter((i) => i >= 0);
  if (!apiIdx.length) return begin < end;
  return begin < apiIdx[0]! && end > apiIdx[apiIdx.length - 1]!;
}

/** Runs every assertion; a run passes when all non-framing assertions pass (judge assertions need `opts.judge`). */
export async function checkAttempt(task: EvalTask, rec: AttemptRecord, opts: CheckOptions = {}): Promise<CheckResult> {
  const results = await Promise.all(task.assertions.map((a) => checkOne(a, rec, opts)));
  const scored = results.filter((x) => x.assertion.type !== 'framing');
  const framing = results.find((x) => x.assertion.type === 'framing');
  const hardFail = rec.endReason === 'error' || rec.endReason === 'refusal' || rec.endReason === 'cancelled';
  const passed = !hardFail && scored.every((x) => x.passed);
  const result: CheckResult = { passed, results, framingPassed: framing ? framing.passed : null, judge: opts.judge ?? null, failureCause: null };
  result.failureCause = classifyFailure(task, rec, result);
  return result;
}

/**
 * Failure cause (§15.5, first match): policy_blocked → bad_arguments → wrong_tool → hallucinated →
 * missing_capability → no_framing (only framing failed; does not fail the run) → over_budget →
 * gave_up → error. Refusals and transport errors are `error` first.
 */
export function classifyFailure(task: EvalTask, rec: AttemptRecord, check: Pick<CheckResult, 'passed' | 'results' | 'framingPassed'>): FailureCause | null {
  if (check.passed) return check.framingPassed === false ? 'no_framing' : null;
  if (rec.endReason === 'error' || rec.endReason === 'refusal' || rec.endReason === 'cancelled') return 'error';
  const failedCalled = check.results.filter((x) => !x.passed && x.assertion.type === 'called').map((x) => x.assertion as Extract<Assertion, { type: 'called' }>);
  const required = task.assertions.filter((a): a is Extract<Assertion, { type: 'called' }> => a.type === 'called');
  const api = apiCalls(rec.calls);
  if (required.some((a) => api.some((c) => c.tool === a.tool && c.decision.startsWith('denied_')))) return 'policy_blocked';
  if (failedCalled.some((a) => api.some((c) => c.tool === a.tool && (c.status === 'invalid_args' || (a.args !== undefined && !argsSubset(a.args, c.arguments)))))) return 'bad_arguments';
  if (failedCalled.some((a) => !api.some((c) => c.tool === a.tool)) && api.some((c) => !required.some((a) => a.tool === c.tool))) return 'wrong_tool';
  if (task.category === 'impossible' && (api.some(effectiveWrite) || (!DECLINE_RE.test(rec.finalAnswer) && api.some((c) => c.status === 'ok')))) return 'hallucinated';
  if (task.category !== 'impossible' && rec.calls.some((c) => c.tool === UNMET_NEED_TOOL)) return 'missing_capability';
  const nonFraming = check.results.filter((x) => x.assertion.type !== 'framing');
  if (nonFraming.every((x) => x.passed) && check.framingPassed === false) return 'no_framing';
  if (rec.endReason === 'over_budget' || rec.endReason === 'max_turns' || rec.endReason === 'max_tool_calls' || rec.endReason === 'timeout' || rec.endReason === 'max_tokens') return 'over_budget';
  if (rec.endReason === 'end_turn') return 'gave_up';
  return 'error';
}

/** The tool a failure is about: the expected tool of a failed `called` assertion, else the wrongly called tool. */
export function primaryTool(task: EvalTask, rec: AttemptRecord, check: Pick<CheckResult, 'results'>): string | null {
  const failed = check.results.find((x) => !x.passed && x.assertion.type === 'called');
  if (failed) return (failed.assertion as { tool: string }).tool;
  const expected = new Set(task.assertions.flatMap((a) => (a.type === 'called' ? [a.tool] : [])));
  const wrong = apiCalls(rec.calls).find((c) => !expected.has(c.tool));
  return wrong?.tool ?? task.referenceCalls[0]?.tool ?? null;
}
