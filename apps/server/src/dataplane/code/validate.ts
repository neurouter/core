import { LineIndex, tokenize, type Token } from './tokenize.js';

/**
 * Server-side source validation for `run_script` (backend spec §10.3). Runs before the executor sees
 * the code. Monty (no I/O) remains the real language boundary; this keeps scripts inside the plan's
 * subset and gives agents precise, fixable errors.
 */

export const MAX_SCRIPT_BYTES = 16 * 1024;
export const MAX_SCRIPT_LINES = 400;
export const MAX_NESTING = 12;

export const ALLOWED_BUILTINS = ['len', 'range', 'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max', 'sum', 'any', 'all', 'abs', 'round', 'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'tuple', 'isinstance', 'print'] as const;

const FORBIDDEN_NAMES = new Set(['globals', 'locals', 'vars', 'eval', 'exec', 'compile', 'open', 'input', 'breakpoint', 'getattr', 'setattr', 'delattr', 'type', 'memoryview', 'help']);

export interface ScriptViolation {
  line: number;
  col: number;
  message: string;
  hint: string;
  rule: string;
}

export type ValidationResult = { ok: true } | { ok: false; errors: ScriptViolation[] };

export interface ValidateOptions {
  /** Namespaces available to the script (e.g. `['github', 'ops']`), used in hints. */
  namespaces?: string[];
  /** Max errors reported (default 20). */
  maxErrors?: number;
}

export function validateScript(code: string, opts: ValidateOptions = {}): ValidationResult {
  const errors: ScriptViolation[] = [];
  const ns = opts.namespaces?.length ? opts.namespaces : ['<ns>'];
  const nsHint = ns.map((n) => `${n}.<fn>`).join(' and ');
  const add = (line: number, col: number, rule: string, message: string, hint: string) => errors.push({ line, col, rule, message, hint });

  if (code.includes('\0') || !code.isWellFormed()) {
    add(1, 1, 'encoding', 'Script is not valid UTF-8 text', 'Send the script as plain UTF-8 text without NUL characters.');
    return { ok: false, errors };
  }
  const bytes = Buffer.byteLength(code, 'utf8');
  if (bytes > MAX_SCRIPT_BYTES) add(1, 1, 'size', `Script is ${bytes} bytes; the limit is ${MAX_SCRIPT_BYTES} bytes (16 KiB)`, 'Shorten the script: do less per run, or split it into several runs.');
  const lines = new LineIndex(code.replace(/\n$/, '')).lineCount;
  if (lines > MAX_SCRIPT_LINES) add(MAX_SCRIPT_LINES + 1, 1, 'lines', `Script has ${lines} lines; the limit is ${MAX_SCRIPT_LINES}`, 'Shorten the script or split it into several runs.');
  if (errors.length) return { ok: false, errors };

  const tk = tokenize(code);
  for (const e of tk.errors) add(e.line, e.col, 'syntax', `Syntax error: ${e.message}`, 'Check quotes, brackets and indentation near this position.');
  if (tk.maxIndentLevel > MAX_NESTING) {
    const t = tk.tokens.find((x) => x.type === 'INDENT');
    add(t?.line ?? 1, 1, 'nesting', `Blocks are nested more than ${MAX_NESTING} levels deep`, 'Flatten the logic: use helper functions or early returns.');
  }
  if (tk.maxBracketDepth > MAX_NESTING) add(1, 1, 'nesting', `Brackets are nested more than ${MAX_NESTING} levels deep`, 'Build nested values in several steps.');

  const toks = tk.tokens.filter((t) => t.type !== 'COMMENT');
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]!;
    if (t.type !== 'NAME') continue;
    const prev = toks[k - 1];
    const startsLine = !prev || prev.type === 'NEWLINE' || prev.type === 'INDENT' || prev.type === 'DEDENT' || (prev.type === 'OP' && prev.value === ';');
    const isAttr = prev?.type === 'OP' && prev.value === '.';
    switch (t.value) {
      case 'import':
        add(t.line, t.col, 'import', 'Imports are not allowed', `Tools are already available as ${nsHint}; remove the import.`);
        continue;
      case 'from':
        if (startsLine && !t.inFString) add(t.line, t.col, 'import', 'Imports are not allowed', `Tools are already available as ${nsHint}; remove the import.`);
        continue;
      case 'class':
        add(t.line, t.col, 'class', 'Classes are not allowed', 'Classes are not allowed; use dicts.');
        continue;
      case 'async':
      case 'await':
        add(t.line, t.col, 'async', `'${t.value}' is not allowed`, 'Scripts are synchronous: call tools directly, and use ops.parallel([...]) to run calls concurrently.');
        continue;
      case 'yield':
        add(t.line, t.col, 'yield', "'yield' is not allowed (no generators)", 'Build a list and return it instead of yielding values.');
        continue;
      case 'global':
      case 'nonlocal':
        add(t.line, t.col, 'scope', `'${t.value}' is not allowed`, 'Pass values as function arguments and return results instead.');
        continue;
    }
    if (t.value.includes('__')) {
      if (t.value === '__import__') add(t.line, t.col, 'import', '__import__ is not allowed', `Tools are already available as ${nsHint}; remove the import.`);
      else add(t.line, t.col, 'dunder', `Names containing '__' are not allowed ('${t.value}')`, 'Dunder attributes and names are not available in scripts; rename the variable.');
      continue;
    }
    if (FORBIDDEN_NAMES.has(t.value) && !isAttr && !isKeywordArgument(toks, k)) {
      add(t.line, t.col, 'builtin', `'${t.value}' is not available in scripts`, `Use tool functions (${nsHint}) and the allowed built-ins: ${ALLOWED_BUILTINS.join(', ')}.`);
    }
  }
  if (!errors.length) return { ok: true };
  errors.sort((a, b) => a.line - b.line || a.col - b.col);
  return { ok: false, errors: errors.slice(0, opts.maxErrors ?? 20) };
}

/** `name=` inside brackets (a keyword argument or a parameter default), e.g. `github.search(type="pr")`. */
function isKeywordArgument(toks: Token[], k: number): boolean {
  const t = toks[k]!;
  const next = toks[k + 1];
  if (t.depth === 0 || !next || next.type !== 'OP' || next.value !== '=') return false;
  const prev = toks[k - 1];
  return !!prev && prev.type === 'OP' && (prev.value === '(' || prev.value === ',' || prev.value === '*' || prev.value === '**');
}
