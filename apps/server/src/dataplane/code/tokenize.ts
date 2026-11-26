/**
 * A small Python tokenizer (backend spec §10.3, A10): enough to apply the script rules and to wrap
 * scripts, not a full parser. Handles string prefixes, triple quotes, f-string replacement fields,
 * comments, explicit (`\`) and implicit (bracket) line continuation, and indentation.
 */

export type TokenType = 'NAME' | 'NUMBER' | 'STRING' | 'OP' | 'NEWLINE' | 'INDENT' | 'DEDENT' | 'COMMENT';

export interface Token {
  type: TokenType;
  value: string;
  /** Offsets into the source ([start, end)). */
  start: number;
  end: number;
  /** 1-based position of `start`. */
  line: number;
  col: number;
  /** Bracket depth at the token (before it, for openers). */
  depth: number;
  /** Token comes from an f-string replacement field. */
  inFString?: boolean;
}

export interface TokenizeError {
  line: number;
  col: number;
  message: string;
}

export interface TokenizeResult {
  tokens: Token[];
  errors: TokenizeError[];
  /** Deepest indentation level seen (number of nested blocks). */
  maxIndentLevel: number;
  /** Deepest bracket nesting seen. */
  maxBracketDepth: number;
}

const OPS3 = ['**=', '//=', '>>=', '<<=', '...', '!=='];
const OPS2 = ['**', '//', '>>', '<<', '<=', '>=', '==', '!=', '->', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '@=', ':='];
const OPS1 = '+-*/%@&|^~<>()[]{},:;.=!';
const OPENERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSERS = new Set([')', ']', '}']);
const STRING_START = /([rRbBuUfFtT]{1,2})?('''|"""|'|")/y;
const NAME_RE = /[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*/y;
const NUMBER_RE = /(?:0[xX][0-9a-fA-F_]+|0[oO][0-7_]+|0[bB][01_]+|(?:\d[\d_]*\.?[\d_]*|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?[jJ]?)/y;

export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(src: string) {
    for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) this.starts.push(i + 1);
  }
  pos(offset: number): { line: number; col: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, col: offset - this.starts[lo]! + 1 };
  }
  get lineCount(): number {
    return this.starts.length;
  }
}

export function tokenize(src: string): TokenizeResult {
  const idx = new LineIndex(src);
  const out: TokenizeResult = { tokens: [], errors: [], maxIndentLevel: 0, maxBracketDepth: 0 };
  scan(src, 0, src.length, false, idx, out);
  return out;
}

function scan(src: string, from: number, to: number, exprMode: boolean, idx: LineIndex, out: TokenizeResult): void {
  const brackets: Array<{ ch: string; at: number }> = [];
  const indents = [0];
  let i = from;
  let atLineStart = !exprMode;
  const push = (type: TokenType, value: string, start: number, end: number) => {
    const p = idx.pos(start);
    out.tokens.push({ type, value, start, end, line: p.line, col: p.col, depth: brackets.length + (exprMode ? 1 : 0), ...(exprMode ? { inFString: true } : {}) });
  };
  const err = (at: number, message: string) => {
    const p = idx.pos(at);
    out.errors.push({ line: p.line, col: p.col, message });
  };
  const lastSignificant = () => {
    for (let k = out.tokens.length - 1; k >= 0; k--) if (out.tokens[k]!.type !== 'COMMENT') return out.tokens[k];
    return undefined;
  };

  while (i < to) {
    if (atLineStart && brackets.length === 0) {
      // measure indentation
      let width = 0;
      let j = i;
      while (j < to && (src[j] === ' ' || src[j] === '\t' || src[j] === '\f')) {
        width = src[j] === '\t' ? (Math.floor(width / 8) + 1) * 8 : src[j] === ' ' ? width + 1 : 0;
        j++;
      }
      const ch = src[j];
      if (j >= to || ch === '\n' || ch === '\r' || ch === '#') {
        // blank or comment-only line: no indentation tokens
        i = j;
        atLineStart = false;
        if (j >= to) break;
        continue;
      }
      const cur = indents[indents.length - 1]!;
      if (width > cur) {
        indents.push(width);
        out.maxIndentLevel = Math.max(out.maxIndentLevel, indents.length - 1);
        push('INDENT', '', j, j);
      } else if (width < cur) {
        while (indents.length > 1 && width < indents[indents.length - 1]!) {
          indents.pop();
          push('DEDENT', '', j, j);
        }
        if (width !== indents[indents.length - 1]) err(j, 'unindent does not match any outer indentation level');
      }
      i = j;
      atLineStart = false;
      continue;
    }
    const c = src[i]!;
    if (c === '\n') {
      if (!exprMode && brackets.length === 0) {
        const last = lastSignificant();
        if (last && last.type !== 'NEWLINE' && last.type !== 'INDENT' && last.type !== 'DEDENT') push('NEWLINE', '\n', i, i + 1);
      }
      atLineStart = true;
      i++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r' || c === '\f') {
      i++;
      continue;
    }
    if (c === '#') {
      let j = i;
      while (j < to && src[j] !== '\n') j++;
      push('COMMENT', src.slice(i, j), i, j);
      i = j;
      continue;
    }
    if (c === '\\') {
      if (src[i + 1] === '\n' || (src[i + 1] === '\r' && src[i + 2] === '\n')) {
        // the next physical line continues this logical line: no NEWLINE, no indentation tokens
        i += src[i + 1] === '\n' ? 2 : 3;
        continue;
      }
      err(i, 'unexpected character after line continuation character');
      i++;
      continue;
    }
    STRING_START.lastIndex = i;
    const sm = STRING_START.exec(src);
    if (sm && sm.index === i && (sm[1] === undefined || /^(?:[rRuUbBfFtT]|[rR][bBfFtT]|[bBfFtT][rR])$/.test(sm[1]))) {
      const prefix = (sm[1] ?? '').toLowerCase();
      const quote = sm[2]!;
      const raw = prefix.includes('r');
      const isF = prefix.includes('f') || prefix.includes('t');
      const bodyStart = i + sm[0].length;
      const end = findStringEnd(src, bodyStart, to, quote, raw);
      if (end < 0) {
        err(i, quote.length === 3 ? 'unterminated triple-quoted string literal' : 'unterminated string literal');
        // skip to end of line to resync
        let j = i;
        while (j < to && src[j] !== '\n') j++;
        i = j;
        continue;
      }
      push('STRING', src.slice(i, end), i, end);
      if (isF) scanFStringFields(src, bodyStart, end - quote.length, idx, out);
      i = end;
      continue;
    }
    NAME_RE.lastIndex = i;
    const nm = /[A-Za-z_\u0080-￿]/.test(c) ? NAME_RE.exec(src) : null;
    if (nm && nm.index === i) {
      push('NAME', nm[0], i, i + nm[0].length);
      i += nm[0].length;
      continue;
    }
    if (/\d/.test(c) || (c === '.' && /\d/.test(src[i + 1] ?? ''))) {
      NUMBER_RE.lastIndex = i;
      const m = NUMBER_RE.exec(src);
      const len = m && m.index === i ? m[0].length : 1;
      push('NUMBER', src.slice(i, i + len), i, i + len);
      i += len;
      continue;
    }
    const op = OPS3.find((o) => src.startsWith(o, i)) ?? OPS2.find((o) => src.startsWith(o, i)) ?? (OPS1.includes(c) ? c : null);
    if (op) {
      if (OPENERS[op]) {
        push('OP', op, i, i + 1);
        brackets.push({ ch: op, at: i });
        out.maxBracketDepth = Math.max(out.maxBracketDepth, brackets.length);
      } else if (CLOSERS.has(op)) {
        const open = brackets.pop();
        if (!open) err(i, `unmatched '${op}'`);
        else if (OPENERS[open.ch] !== op) err(i, `closing parenthesis '${op}' does not match opening parenthesis '${open.ch}'`);
        push('OP', op, i, i + 1);
      } else push('OP', op, i, i + op.length);
      i += op.length;
      continue;
    }
    err(i, `invalid character '${c}'`);
    i++;
  }
  if (!exprMode) {
    for (const b of brackets) err(b.at, `'${b.ch}' was never closed`);
    const last = lastSignificant();
    if (last && last.type !== 'NEWLINE' && last.type !== 'DEDENT') push('NEWLINE', '', to, to);
    while (indents.length > 1) {
      indents.pop();
      push('DEDENT', '', to, to);
    }
  }
}

/** Index just after the closing quote, or -1 when unterminated. */
function findStringEnd(src: string, from: number, to: number, quote: string, raw: boolean): number {
  const triple = quote.length === 3;
  const q = quote[0]!;
  let i = from;
  while (i < to) {
    const c = src[i]!;
    if (c === '\\') {
      i += 2; // in raw strings a backslash still prevents the quote from closing the string
      continue;
    }
    if (!triple && c === '\n') return -1;
    if (c === q && (!triple || (src[i + 1] === q && src[i + 2] === q))) return i + quote.length;
    i++;
    void raw;
  }
  return -1;
}

/** Finds `{expr}` fields in an f-string body (`{{` is a literal brace) and tokenizes each expression. */
function scanFStringFields(src: string, from: number, to: number, idx: LineIndex, out: TokenizeResult): void {
  let i = from;
  while (i < to) {
    const c = src[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '{') {
      if (src[i + 1] === '{') {
        i += 2;
        continue;
      }
      // find the matching close brace, skipping nested brackets and strings
      let depth = 0;
      let j = i + 1;
      while (j < to) {
        const d = src[j]!;
        if (d === "'" || d === '"') {
          const k = src.indexOf(d, j + 1);
          j = k < 0 || k >= to ? to : k + 1;
          continue;
        }
        if (d === '{' || d === '[' || d === '(') depth++;
        else if (d === ']' || d === ')') depth--;
        else if (d === '}') {
          if (depth === 0) break;
          depth--;
        }
        j++;
      }
      scan(src, i + 1, Math.min(j, to), true, idx, out);
      i = j + 1;
      continue;
    }
    i++;
  }
}
