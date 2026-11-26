/**
 * Calibration gate: before a suite is accepted (generation, `eval --suite`), each task's own
 * reference solution runs through its assertions against the mock. A task whose reference fails
 * (a reference call errors, an expected value resolves to nothing, a deterministic assertion fails
 * on the reference path) is rejected with the reasons; it is never run or scored. Judge assertions
 * are not run here (they need a model); `--calibrate-with <model>` adds one model pass that flags
 * tasks whose answers disagree with the ground truth for human review.
 */
import type { Assertion } from '@neurouter/shared';
import { BEGIN_TASK_TOOL, checkAttempt, END_TASK_TOOL, UNMET_NEED_TOOL, type StateReader } from './check.js';
import { formatGroundTruthPath, groundTruthPreview, resolveArgs, resolvePath, type GroundTruth } from './groundtruth.js';
import type { AgentCall, AttemptRecord, EvalTask, ObservedCall, SuiteCalibration, TaskCalibration } from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const scalar = (v: unknown): v is string | number | boolean => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/**
 * Concrete paths (`ref[0].data.data[3].id`) of every scalar in the ground truth equal to `literal`
 * (`substring`: string values containing it, for literals the generator cut out of a longer value).
 * Ranked: field names mentioned in `hint` (the prompt and rubric: "whether it is valid" → `valid`),
 * then the least nested, then earlier references.
 */
export function findLiteralPaths(gt: GroundTruth, literal: string, opts: { hint?: string; substring?: boolean } = {}): Array<{ ref: number; segs: Array<string | number> }> {
  const out: Array<{ ref: number; segs: Array<string | number> }> = [];
  const want = literal.trim().toLowerCase();
  const walk = (v: unknown, ref: number, segs: Array<string | number>, depth: number) => {
    if (depth > 12 || out.length > 200) return;
    if (scalar(v)) {
      const got = String(v).trim().toLowerCase();
      if (got === want || (opts.substring && typeof v === 'string' && want.length >= 4 && got.includes(want))) out.push({ ref, segs });
    } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, ref, [...segs, i], depth + 1));
    else if (isObj(v)) for (const [k, x] of Object.entries(v)) walk(x, ref, [...segs, k], depth + 1);
  };
  gt.refs.forEach((r, i) => {
    if (r.ok) walk(r.data, i, ['data'], 0);
  });
  const words = new Set((opts.hint ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? []);
  const mention = (p: { segs: Array<string | number> }) => {
    const last = [...p.segs].reverse().find((x) => typeof x === 'string') as string | undefined;
    if (!last) return 0;
    const parts = last.toLowerCase().split('_').filter((w) => !['is', 'has', 'at'].includes(w));
    return parts.length && parts.every((w) => words.has(w) || words.has(`${w}s`)) ? 1 : 0;
  };
  return out.sort((a, b) => mention(b) - mention(a) || a.segs.length - b.segs.length || a.ref - b.ref);
}

/**
 * Binds literal `answer_contains` values to ground-truth paths. Several literals of one assertion
 * group or several single-literal assertions on sibling list items (`data[0].id`, `data[1].id`) become one
 * wildcard assertion (`data[*].id`, match all). Literals not found stay literal (normalized matching).
 */
export function bindAnswerLiterals(assertions: Assertion[], gt: GroundTruth, hint = ''): { assertions: Assertion[]; notes: string[] } {
  const notes: string[] = [];
  type Bound = { idx: number; path: { ref: number; segs: Array<string | number> }; literal: string };
  const bound: Bound[] = [];
  const out: Array<Assertion | null> = assertions.map((a, idx) => {
    if (a.type !== 'answer_contains' || a.from || !a.anyOf?.length) return a;
    // anyOf alternatives: bind the first literal that resolves
    for (const substring of [false, true])
      for (const lit of a.anyOf) {
        const paths = findLiteralPaths(gt, lit, { hint, substring });
        if (paths.length) {
          bound.push({ idx, path: paths[0]!, literal: lit });
          return a;
        }
      }
    notes.push(`answer value ${JSON.stringify(a.anyOf)} is not in the reference outcome: kept as a literal (normalized match)`);
    return a;
  });
  // group single-literal assertions whose paths differ only in one list index
  const key = (b: Bound) => JSON.stringify([b.path.ref, b.path.segs.map((s) => (typeof s === 'number' ? '#' : s))]);
  const groups = new Map<string, Bound[]>();
  for (const b of bound) groups.set(key(b), [...(groups.get(key(b)) ?? []), b]);
  for (const g of groups.values()) {
    const first = g[0]!;
    const orig = assertions[first.idx] as Extract<Assertion, { type: 'answer_contains' }>;
    if (g.length >= 2) {
      // index positions that differ between the members become [*]
      const segs = first.path.segs.map((s, i) => (typeof s === 'number' && g.some((b) => b.path.segs[i] !== s) ? '*' : s));
      const path = formatGroundTruthPath(first.path.ref, segs as Array<string | number | '*'>);
      out[first.idx] = { type: 'answer_contains', from: path, match: 'all', anyOf: g.map((b) => b.literal) };
      for (const b of g.slice(1)) out[b.idx] = null;
      notes.push(`answer values ${JSON.stringify(g.map((b) => b.literal))} → every ${path} (ground truth)`);
    } else {
      const path = formatGroundTruthPath(first.path.ref, first.path.segs);
      out[first.idx] = { type: 'answer_contains', from: path, anyOf: [first.literal], ...(orig.match ? { match: orig.match } : {}) };
      notes.push(`answer value ${JSON.stringify(first.literal)} → ${path} (ground truth; the literal is kept as a hint)`);
    }
  }
  return { assertions: out.filter((a): a is Assertion => a !== null), notes };
}

/**
 * Arguments of later reference calls taken from earlier results (`refund: "refund_1"` from the
 * list) become `{"$from": "ref[0].data.data[0].id"}`, so the chain follows the data at run time.
 * Returns the replaced values by `(ref index, arg)` for the matching `called` assertions.
 */
export function bindDerivedArgs(task: EvalTask, gt: GroundTruth): { refs: EvalTask['referenceCalls']; derived: Map<string, { value: unknown; from: string }>; notes: string[] } {
  const derived = new Map<string, { value: unknown; from: string }>();
  const notes: string[] = [];
  const refs = task.referenceCalls.map((r, i) => {
    if (i === 0) return r;
    const args: Record<string, unknown> = { ...r.arguments };
    for (const [k, v] of Object.entries(args)) {
      if (!scalar(v) || typeof v === 'boolean' || String(v).length < 2) continue;
      const earlier = { refs: gt.refs.slice(0, i) };
      const hits = findLiteralPaths(earlier, String(v)).filter((p) => p.segs.length > 1);
      // ids are the safe case: a value at an `id`-like key (or a name/login) of an earlier result
      const hit = hits.find((p) => /(^id$|_id$|^login$|^name$|^number$|^key$|^slug$)/.test(String(p.segs[p.segs.length - 1])));
      if (!hit) continue;
      const from = formatGroundTruthPath(hit.ref, hit.segs);
      args[k] = { $from: from };
      derived.set(`${i}|${k}`, { value: v, from });
      notes.push(`reference ${i + 1} ${r.tool}.${k} = ${JSON.stringify(v)} → ${from}`);
    }
    return { ...r, arguments: args };
  });
  return { refs, derived, notes };
}

/** The final answer a correct agent would give on the reference path (all expected values, plainly). */
export function referenceAnswer(task: EvalTask, gt: GroundTruth): string {
  if (task.category === 'impossible') return "I can't do that: none of the available tools supports it, so I reported it as an unmet need.";
  const parts: string[] = [];
  for (const a of task.assertions) {
    if (a.type !== 'answer_contains') continue;
    const vals = a.from ? (Array.isArray(a.from) ? a.from : [a.from]).flatMap((p) => resolvePath(gt, p)) : [];
    const shown = vals.length ? vals.flatMap((v) => (Array.isArray(v) ? v : [v])).filter(scalar) : (a.anyOf ?? []).slice(0, 1);
    parts.push(shown.map(String).join(', '));
  }
  if (!task.referenceCalls.length && task.category === 'ambiguous') parts.push('Could you clarify what exactly you mean before I look this up?');
  return parts.length ? `Result: ${parts.join('; ')}.` : 'Done.';
}

/** The synthetic attempt of the reference solution (framed, the reference calls as observed calls). */
export function referenceRecord(task: EvalTask, gt: GroundTruth): AttemptRecord {
  const calls: ObservedCall[] = task.referenceCalls.map((r, i) => ({ tool: r.tool, arguments: resolveArgs(r.arguments, gt), status: gt.refs[i]?.ok ? 'ok' : 'tool_error', decision: 'allowed', via: 'reference', write: false }));
  const agent: AgentCall[] = [
    { name: BEGIN_TASK_TOOL, arguments: {}, isError: false, latencyMs: 0 },
    ...calls.map((c) => ({ name: c.tool, arguments: c.arguments, isError: c.status !== 'ok', latencyMs: 0 })),
    ...(task.category === 'impossible' ? [{ name: UNMET_NEED_TOOL, arguments: { intent: task.prompt }, isError: false, latencyMs: 0 }] : []),
    { name: END_TASK_TOOL, arguments: {}, isError: false, latencyMs: 0 },
  ];
  if (task.category === 'impossible') calls.push({ tool: UNMET_NEED_TOOL, arguments: {}, status: 'ok', decision: 'allowed', via: 'reference', write: false });
  return {
    finalAnswer: referenceAnswer(task, gt),
    agentCalls: agent,
    toolCallsByAgent: calls.length,
    scripts: 0,
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 0,
    servedByModel: null,
    fallbackUsed: false,
    stopReason: 'end_turn',
    endReason: 'end_turn',
    error: null,
    transcript: [],
    neurouterTaskId: null,
    framingAvailable: true,
    calls,
  };
}

/** Runs the task's reference solution through its deterministic assertions. */
export async function calibrateTask(task: EvalTask, gt: GroundTruth, opts: { stateReader?: StateReader } = {}): Promise<TaskCalibration> {
  const reasons: string[] = [];
  gt.refs.forEach((r, i) => {
    if (!r.ok) reasons.push(`reference call ${i + 1} (${r.tool}) failed: ${(r.error ?? 'error').slice(0, 200)}`);
  });
  const refsOk = gt.refs.length > 0 && gt.refs.every((r) => r.ok);
  for (const a of task.assertions) {
    if (a.type !== 'answer_contains') continue;
    if (a.from) {
      for (const p of Array.isArray(a.from) ? a.from : [a.from]) if (!resolvePath(gt, p).length) reasons.push(`expected value ${p} resolves to nothing in the reference outcome`);
    } else if (refsOk && a.anyOf?.length && a.normalize !== false && !a.anyOf.some((lit) => findLiteralPaths(gt, lit, { substring: true }).length)) {
      // a literal the reference outcome does not contain: the expected answer disagrees with the data
      reasons.push(`expected answer value ${JSON.stringify(a.anyOf)} is not in the reference outcome`);
    }
  }
  if ((task.category === 'single' || task.category === 'multi') && !task.referenceCalls.length) reasons.push('no reference calls');
  const rec = referenceRecord(task, gt);
  // judge assertions need a model: not calibrated here (treated as passing)
  const check = await checkAttempt(task, rec, { groundTruth: gt, judge: { score: 1, verdict: 'pass', reasons: ['calibration: judge not run'] }, ...(opts.stateReader ? { stateReader: opts.stateReader } : {}) });
  for (const r of check.results) if (!r.passed && r.assertion.type !== 'framing' && !(r.assertion.type === 'state' && !opts.stateReader)) reasons.push(`the reference fails its own ${r.assertion.type} assertion: ${r.detail}`);
  return { key: task.key, status: reasons.length ? 'rejected' : 'passed', reasons: [...new Set(reasons)], groundTruth: groundTruthPreview(gt, 400) };
}

export async function calibrateSuite(tasks: EvalTask[], groundTruthOf: (task: EvalTask) => Promise<GroundTruth>, opts: { mockDataVersion: number; stateReader?: (task: EvalTask) => StateReader | undefined; now?: () => Date } = { mockDataVersion: 2 }): Promise<SuiteCalibration> {
  const out: TaskCalibration[] = [];
  for (const t of tasks) {
    let gt: GroundTruth;
    try {
      gt = await groundTruthOf(t);
    } catch (err) {
      out.push({ key: t.key, status: 'rejected', reasons: [`reference execution failed: ${(err as Error).message}`] });
      continue;
    }
    const sr = opts.stateReader?.(t);
    out.push(await calibrateTask(t, gt, sr ? { stateReader: sr } : {}));
  }
  return summarizeCalibration(out, opts.mockDataVersion, null, (opts.now ?? (() => new Date()))());
}

export function summarizeCalibration(tasks: TaskCalibration[], mockDataVersion: number, model: string | null, at: Date): SuiteCalibration {
  return { at: at.toISOString(), mockDataVersion, passed: tasks.filter((t) => t.status === 'passed').length, rejected: tasks.filter((t) => t.status === 'rejected').length, flagged: tasks.filter((t) => t.status === 'flagged').length, model, tasks };
}

/** Plain-text calibration report (CLI). */
export function renderCalibration(c: SuiteCalibration): string {
  const lines = [`calibration (mock data v${c.mockDataVersion}): ${c.passed} passed, ${c.rejected} rejected, ${c.flagged} flagged for review${c.model ? ` (model pass: ${c.model})` : ''}`];
  for (const t of c.tasks) if (t.status !== 'passed') lines.push(`  - ${t.key} [${t.status}]: ${t.reasons.join('; ')}`);
  return lines.join('\n');
}
