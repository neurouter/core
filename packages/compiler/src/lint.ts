/**
 * Spec/tool quality lint and the preliminary readiness score (backend spec §8.6). The score is the
 * weighted share of passed checks (each rule scores 0..1).
 */
import type { LintFinding, LintReport, LintRule, LintRuleResult, ToolDef } from '@neurouter/shared';
import { isVerb } from './naming.js';
import { countFields, schemaDepth } from './openapi/schema.js';
import { isObj } from './util.js';

export const LINT_WEIGHTS: Record<LintRule, number> = {
  description_present: 15,
  description_actionable: 10,
  params_described: 15,
  params_typed: 10,
  names_clear: 10,
  toolset_size: 15,
  output_shaped: 10,
  examples_present: 5,
  writes_marked: 5,
  schema_depth: 5,
};

export interface LintOptions {
  discovery?: 'auto' | 'full' | 'search';
  /** extra pinned tool names (neurouter.yaml `exposure.pinned`) */
  pinned?: string[];
}

const MAX_FINDINGS_PER_RULE = 25;

function argProps(t: ToolDef): Array<[string, Record<string, unknown>]> {
  const p = t.inputSchema.properties;
  return isObj(p) ? (Object.entries(p) as Array<[string, Record<string, unknown>]>) : [];
}

function isListTool(t: ToolDef): boolean {
  const o = t.outputSchema;
  if (!isObj(o)) return false;
  if (o['x-neurouter-wrapped'] === 'items') return true;
  if (isObj(o.properties)) return Object.values(o.properties).some((v) => isObj(v) && v.type === 'array');
  return false;
}

export function lint(tools: ToolDef[], opts: LintOptions = {}): LintReport {
  const visible = tools.filter((t) => !t.hidden);
  const findings: LintFinding[] = [];
  const rules: LintRuleResult[] = [];
  const add = (rule: LintRule, score: number, detail: string) => rules.push({ rule, weight: LINT_WEIGHTS[rule], score: Math.max(0, Math.min(1, score)), passed: score >= 0.999, detail });
  const perTool = (rule: LintRule, pass: (t: ToolDef) => string | null, label: string) => {
    if (visible.length === 0) return add(rule, 1, 'no visible tools');
    let ok = 0;
    let n = 0;
    for (const t of visible) {
      const problem = pass(t);
      if (problem === null) ok++;
      else if (n++ < MAX_FINDINGS_PER_RULE) findings.push({ rule, severity: 'warning', tool: t.name, message: problem });
    }
    add(rule, ok / visible.length, `${ok}/${visible.length} ${label}`);
  };

  perTool(
    'description_present',
    (t) => {
      const d = t.description.trim();
      const isPath = /^(GET|POST|PUT|PATCH|DELETE|HEAD) \//.test(d) || /^(Query|Mutation)\.\w+$/.test(d);
      if (isPath) return 'has no description (only the method and path)';
      if (d.length < 40) return `description is too short (${d.length} chars; aim for ≥ 40)`;
      return null;
    },
    'tools have a useful description',
  );
  perTool(
    'description_actionable',
    (t) => {
      const first = t.description.trim().split(/\s+/)[0] ?? '';
      if (t.description.length > 1024) return 'description is longer than 1024 chars';
      if (/<[a-z][^>]*>/i.test(t.description)) return 'description contains raw HTML';
      if (!isVerb(first.replace(/[^A-Za-z]/g, ''))) return `description should start with a verb (starts with "${first}")`;
      return null;
    },
    'descriptions start with a verb',
  );
  perTool(
    'params_described',
    (t) => {
      const args = argProps(t);
      if (args.length === 0) return null;
      const described = args.filter(([, s]) => typeof s.description === 'string' && (s.description as string).trim().length > 0).length;
      return described / args.length >= 0.8 ? null : `${args.length - described} of ${args.length} arguments have no description`;
    },
    'tools describe ≥ 80% of their arguments',
  );
  perTool(
    'params_typed',
    (t) => {
      const untyped = argProps(t)
        .filter(([, s]) => !s.type && !s.enum && !s.oneOf && !s.anyOf && !s.$ref && !s.const && !s.allOf)
        .map(([k]) => k);
      return untyped.length ? `untyped arguments: ${untyped.join(', ')}` : null;
    },
    'tools have typed arguments',
  );
  perTool(
    'names_clear',
    (t) => {
      if (!/^[a-z][a-z0-9_]*$/.test(t.name)) return 'name is not snake_case';
      if (t.name.length > 40) return `name is long (${t.name.length} chars; aim for ≤ 40)`;
      if (/by_by|_\d+$/.test(t.name)) return 'name looks generated (collision suffix or by_by)';
      if (!isVerb(t.name.split('_')[0]!)) return `name should start with a verb (e.g. list_, get_, create_)`;
      return null;
    },
    'names are clear',
  );

  // toolset_size
  const pinned = visible.filter((t) => t.pinned || (opts.pinned ?? []).includes(t.name)).length;
  const discovery = opts.discovery ?? 'auto';
  let sizeScore = 1;
  let sizeDetail = `${visible.length} visible tools`;
  if (visible.length > 200) {
    sizeScore = 0;
    sizeDetail += ' (> 200: too many even with search; hide tools in the overlay)';
  } else if (visible.length > 40) {
    if (discovery !== 'full' && pinned >= 1) sizeDetail += `, search discovery with ${pinned} pinned`;
    else {
      sizeScore = 0;
      sizeDetail += discovery === 'full' ? ' with full discovery (> 40)' : ' and no pinned tools';
    }
  }
  if (sizeScore < 1)
    findings.push({ rule: 'toolset_size', severity: 'warning', message: `${sizeDetail}. Hide rarely used tools and pin the common ones.`, ...(visible.length > 40 ? { fix: [{ op: 'set_default', field: 'hidden', value: true }] } : {}) });
  add('toolset_size', sizeScore, sizeDetail);

  // output_shaped
  const lists = visible.filter(isListTool);
  if (lists.length === 0) add('output_shaped', 1, 'no list-returning tools');
  else {
    let ok = 0;
    let n = 0;
    for (const t of lists) {
      const shaped = !!t.shaping && (t.shaping.maxItems !== undefined || (t.shaping.include?.length ?? 0) > 0);
      if (shaped || countFields(t.outputSchema) <= 50) ok++;
      else if (n++ < MAX_FINDINGS_PER_RULE)
        findings.push({ rule: 'output_shaped', severity: 'warning', tool: t.name, message: 'returns a large list without shaping (add response.maxItems or response.include)', fix: [{ op: 'set', selector: t.key, field: 'response', value: { maxItems: 50 } }] });
    }
    add('output_shaped', ok / lists.length, `${ok}/${lists.length} list tools shaped or small`);
  }

  // examples_present
  if (visible.length === 0) add('examples_present', 1, 'no visible tools');
  else {
    const withEx = visible.filter((t) => t.examples.length > 0).length;
    const ratio = withEx / visible.length;
    add('examples_present', ratio / 0.3, `${withEx}/${visible.length} tools have examples (target ≥ 30%)`);
    if (ratio < 0.3) findings.push({ rule: 'examples_present', severity: 'info', message: `Only ${withEx} of ${visible.length} tools have an example; add examples in the overlay.` });
  }

  perTool(
    'writes_marked',
    (t) => {
      const b = t.binding;
      if (b.type === 'http' && b.method === 'DELETE' && !t.risk.destructive) return 'DELETE tool is not marked destructive';
      if (b.type === 'http' && b.method !== 'GET' && b.method !== 'HEAD' && !t.risk.write && !t.overlayApplied.length) return 'non-GET tool is not marked as a write';
      return null;
    },
    'writes and destructive tools are marked',
  );
  perTool('schema_depth', (t) => (schemaDepth(t.inputSchema) > 4 ? `input schema nests ${schemaDepth(t.inputSchema)} levels (> 4)` : null), 'input schemas nest ≤ 4 levels');

  const total = rules.reduce((s, r) => s + r.weight, 0);
  const score = Math.round((100 * rules.reduce((s, r) => s + r.weight * r.score, 0)) / total);
  return { score, rules, findings };
}
