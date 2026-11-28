/**
 * Tenant-scope CI check (multi-tenancy spec §4.2 step 4; port of the Appendix A.3 inventory script).
 *
 * Every Kysely chain in `apps/server/src` (tests, migrations and dev scripts excluded) that starts with
 * `selectFrom`/`updateTable`/`deleteFrom` on a tenant table must mention `tenant_id`, unless the
 * comment block right above it (or a trailing comment on its first line) says why not:
 *
 *   // tenant-scope: <reason> (optional note)
 *
 * Reasons (fixed list):
 * - `child-of-scoped`: keyed by the id of a row already loaded through a tenant-scoped guard (`*Or404`).
 * - `by-secret-hash`: looked up by a hash of a bearer secret (token, code, state); the row's tenant is then checked.
 * - `system-job`: a background job that works across tenants on purpose (retention, indexing, GC).
 * - `global-table`: the table holds platform rows here (e.g. client registrations).
 * - `tenant-from-row`: loads one row by its unique id and takes the tenant from it for every later check.
 * - `user-scope`: an account-level query over the signed-in user's own memberships or invites (across tenants by design).
 *
 * Inserts are checked by the type system: `tenant_id` is required (non-`Generated`) on every tenant
 * table in `kernel/db/schema.ts`, which this test also asserts. Builders from `scoped()` are scoped
 * by construction and skipped.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { GLOBAL_TABLES, TENANT_ID_OPTIONAL_TABLES } from '../kernel/db/tenant-scope.js';

const SRC = resolve(import.meta.dirname, '..');
export const TENANT_SCOPE_REASONS = ['child-of-scoped', 'by-secret-hash', 'system-job', 'global-table', 'tenant-from-row', 'user-scope'] as const;
const STARTS = new Set(['selectFrom', 'updateTable', 'deleteFrom', 'insertInto']);
/** Calls whose arguments can scope a chain by tenant (filters, joins, inserted/updated values). */
const PREDICATE_CALLS = new Set(['where', 'whereRef', 'orWhere', 'having', 'on', 'onRef', 'innerJoin', 'leftJoin', 'values', 'set']);
const GLOBAL = new Set<string>(GLOBAL_TABLES);

export interface ChainFinding {
  file: string;
  line: number;
  op: string;
  table: string;
  scoped: boolean;
  annotation: string | null;
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (n !== 'migrations' && n !== 'test' && n !== 'scripts') out.push(...sourceFiles(p));
    } else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts') && !p.endsWith('kernel/db/tenant-scope.ts')) out.push(p); // the scoped() helper itself
  }
  return out;
}

/** `// tenant-scope: <reason>` on the chain's first line or in the comment block right above it. */
function annotationFor(lines: readonly string[], line: number): string | null {
  const own = /\/\/\s*tenant-scope:\s*([a-z-]+)/.exec(lines[line - 1] ?? '');
  if (own) return own[1]!;
  for (let i = line - 2; i >= 0; i--) {
    const l = lines[i]!.trim();
    if (!l.startsWith('//')) return null;
    const m = /^\/\/\s*tenant-scope:\s*([a-z-]+)/.exec(l);
    if (m) return m[1]!;
  }
  return null;
}

/** Every query chain in the server sources (the Appendix A.3 inventory). */
export function inventory(root = SRC): ChainFinding[] {
  const rows: ChainFinding[] = [];
  for (const f of sourceFiles(root)) {
    const text = readFileSync(f, 'utf8');
    const lines = text.split('\n');
    const sf = ts.createSourceFile(f, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && STARTS.has(node.expression.name.text)) {
        const receiver = node.expression.expression.getText(sf);
        // builders from `scoped(db, tenantId)` already carry the tenant predicate
        const fromScoped = /^(scoped\(.*\)|\w*[sS]coped\w*|sc)$/s.test(receiver);
        let top: ts.Node = node;
        while (top.parent && (ts.isPropertyAccessExpression(top.parent) || (ts.isCallExpression(top.parent) && top.parent.expression === top) || ts.isNonNullExpression(top.parent))) top = top.parent;
        // scoped = a tenant_id predicate (or value), not merely `tenant_id` in the select list
        let predicate = false;
        const scan = (n: ts.Node): void => {
          if (predicate) return;
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && PREDICATE_CALLS.has(n.expression.name.text) && n.arguments.some((x) => /tenant_id/.test(x.getText(sf)))) predicate = true;
          ts.forEachChild(n, scan);
        };
        scan(top);
        const arg0 = node.arguments[0];
        const table = arg0 && ts.isStringLiteralLike(arg0) ? arg0.text.split(/\s+as\s+/)[0]!.trim() : arg0 ? `<${arg0.getText(sf).slice(0, 40)}>` : '?';
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
        rows.push({ file: relative(resolve(root, '../../..'), f), line, op: node.expression.name.text, table, scoped: fromScoped || predicate, annotation: annotationFor(lines, line) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return rows;
}

describe('tenant scope (multi-tenancy spec §4.2)', () => {
  const rows = inventory();

  it('finds the query chains (sanity)', () => {
    expect(rows.length).toBeGreaterThan(300);
  });

  it('every select/update/delete on a tenant table filters tenant_id or carries an annotated reason', () => {
    const offending = rows.filter((r) => r.op !== 'insertInto' && !GLOBAL.has(r.table) && !r.scoped && !r.annotation);
    const report = offending.map((r) => `${r.file}:${r.line} ${r.op}(${r.table})`).join('\n');
    expect(offending, `Unscoped tenant-table queries (add a tenant_id predicate, or a "// tenant-scope: <reason>" comment above):\n${report}`).toEqual([]);
  });

  it('annotations use a reason from the fixed list', () => {
    const bad = rows.filter((r) => r.annotation && !(TENANT_SCOPE_REASONS as readonly string[]).includes(r.annotation));
    expect(bad.map((r) => `${r.file}:${r.line} ${r.annotation}`)).toEqual([]);
  });

  it('tenant_id is required on inserts into every tenant table (schema.ts)', () => {
    const schema = readFileSync(join(SRC, 'kernel/db/schema.ts'), 'utf8');
    const generated: string[] = [];
    for (const m of schema.matchAll(/export interface (\w+)Table \{([^}]*)\}/g)) {
      if (/tenant_id: Generated</.test(m[2]!)) generated.push(m[1]!.replace(/[A-Z]/g, (c, i: number) => (i ? '_' : '') + c.toLowerCase()));
    }
    expect(generated.sort()).toEqual([...TENANT_ID_OPTIONAL_TABLES].sort());
    for (const t of TENANT_ID_OPTIONAL_TABLES) expect(GLOBAL.has(t), `${t} keeps a tenant_id default, so it must be a global table`).toBe(true);
  });
});
