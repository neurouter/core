import { JUDGE_PASS_SCORE, type Assertion, type FailureCause } from '@neurouter/shared';
import { isIncidentalArg, runawayCeiling, upstreamCalls } from './budget.js';
import { groundTruthForCalls, hasWildcard, isFromRef, parseGroundTruthPath, resolveArgs, resolvePath, type GroundTruth } from './groundtruth.js';
import { answerHas, type MatchHow } from './normalize.js';
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
  /** The task's ground truth (reference outcomes on the attempt's mock seed). */
  groundTruth?: GroundTruth | null;
  /** Equivalence judge verdicts for failed `answer_contains` assertions, by assertion index. */
  equivalence?: Record<number, { equivalent: boolean; reason: string }> | null;
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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

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

/**
 * Normalized argument match (required arguments, 0.2.2): subset; strings case- and space-insensitive
 * (`Hello-World` = `hello-world`); numbers, numeric strings and booleans by value; arrays as sets
 * (every expected element present); an unresolved `{"$from"}` matches anything (no ground truth).
 */
export function argsMatchNormalized(expected: unknown, actual: unknown): boolean {
  if (isFromRef(expected)) return true;
  if (expected === actual) return true;
  if (expected === null || expected === undefined) return actual === null || actual === undefined;
  const scalar = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
  if (scalar(expected) && scalar(actual)) {
    const a = String(expected).trim().toLowerCase();
    const b = String(actual).trim().toLowerCase();
    if (a === b) return true;
    return a !== '' && b !== '' && Number.isFinite(Number(a)) && Number(a) === Number(b);
  }
  if (Array.isArray(expected)) {
    const act = Array.isArray(actual) ? actual : typeof actual === 'string' ? actual.split(',').map((x) => x.trim()) : [actual];
    return expected.every((e) => act.some((x) => argsMatchNormalized(e, x)));
  }
  if (scalar(expected) && Array.isArray(actual)) return actual.length === 1 && argsMatchNormalized(expected, actual[0]);
  if (isRecord(expected)) {
    if (!isRecord(actual)) return false;
    return Object.entries(expected).every(([k, v]) => argsMatchNormalized(v, actual[k]));
  }
  return false;
}

/** The required arguments of a `called` assertion: `$from` resolved, paging arguments dropped. */
export function requiredArgs(args: Record<string, unknown>, gt: GroundTruth | null | undefined): Record<string, unknown> {
  return Object.fromEntries(Object.entries(resolveArgs(args, gt)).filter(([k]) => !isIncidentalArg(k)));
}

const REDACTED = (v: unknown) => isRecord(v) && typeof v.$redacted === 'string';
function hasRedacted(v: unknown): boolean {
  if (REDACTED(v)) return true;
  if (Array.isArray(v)) return v.some(hasRedacted);
  return isRecord(v) && Object.values(v).some(hasRedacted);
}

const DECLINE_RE = /\b(can(?:no|')t|cannot|unable|not (?:able|possible|supported|available)|no (?:tool|way|capability)|isn'?t (?:possible|supported)|don'?t have (?:a|any|the) (?:tool|way))\b/i;

function checkOne(a: Assertion, idx: number, rec: AttemptRecord, opts: CheckOptions, gt: GroundTruth | null): Promise<AssertionResult> | AssertionResult {
  const r = (passed: boolean, detail: string, extra: Partial<AssertionResult> = {}): AssertionResult => ({ assertion: a, passed, detail, ...extra });
  switch (a.type) {
    case 'called': {
      const names = [a.tool, ...(a.anyOf ?? []).map((x) => x.tool)];
      const label = names.length > 1 ? `${a.tool} (or ${names.slice(1).join(', ')})` : a.tool;
      const same = rec.calls.filter((c) => names.includes(c.tool));
      const want = a.args ? requiredArgs(a.args, gt) : null;
      const matching = want ? same.filter((c) => (a.argsMatch === 'exact' ? argsExact(want, c.arguments) : argsMatchNormalized(want, c.arguments))) : same;
      const ok = matching.filter((c) => c.status === 'ok' || c.decision === 'dry_run');
      const need = a.minTimes ?? 1;
      if (ok.length >= need) return r(true, `${label} called ${ok.length}×${want && Object.keys(want).length ? ` with ${JSON.stringify(want).slice(0, 200)}` : ''}`);
      if (!same.length) return r(false, `${label} was never called`);
      if (!matching.length) {
        const redacted = same.some((c) => hasRedacted(c.arguments));
        return r(false, `${label} called with other arguments: ${JSON.stringify(same[0]?.arguments ?? {}).slice(0, 300)} (required ${JSON.stringify(want).slice(0, 200)})${redacted ? '; the recorded arguments are redacted' : ''}`);
      }
      return r(false, `${label} called ${matching.length}× but ${matching.length - ok.length} failed (${matching.map((c) => c.status).join(', ')})`);
    }
    case 'not_called': {
      const n = rec.calls.filter((c) => c.tool === a.tool).length;
      return r(n === 0, n ? `${a.tool} called ${n}×` : `${a.tool} not called`);
    }
    case 'no_writes': {
      const w = rec.calls.filter(effectiveWrite);
      return r(w.length === 0, w.length ? `writes: ${w.map((c) => c.tool).join(', ')}` : 'no writes');
    }
    case 'max_calls': {
      const n = upstreamCalls(rec);
      const strict = a.hard === true || a.n === 0;
      const ceiling = strict ? a.n : runawayCeiling(a.n);
      if (n <= a.n) return r(true, `${n} upstream calls (budget ${a.n})`);
      if (n <= ceiling) return r(true, `${n} upstream calls, over the budget of ${a.n} (efficiency, not a failure)`, { overBudget: true });
      return r(false, strict ? `${n} upstream calls (at most ${a.n} allowed)` : `${n} upstream calls: beyond ${ceiling} (budget ${a.n}), a runaway`, { overBudget: true });
    }
    case 'state':
      return (async () => {
        if (!opts.stateReader) return r(false, 'state assertions need a state reader');
        const items = await opts.stateReader(a.resource, a.scope, a.where);
        const n = items.length;
        if (a.expect === 'exists') return r(n > 0, `${n} matching ${a.resource}`);
        if (a.expect === 'absent') return r(n === 0, `${n} matching ${a.resource}`);
        return r(n === a.expect.count, `${n} matching ${a.resource} (expected ${a.expect.count})`);
      })();
    case 'answer_contains':
      return checkAnswer(a, idx, rec, opts, gt);
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
      if (rec.framingAvailable === false) return r(true, 'n/a: the server does not offer begin/end task framing (contract 2)');
      return r(framingOk(rec), framingOk(rec) ? 'begin_task first, end_task last' : 'missing or misplaced begin_task/end_task');
    case 'judge':
      if (!opts.judge) return r(false, 'not judged');
      return r(opts.judge.verdict === 'pass' && opts.judge.score >= JUDGE_PASS_SCORE, `judge ${opts.judge.verdict} (${opts.judge.score.toFixed(2)}): ${opts.judge.reasons.join('; ')}`);
  }
}

/** Scalars of a ground-truth value (arrays flattened; objects skipped). */
function scalars(vs: unknown[]): Array<string | number | boolean> {
  const out: Array<string | number | boolean> = [];
  for (const v of vs) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out.push(v);
    else if (Array.isArray(v)) out.push(...scalars(v));
  }
  return out;
}

/** The field a path ends in (`ref[0].data.valid` → `valid`) and whether it sits next to a `currency` (minor units). */
function fieldOf(path: string, gt: GroundTruth): { field: string | null; minor: boolean } {
  const p = parseGroundTruthPath(path);
  const last = p?.segs.filter((s) => 'key' in s).pop() as { key: string } | undefined;
  const field = last?.key ?? null;
  let minor = false;
  if (field && /amount|price|total|balance|fee|cost/.test(field)) {
    const parent = path.slice(0, path.lastIndexOf('.'));
    const sib = resolvePath(gt, `${parent}.currency`);
    minor = sib.length > 0;
  }
  return { field, minor };
}

/** answer_contains: ground-truth values (or literal hints), normalized, then the equivalence judge. */
function checkAnswer(a: Extract<Assertion, { type: 'answer_contains' }>, idx: number, rec: AttemptRecord, opts: CheckOptions, gt: GroundTruth | null): AssertionResult {
  const r = (passed: boolean, detail: string, extra: Partial<AssertionResult> = {}): AssertionResult => ({ assertion: a, passed, detail, ...extra });
  const answer = rec.finalAnswer;
  const literalOnly = a.normalize === false || a.caseInsensitive !== undefined;
  type Exp = { value: unknown; field: string | null; minor: boolean };
  let expected: Exp[] = [];
  let source = 'hint';
  if (a.from && gt) {
    for (const path of Array.isArray(a.from) ? a.from : [a.from]) {
      const { field, minor } = fieldOf(path, gt);
      for (const v of scalars(resolvePath(gt, path))) expected.push({ value: v, field, minor });
    }
    source = 'ground truth';
  }
  if (!expected.length) {
    if (!a.anyOf?.length) return r(false, a.from ? `ground truth for ${JSON.stringify(a.from)} is unavailable` : 'answer_contains needs anyOf or from');
    expected = a.anyOf.map((v) => ({ value: v, field: null, minor: false }));
    source = a.from ? 'hint (ground truth unavailable)' : 'literal';
  }
  const mode = a.match ?? (source === 'ground truth' && a.from && hasWildcard(a.from) ? 'all' : 'any');
  const hows: Array<MatchHow | null> = expected.map((e) => {
    if (literalOnly) {
      const ans = a.caseInsensitive ? answer.toLowerCase() : answer;
      const s = String(e.value);
      return ans.includes(a.caseInsensitive ? s.toLowerCase() : s) ? 'literal' : null;
    }
    return answerHas(answer, e.value, { field: e.field, minorUnits: e.minor, ...(a.kind ? { kind: a.kind } : {}) }).how;
  });
  const found = expected.filter((_, i) => hows[i] !== null);
  const missing = expected.filter((_, i) => hows[i] === null).map((e) => e.value);
  const passed = mode === 'all' ? missing.length === 0 : found.length > 0;
  const show = (vs: unknown[]) => JSON.stringify(vs.slice(0, 8)).slice(0, 240) + (vs.length > 8 ? ` (+${vs.length - 8})` : '');
  if (passed) {
    const how: MatchHow = hows.some((h) => h === 'normalized') ? 'normalized' : 'literal';
    return r(true, `answer states ${show(found.map((e) => e.value))} (${source}, ${how})`, { matchedBy: how });
  }
  const eq = opts.equivalence?.[idx];
  if (eq?.equivalent && !literalOnly) return r(true, `judge: equivalent to ${show(expected.map((e) => e.value))} (${eq.reason})`, { matchedBy: 'judge' });
  return r(false, `answer ${mode === 'all' ? 'misses' : 'states none of'} ${show(mode === 'all' ? missing : expected.map((e) => e.value))} (${source})${eq ? `; judge: ${eq.reason}` : ''}`);
}

/** Expected values of the failed answer checks (input of the equivalence judge), by assertion index. */
export function failedAnswerExpectations(task: EvalTask, check: Pick<CheckResult, 'results'>, gt: GroundTruth | null): Array<{ index: number; expected: unknown[]; field: string | null }> {
  const out: Array<{ index: number; expected: unknown[]; field: string | null }> = [];
  task.assertions.forEach((a, i) => {
    if (a.type !== 'answer_contains' || check.results[i]?.passed || a.normalize === false) return;
    let vals: unknown[] = [];
    let field: string | null = null;
    if (a.from && gt) for (const p of Array.isArray(a.from) ? a.from : [a.from]) {
      vals.push(...scalars(resolvePath(gt, p)));
      field = fieldOf(p, gt).field;
    }
    if (!vals.length) vals = a.anyOf ?? [];
    if (vals.length) out.push({ index: i, expected: vals.slice(0, 40), field });
  });
  return out;
}

/**
 * Calls that count against `max_calls`: the agent's non-ops calls minus discovery (`search_tools`).
 * The task's budget is written against the reference calls, but code mode (and tool mode with
 * discovery=search) exposes only search_tools + run_script / call_tool and the server instructions
 * tell the agent to get signatures with search_tools first, so counting discovery would fail every
 * code-mode attempt that follows them (search_tools + one run_script = 2 > max 1).
 */
export function workCalls(rec: Pick<AttemptRecord, 'toolCallsByAgent' | 'agentCalls'>): number {
  return Math.max(0, rec.toolCallsByAgent - rec.agentCalls.filter((c) => c.name === 'search_tools').length);
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

/**
 * Runs every assertion; a run passes when all non-framing assertions pass (judge assertions need `opts.judge`).
 * Assertions read the ground truth as the agent's path saw it (an equivalent tool's outcome when the agent used it).
 */
export async function checkAttempt(task: EvalTask, rec: AttemptRecord, opts: CheckOptions = {}): Promise<CheckResult> {
  const gt = opts.groundTruth ? groundTruthForCalls(opts.groundTruth, task.referenceCalls, rec.calls) : null;
  const results = await Promise.all(task.assertions.map((a, i) => checkOne(a, i, rec, opts, gt)));
  const scored = results.filter((x) => x.assertion.type !== 'framing');
  const framing = results.find((x) => x.assertion.type === 'framing');
  const hardFail = rec.endReason === 'error' || rec.endReason === 'refusal' || rec.endReason === 'cancelled';
  const passed = !hardFail && scored.every((x) => x.passed);
  const budget = task.assertions.find((a): a is Extract<Assertion, { type: 'max_calls' }> => a.type === 'max_calls');
  const result: CheckResult = {
    passed,
    results,
    framingPassed: framing && rec.framingAvailable !== false ? framing.passed : null,
    judge: opts.judge ?? null,
    failureCause: null,
    upstreamCalls: upstreamCalls(rec),
    callBudget: budget?.n ?? null,
    overBudget: results.some((x) => x.overBudget === true),
  };
  result.failureCause = classifyFailure(task, rec, result);
  return result;
}

const REFUSAL_RE = /\b(content[ _-]?(policy|filter|management)|safety (system|filter)|flagged|invalid_prompt|usage polic(y|ies)|responsible ai|blocked by (the )?(provider|policy)|refus(ed|al))\b/i;

/** The model provider refused the request (stop reason `refusal`, or a policy-filter error): not the agent's failure. */
export function isProviderRefusal(rec: Pick<AttemptRecord, 'endReason' | 'error'>): boolean {
  return rec.endReason === 'refusal' || (rec.endReason === 'error' && REFUSAL_RE.test(rec.error ?? ''));
}

/**
 * Failure cause (§15.5, first match): policy_blocked → bad_arguments → wrong_tool → hallucinated →
 * missing_capability → no_framing (only framing failed; does not fail the run) → over_budget (incl.
 * a finished attempt whose only misses are max_calls) →
 * gave_up → error. A provider refusal (policy filter) is `provider_refusal` first (excluded from
 * scoring), other refusals and transport errors `error`.
 */
export function classifyFailure(task: EvalTask, rec: AttemptRecord, check: Pick<CheckResult, 'passed' | 'results' | 'framingPassed'>): FailureCause | null {
  if (check.passed) return check.framingPassed === false ? 'no_framing' : null;
  if (isProviderRefusal(rec)) return 'provider_refusal';
  if (rec.endReason === 'error' || rec.endReason === 'refusal' || rec.endReason === 'cancelled') return 'error';
  const failedCalled = check.results.filter((x) => !x.passed && x.assertion.type === 'called').map((x) => x.assertion as Extract<Assertion, { type: 'called' }>);
  const required = task.assertions.filter((a): a is Extract<Assertion, { type: 'called' }> => a.type === 'called');
  const namesOf = (a: Extract<Assertion, { type: 'called' }>) => [a.tool, ...(a.anyOf ?? []).map((x) => x.tool)];
  const api = apiCalls(rec.calls);
  if (required.some((a) => api.some((c) => namesOf(a).includes(c.tool) && c.decision.startsWith('denied_')))) return 'policy_blocked';
  if (failedCalled.some((a) => api.some((c) => namesOf(a).includes(c.tool) && (c.status === 'invalid_args' || (a.args !== undefined && !argsMatchNormalized(requiredArgs(a.args, null), c.arguments)))))) return 'bad_arguments';
  if (failedCalled.some((a) => !api.some((c) => namesOf(a).includes(c.tool))) && api.some((c) => !required.some((a) => namesOf(a).includes(c.tool)))) return 'wrong_tool';
  if (task.category === 'impossible' && (api.some(effectiveWrite) || (!DECLINE_RE.test(rec.finalAnswer) && api.some((c) => c.status === 'ok')))) return 'hallucinated';
  if (task.category !== 'impossible' && rec.calls.some((c) => c.tool === UNMET_NEED_TOOL)) return 'missing_capability';
  const nonFraming = check.results.filter((x) => x.assertion.type !== 'framing');
  if (nonFraming.every((x) => x.passed) && check.framingPassed === false) return 'no_framing';
  // the agent finished, and the only misses are call budgets: inefficient, not given up
  if (rec.endReason === 'end_turn' && nonFraming.some((x) => !x.passed) && nonFraming.every((x) => x.passed || x.assertion.type === 'max_calls')) return 'over_budget';
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
