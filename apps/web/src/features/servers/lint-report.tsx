import type { LintReport } from '@/contract';
import { Pill } from '@/components/status/status';

/** Console labels of the lint rules (backend §8.6; contract-v2 description standard). */
export const LINT_RULE_LABELS: Record<string, string> = {
  description_present: 'Descriptions present',
  description_actionable: 'Descriptions start with a verb',
  params_described: 'Arguments described',
  params_typed: 'Arguments typed',
  names_clear: 'Clear names',
  toolset_size: 'Tool set size',
  output_shaped: 'Large lists shaped',
  examples_present: 'Examples present',
  writes_marked: 'Writes marked',
  schema_depth: 'Shallow input schemas',
  example_runs: 'Examples run against the mock',
  destructive_marked: 'Destructive tools marked',
  has_more_without_cursor: 'Lists can reach the next page',
  envelope_conformance: 'Responses match the output schema',
  first_sentence: 'First sentence states the effect',
  description_length: 'Agent descriptions short enough',
  enum_in_schema: 'Allowed values in the schema',
};

export interface LintRow {
  rule: string;
  label: string;
  score: number;
  weight: number;
  passed: boolean;
  detail: string;
  findings: LintReport['findings'];
}

/** Scored rules, failing first (by lost points), each with its findings; unscored (weight 0) rules are left out. */
export function lintRows(report: LintReport): LintRow[] {
  return report.rules
    .filter((r) => r.weight > 0)
    .map((r) => ({ rule: r.rule, label: LINT_RULE_LABELS[r.rule] ?? r.rule, score: r.score, weight: r.weight, passed: r.passed, detail: r.detail, findings: report.findings.filter((f) => f.rule === r.rule) }))
    .sort((a, b) => Number(a.passed) - Number(b.passed) || b.weight * (1 - b.score) - a.weight * (1 - a.score));
}

/** The lint report of a build: score, each rule with its result and the findings to fix (in the overlay). */
export function LintReportPanel({ report }: { report: LintReport }) {
  const rows = lintRows(report);
  return (
    <div className="flex flex-col gap-2 text-[13.5px]">
      <p>
        Lint score <strong className="tabular-nums">{report.score}</strong>/100 · {rows.filter((r) => !r.passed).length} of {rows.length} rules need work
      </p>
      <ul className="flex flex-col gap-2">
        {rows.map((r) => (
          <li key={r.rule} className="rounded-lg border p-2.5">
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={r.passed ? 'ok' : r.score >= 0.7 ? 'warn' : 'err'}>{Math.round(r.score * 100)}%</Pill>
              <span className="font-medium">{r.label}</span>
              <span className="text-muted-foreground">{r.detail}</span>
            </div>
            {r.findings.length ? (
              <ul className="mt-1.5 flex flex-col gap-1 pl-1 text-[12.5px]">
                {r.findings.slice(0, 10).map((f, i) => (
                  <li key={i} className={f.severity === 'info' ? 'text-muted-foreground' : ''}>
                    {f.tool ? <span className="font-mono">{f.tool}</span> : null}
                    {f.tool ? ': ' : ''}
                    {f.message}
                  </li>
                ))}
                {r.findings.length > 10 ? <li className="text-muted-foreground">… {r.findings.length - 10} more</li> : null}
              </ul>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
