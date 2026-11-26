// Generates kernel/db/schema.ts from the migrated SQLite schema (run with tsx; dev tool).
import { createDatabases, migrateAll } from '../kernel/db/index.js';
import { MAIN_MIGRATIONS, AUDIT_MIGRATIONS } from '../kernel/db/migrations/index.js';
import fs from 'node:fs';
import { TENANT_ID_OPTIONAL_TABLES } from '../kernel/db/tenant-scope.js';

const dbs = createDatabases({ databaseUrl: 'sqlite::memory:' });
await migrateAll(dbs, { embeddingDims: 384 });
if (dbs.main.native.kind !== 'sqlite') throw new Error('sqlite');
const d = dbs.main.native.database;
const pascal = (s: string) => s.split('_').map((p) => p[0]!.toUpperCase() + p.slice(1)).join('') + 'Table';
// determine table membership from migration source text
const src = (names: string[]) => names.map((n) => fs.readFileSync(`src/kernel/db/migrations/${n}`, 'utf8')).join('\n');
const auditSrc = src(['audit/0006_audit.ts', 'audit/0007_metrics.ts']);
const tables = (d.prepare("select name, sql from sqlite_master where type='table' and name not like 'sqlite_%' and name not like 'kysely_%'").all() as { name: string; sql: string }[]).filter(
  (t) => !/_(data|idx|content|docsize|config)$/.test(t.name) && !/virtual table/i.test(t.sql),
);
const enumOf = (sqlText: string, col: string): string | null => {
  const m = sqlText.match(new RegExp(`"${col}" in \\(([^)]*)\\)`));
  if (!m) return null;
  const vals = m[1]!.split(',').map((v) => v.trim());
  if (vals.every((v) => /^'.*'$/.test(v))) return vals.map((v) => v.replace(/'/g, "'")).join(' | ');
  if (vals.join(',') === '0,1') return 'BoolColumn';
  return null;
};
let out = `// Kysely table types (backend spec §7). GENERATED from the migrations by apps/server/src/scripts/gen-schema.ts;\n// \`schema.test.ts\` applies all migrations to SQLite and PGlite and fails on drift.\nimport type { ColumnType, Generated } from 'kysely';\n\n/** 0/1 integers on both dialects. */\nexport type BoolColumn = 0 | 1;\nexport type { ColumnType, Generated };\n\n`;
const main: string[] = [];
const audit: string[] = [];
const inv: Record<string, string[]> = {};
for (const t of tables) {
  const cols = d.prepare(`pragma table_info(${JSON.stringify(t.name)})`).all() as { name: string; type: string; notnull: number; dflt_value: string | null; pk: number }[];
  const isAudit = auditSrc.includes(`'${t.name}'`) || t.name.startsWith('audit_');
  (isAudit ? audit : main).push(t.name);
  inv[t.name] = cols.map((c) => c.name);
  out += `export interface ${pascal(t.name)} {\n`;
  for (const c of cols) {
    let ty: string;
    const en = enumOf(t.sql, c.name);
    const type = c.type.toLowerCase();
    if (en) ty = en;
    else if (t.name === 'tool_embeddings' && c.name === 'embedding') ty = 'Buffer | string';
    else if (type === 'blob') ty = 'Buffer';
    else if (type === 'integer' || type === 'real' || type === 'bigint') ty = 'number';
    else ty = 'string';
    if (['json'].includes(type)) ty = 'JsonColumn';
    // json columns are declared as 'text' on sqlite; detect via migration usage of T.json
    // tenant_id is required on every insert into a tenant table (multi-tenancy spec §4.2), whatever the column default says
    const generated = (c.name !== 'tenant_id' || TENANT_ID_OPTIONAL_TABLES.includes(t.name)) && (c.dflt_value !== null || (c.pk === 1 && type === 'integer' && cols.filter((x) => x.pk).length === 1 && (c.name === 'seq')));
    const nullable = c.notnull === 0 && c.pk === 0;
    let full = nullable ? `${ty} | null` : ty;
    if (generated && t.name !== 'audit_log') full = `Generated<${full}>`;
    out += `  ${c.name}: ${full};\n`;
  }
  out += `}\n\n`;
}
out += `export interface MainDB {\n${main.map((t) => `  ${t}: ${pascal(t)};`).join('\n')}\n}\n\nexport interface AuditDB {\n${audit.map((t) => `  ${t}: ${pascal(t)};`).join('\n')}\n}\n\nexport type DB = MainDB & AuditDB;\n\n`;
const fmt = (ts: string[]) => ts.map((t) => `  ${t}: [${inv[t]!.map((c) => `'${c}'`).join(', ')}],`).join('\n');
out += `/** Runtime column inventory (the drift test compares it to the migrated schema). */\nexport const MAIN_TABLE_COLUMNS = {\n${fmt(main)}\n} as const satisfies { [T in keyof MainDB]: readonly (keyof MainDB[T])[] };\n\nexport const AUDIT_TABLE_COLUMNS = {\n${fmt(audit)}\n} as const satisfies { [T in keyof AuditDB]: readonly (keyof AuditDB[T])[] };\n\n`;
out += `/** Dialect-specific extras that exist only in one engine (not in the shared inventory). */\nexport const SQLITE_ONLY_TABLES = ['tools_fts', 'audit_fts'] as const;\nexport const POSTGRES_ONLY_COLUMNS = { tools: ['search_tsv'], audit_log: ['params_tsv'] } as const;\n`;
fs.writeFileSync('src/kernel/db/schema.ts', out);
console.log('tables', main.length, audit.length);
void MAIN_MIGRATIONS; void AUDIT_MIGRATIONS;
await dbs.close();
