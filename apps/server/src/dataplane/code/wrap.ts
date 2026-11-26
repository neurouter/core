import { tokenize, type Token } from './tokenize.js';

/**
 * Wraps a script so a top-level `return` works (A9): the code becomes the body of
 * `def __neurouter_main__():` (indented by 4 spaces) followed by `__neurouter_main__()`. When the
 * script has no `return`, a trailing bare expression is turned into `return <expr>`. Lines inside
 * multi-line strings are not re-indented, so string values are unchanged.
 */

export const WRAPPER_FN = '__neurouter_main__';
const INDENT = '    ';

export interface WrappedScript {
  code: string;
  /** Lines before the user's first line (the `def` line). */
  lineOffset: number;
  /** Columns added to the user's lines. */
  colOffset: number;
  /** A trailing expression was turned into `return`. */
  returnInjected: boolean;
  /** Wrapped-code line → user line (clamped to the script). */
  mapLine(line: number): number;
}

const STATEMENT_KEYWORDS = new Set([
  'return', 'if', 'elif', 'else', 'for', 'while', 'def', 'try', 'except', 'finally', 'with', 'pass', 'break', 'continue',
  'raise', 'del', 'assert', 'import', 'from', 'class', 'global', 'nonlocal', 'async', 'match', 'case', 'type',
]);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '//=', '%=', '**=', '>>=', '<<=', '&=', '|=', '^=', '@=']);

export function wrapScript(source: string): WrappedScript {
  const src = source.replace(/\r\n/g, '\n');
  const userLines = src.split('\n');
  const { tokens } = tokenize(src);
  const sig = tokens.filter((t) => t.type !== 'COMMENT');

  // physical lines that begin inside a multi-line string: keep them byte-for-byte
  const keep = new Set<number>();
  for (const t of tokens) {
    if (t.type !== 'STRING') continue;
    const endLine = t.line + (t.value.match(/\n/g)?.length ?? 0);
    for (let l = t.line + 1; l <= endLine; l++) keep.add(l);
  }

  let insertAt = -1;
  const hasReturn = sig.some((t) => t.type === 'NAME' && t.value === 'return' && !t.inFString);
  if (!hasReturn) {
    const stmt = lastTopLevelSimpleStatement(sig);
    if (stmt && isExpressionStatement(stmt)) insertAt = stmt[0]!.start;
  }
  let body = insertAt >= 0 ? `${src.slice(0, insertAt)}return ${src.slice(insertAt)}` : src;
  const bodyLines = body.split('\n');
  const hasCode = sig.some((t) => t.type !== 'NEWLINE' && t.type !== 'INDENT' && t.type !== 'DEDENT');
  body = bodyLines.map((l, i) => (keep.has(i + 1) ? l : l.trim() ? INDENT + l : '')).join('\n');
  if (!hasCode) body += `\n${INDENT}return None`;
  const code = `def ${WRAPPER_FN}():\n${body}\n${WRAPPER_FN}()\n`;
  const n = userLines.length;
  return { code, lineOffset: 1, colOffset: INDENT.length, returnInjected: insertAt >= 0, mapLine: (line) => Math.min(Math.max(1, line - 1), Math.max(1, n)) };
}

/** Tokens of the last simple statement at indentation level 0 (after the last top-level `;`). */
function lastTopLevelSimpleStatement(sig: Token[]): Token[] | null {
  let level = 0;
  let current: Token[] = [];
  let last: Token[] | null = null;
  for (const t of sig) {
    if (t.inFString) {
      if (current.length) current.push(t);
      continue;
    }
    if (t.type === 'INDENT') {
      level++;
      continue;
    }
    if (t.type === 'DEDENT') {
      level--;
      continue;
    }
    if (t.type === 'NEWLINE') {
      if (current.length) last = current;
      current = [];
      continue;
    }
    if (level !== 0) {
      // a nested block belongs to the previous top-level compound statement
      last = null;
      current = [];
      continue;
    }
    if (t.type === 'OP' && t.value === ';' && t.depth === 0) {
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length) last = current;
  return last;
}

function isExpressionStatement(stmt: Token[]): boolean {
  const first = stmt[0]!;
  if (first.type === 'NAME' && STATEMENT_KEYWORDS.has(first.value)) {
    // soft keywords used as plain names (`type(x)`, `match`) are expressions unless the line is a block header
    if (!(first.value === 'match' || first.value === 'case' || first.value === 'type')) return false;
  }
  if (first.type === 'OP' && first.value === '@') return false;
  const top = stmt.filter((t) => t.depth === 0 && !t.inFString);
  const hasLambda = stmt.some((t) => t.type === 'NAME' && t.value === 'lambda');
  for (const t of top) {
    if (t.type !== 'OP') continue;
    if (ASSIGN_OPS.has(t.value)) return false;
    if (t.value === ':' && !hasLambda) return false;
  }
  return true;
}
