import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LintReport } from '@/contract';
import { LintReportPanel, lintRows } from './lint-report';

const REPORT: LintReport = {
  score: 82,
  rules: [
    { rule: 'description_present', weight: 10, score: 1, passed: true, detail: '14/14 tools have a useful description' },
    { rule: 'example_runs', weight: 10, score: 0.5, passed: false, detail: '7/14 tools have an example that runs against the mock' },
    { rule: 'enum_in_schema', weight: 2, score: 0.9, passed: false, detail: '13/14 tools keep allowed values in the schema' },
    { rule: 'examples_present', weight: 0, score: 1, passed: true, detail: 'unscored' },
  ],
  findings: [{ rule: 'example_runs', severity: 'warning', tool: 'get_order', message: 'curated example {"order_id":12} fails: does not match the input schema' }],
};

describe('lint report (console)', () => {
  it('orders failing rules by lost points and drops unscored ones', () => {
    expect(lintRows(REPORT).map((r) => r.rule)).toEqual(['example_runs', 'enum_in_schema', 'description_present']);
  });

  it('renders the score, rule labels and findings', () => {
    render(<LintReportPanel report={REPORT} />);
    expect(screen.getByText('82')).toBeTruthy();
    expect(screen.getByText('Examples run against the mock')).toBeTruthy();
    expect(screen.getByText(/curated example/)).toBeTruthy();
    expect(screen.getByText(/2 of 3 rules need work/)).toBeTruthy();
  });
});
