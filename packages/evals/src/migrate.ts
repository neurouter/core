/**
 * Task upgrade to the outcome-based model (0.2.2), shared by the suite converter (`migrateSuite`,
 * 0.2.1 files) and the generator's post-processing:
 * - `called.args` keep only the arguments the prompt requires (reference `required`, minus paging
 *   arguments); the rest are recorded as `incidental` and never compared;
 * - later reference arguments taken from earlier results become `{"$from": …}`;
 * - equivalent tools (same GET path tail and parameters, e.g. the four "repository public key"
 *   endpoints) are accepted as `anyOf` alternatives;
 * - literal answer values are bound to ground-truth paths (`answer_contains.from`);
 * - "use your judgment" tasks assert a stated, consistent choice (judge `kind: choice`), not a value;
 * - `max_calls` is derived from the reference path (soft); `n: 0` stays a hard "don't call the API".
 */
import type { Assertion, ToolAlternative } from '@neurouter/shared';
import { deriveCallBudget, isIncidentalArg } from './budget.js';
import { bindAnswerLiterals, bindDerivedArgs } from './calibrate.js';
import type { GroundTruth } from './groundtruth.js';
import type { EvalTask, SuiteFile } from './types.js';

/** A tool as the upgrader needs it (name, stable key, HTTP method/path, input schema). */
export interface UpgradeTool {
  name: string;
  key?: string;
  method?: string;
  path?: string;
  inputSchema?: Record<string, unknown>;
  write?: boolean;
}

const JUDGMENT_RE = /\b(your (best )?judg(e)?ment|you decide|your call|up to you|reasonable (cutoff|threshold|choice|interpretation)|however you (see fit|interpret)|tell me (what|how) you (chose|interpreted)|what you chose|how you interpreted)\b/i;

/** "Use your judgment" tasks: an ambiguous task whose prompt leaves a choice to the agent. */
export function isJudgmentTask(task: Pick<EvalTask, 'category' | 'prompt'>): boolean {
  return task.category === 'ambiguous' && JUDGMENT_RE.test(task.prompt);
}

const pathParams = (p: string) => (p.match(/\{[^}]+\}/g) ?? []).sort().join(',');
const literalTail = (p: string, n: number) =>
  p
    .split('/')
    .filter((s) => s && !s.startsWith('{'))
    .slice(-n)
    .join('/');

/**
 * Equivalent tools: GET operations whose path ends in the same two literal segments, under the same
 * path parameters (`/repos/{owner}/{repo}/{actions|codespaces|dependabot|agents}/secrets/public-key`).
 */
export function equivalentTools(tool: string, tools: UpgradeTool[]): UpgradeTool[] {
  const t = tools.find((x) => x.name === tool);
  if (!t?.path || (t.method && t.method.toUpperCase() !== 'GET')) return [];
  const tail = literalTail(t.path, 2);
  if (!tail.includes('/')) return [];
  const params = pathParams(t.path);
  return tools.filter((x) => x.name !== t.name && x.path && (!x.method || x.method.toUpperCase() === 'GET') && !x.write && literalTail(x.path, 2) === tail && pathParams(x.path) === params);
}

const alt = (t: UpgradeTool): ToolAlternative => ({ tool: t.name, ...(t.key ? { toolKey: t.key } : {}) });

export interface UpgradeOptions {
  tools?: UpgradeTool[];
  /** Reference outcomes on the suite's mock data (binds answer literals and derived arguments). */
  groundTruth?: GroundTruth | null;
}

/** Upgrades one task (see the module comment); returns the task and what changed. */
export function upgradeTask(task: EvalTask, opts: UpgradeOptions = {}): { task: EvalTask; notes: string[] } {
  const notes: string[] = [];
  const tools = opts.tools ?? [];
  const schemaOf = (name: string) => tools.find((t) => t.name === name)?.inputSchema;
  const judgment = isJudgmentTask(task);
  let refs = task.referenceCalls.map((r) => {
    const required = r.required ?? Object.keys(r.arguments).filter((k) => !isIncidentalArg(k));
    const alts = r.alternatives ?? (tools.length ? equivalentTools(r.tool, tools).map(alt) : []);
    return { ...r, required: judgment ? [] : required, ...(alts.length ? { alternatives: alts } : {}) };
  });
  // derived arguments → $from
  let derived = new Map<string, { value: unknown; from: string }>();
  if (opts.groundTruth) {
    const b = bindDerivedArgs({ ...task, referenceCalls: refs }, opts.groundTruth);
    refs = b.refs.map((r, i) => ({ ...refs[i]!, arguments: r.arguments }));
    derived = b.derived;
    notes.push(...b.notes);
  }
  let assertions: Assertion[] = [];
  let hadBudget = false;
  for (const a of task.assertions) {
    if (a.type === 'called') {
      const refIdx = refs.findIndex((r) => r.tool === a.tool);
      const ref = refIdx >= 0 ? refs[refIdx] : undefined;
      const anyOf = a.anyOf ?? ref?.alternatives;
      if (anyOf?.length && !a.anyOf) notes.push(`${a.tool}: equivalent tools accepted (${anyOf.map((x) => x.tool).join(', ')})`);
      if (!a.args) {
        assertions.push({ ...a, ...(anyOf?.length ? { anyOf } : {}) });
        continue;
      }
      const required: Record<string, unknown> = {};
      const incidental: Record<string, unknown> = { ...(a.incidental ?? {}) };
      for (const [k, v] of Object.entries(a.args)) {
        const keep = !judgment && !isIncidentalArg(k) && (!ref?.required || ref.required.includes(k));
        if (!keep) {
          incidental[k] = v;
          continue;
        }
        const d = derived.get(`${refIdx}|${k}`);
        required[k] = d && JSON.stringify(d.value) === JSON.stringify(v) ? { $from: d.from } : v;
      }
      const dropped = Object.keys(incidental).filter((k) => !(a.incidental && k in a.incidental));
      if (dropped.length) notes.push(`${a.tool}: ${judgment ? 'judgment task, ' : ''}not pinned any more: ${dropped.map((k) => `${k}=${JSON.stringify(incidental[k])}`).join(', ')}`);
      const { args: _a, incidental: _i, ...rest } = a;
      assertions.push({ ...rest, ...(Object.keys(required).length ? { args: required } : {}), ...(Object.keys(incidental).length ? { incidental } : {}), ...(anyOf?.length ? { anyOf } : {}) });
    } else if (a.type === 'max_calls') {
      hadBudget = true;
      if (a.n === 0 || a.hard) assertions.push({ ...a, hard: true });
      else {
        const n = deriveCallBudget(refs, schemaOf);
        if (n !== a.n) notes.push(`max_calls ${a.n} → ${n} (derived from ${refs.length} reference call(s); soft: over budget is reported, not failed)`);
        assertions.push({ type: 'max_calls', n });
      }
    } else if (a.type === 'answer_contains' && judgment) {
      notes.push(`judgment task: answer value ${JSON.stringify(a.anyOf ?? a.from)} not required any more (the judge checks the stated choice)`);
    } else if (a.type === 'judge' && refs.length && !a.groundTruth && /\b\d+\b|"[^"]+"|_\d+\b/.test(a.criterion)) {
      assertions.push({ ...a, groundTruth: true });
      notes.push('judge: gets the ground truth (its criterion names expected values)');
    } else assertions.push(a);
  }
  if (!hadBudget && refs.length && task.category !== 'impossible') assertions.push({ type: 'max_calls', n: deriveCallBudget(refs, schemaOf) });
  let rubric = task.rubric;
  if (judgment && !assertions.some((a) => a.type === 'judge' && a.kind === 'choice')) {
    // a generated rubric often pins the generator's own choice ("use a cutoff of 50"): the judge would grade against it
    rubric = 'The request leaves part of the decision to the agent. Any reasonable choice is acceptable when the answer states it and the results reported are consistent with it and with the API results. Nothing is modified.';
    notes.push(`judgment task: rubric replaced (was: ${JSON.stringify(task.rubric.slice(0, 160))})`);
    assertions.push({ type: 'judge', kind: 'choice', criterion: 'States the choice it made for the part of the request left to its judgment, and the results it reports are consistent with that choice.' });
    notes.push('judgment task: judge {kind: choice} (stated choice, consistent results) instead of fixed values');
  }
  if (opts.groundTruth) {
    const b = bindAnswerLiterals(assertions, opts.groundTruth, `${task.prompt} ${task.rubric}`);
    assertions = b.assertions;
    notes.push(...b.notes);
  }
  return { task: { ...task, rubric, referenceCalls: refs, assertions }, notes };
}

/** Converts a 0.2.1 (version 1) suite file to the 0.2.2 model, keeping mock data version 1 (its prompts name 0.2.1 mock values). */
export async function migrateSuite(file: SuiteFile, opts: { tools?: UpgradeTool[]; groundTruthOf?: (task: EvalTask) => Promise<GroundTruth | null>; now?: () => Date } = {}): Promise<SuiteFile> {
  const notes: Record<string, string[]> = {};
  const tasks: EvalTask[] = [];
  for (const t of file.tasks) {
    const gt = opts.groundTruthOf && t.referenceCalls.length ? await opts.groundTruthOf(t) : null;
    const up = upgradeTask(t, { ...(opts.tools ? { tools: opts.tools } : {}), groundTruth: gt });
    tasks.push(up.task);
    notes[t.key] = up.notes;
  }
  return {
    version: 2,
    server: file.server,
    generatedFrom: file.generatedFrom,
    mockDataVersion: file.mockDataVersion ?? 1,
    calibration: null,
    migration: { from: `suite v${file.version}`, at: (opts.now ?? (() => new Date()))().toISOString(), notes },
    tasks,
  };
}

/** The mock data version of a suite file: explicit, else 1 for version-1 files (0.2.1), else the current one. */
export function suiteDataVersion(file: Pick<SuiteFile, 'version' | 'mockDataVersion'>): number {
  return file.mockDataVersion ?? (file.version === 1 ? 1 : 2);
}
