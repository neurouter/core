import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const DATAPLANE = resolve(import.meta.dirname, '..');
const ENVELOPE = resolve(import.meta.dirname);

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sources(p));
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts') && !p.endsWith('.d.ts')) out.push(p);
  }
  return out;
}

/** Object literals that build an MCP tool result: `{ content: [...] }` or any `structuredContent:` property. */
export function rawToolResults(file: string, text: string): string[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const hits: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        if (!ts.isPropertyAssignment(p) && !ts.isShorthandPropertyAssignment(p)) continue;
        const name = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : '';
        const raw = (name === 'content' && ts.isPropertyAssignment(p) && ts.isArrayLiteralExpression(p.initializer)) || name === 'structuredContent';
        if (raw) hits.push(`${file}:${sf.getLineAndCharacterOfPosition(p.getStart()).line + 1} ${name}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return hits;
}

/**
 * no-raw-tool-result (contract-v2 §7), as a test: outside `dataplane/envelope/`, no data-plane module builds an
 * MCP tool result itself. Every producer answers through `envelope/v1.ts` (contract 1) plus a draft that the
 * dispatcher renders (contract 2), so no tool handler can bypass the envelope. The ESLint rule of the same name
 * flags it while editing; this keeps `npm test` failing too.
 */
describe('no tool handler bypasses the envelope module', () => {
  it('the detector finds raw results', () => {
    expect(rawToolResults('x.ts', "const r = { content: [{ type: 'text', text: 'x' }], isError: true };")).toEqual(['x.ts:1 content']);
    expect(rawToolResults('x.ts', 'const r = { structuredContent };')).toEqual(['x.ts:1 structuredContent']);
    expect(rawToolResults('x.ts', 'const r = v1Result(text, structured, meta);')).toEqual([]);
  });

  it('only dataplane/envelope builds tool results', () => {
    const files = sources(DATAPLANE).filter((f) => !f.startsWith(ENVELOPE));
    expect(files.length).toBeGreaterThan(20);
    const hits = files.flatMap((f) => rawToolResults(relative(DATAPLANE, f), readFileSync(f, 'utf8')));
    expect(hits).toEqual([]);
  });

  it('every producer returns a draft next to its v1 result (types), and the dispatcher has one exit', () => {
    const dispatch = readFileSync(join(DATAPLANE, 'mcp/dispatch.ts'), 'utf8');
    // call() is route() → finish(): the only place that picks contract 1 or the contract-2 renderer
    expect(dispatch).toMatch(/return this\.finish\(ctx, name, args, await this\.route\(/);
    expect(dispatch.match(/this\.renderer\.render\(/g)).toHaveLength(1);
    for (const [file, sig] of [
      ['pipeline/pipeline.ts', /draft: Draft;/],
      ['ops/ops.ts', /Promise<\{ result: McpToolResult; value: unknown; draft: Draft \}>/],
      ['code/run-script.ts', /export interface ScriptReply \{\s+result: McpToolResult;\s+draft: Draft;/],
    ] as const) {
      expect(readFileSync(join(DATAPLANE, file), 'utf8'), file).toMatch(sig);
    }
  });
});
