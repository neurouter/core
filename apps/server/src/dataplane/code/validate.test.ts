import { describe, expect, it } from 'vitest';
import { tokenize } from './tokenize.js';
import { validateScript, type ScriptViolation } from './validate.js';

const NS = { namespaces: ['github', 'ops'] };
const errs = (code: string): ScriptViolation[] => {
  const r = validateScript(code, NS);
  return r.ok ? [] : r.errors;
};

describe('validateScript: rejected constructs', () => {
  it('rejects `import os` at line 1 with a hint naming the namespaces', () => {
    const [e] = errs('import os\nreturn 1');
    expect(e).toMatchObject({ line: 1, col: 1, rule: 'import' });
    expect(e!.hint).toBe('Tools are already available as github.<fn> and ops.<fn>; remove the import.');
  });

  it.each([
    ['from os import path', 'import', 1, 1],
    ['x = 1\n  \nif x:\n    from os import path', 'import', 4, 5],
    ['__import__("os")', 'import', 1, 1],
    ['class A:\n    pass', 'class', 1, 1],
    ['x = ().__class__', 'dunder', 1, 8],
    ['__builtins__', 'dunder', 1, 1],
    ['async def f():\n    pass', 'async', 1, 1],
    ['def f():\n    await g()', 'async', 2, 5],
    ['def f():\n    yield 1', 'yield', 2, 5],
    ['def f():\n    global x', 'scope', 2, 5],
    ['def f():\n    nonlocal x', 'scope', 2, 5],
  ])('%j → %s at %d:%d', (code, rule, line, col) => {
    const e = errs(code)[0];
    expect(e).toMatchObject({ rule, line, col });
    expect(e!.hint.length).toBeGreaterThan(10);
  });

  it.each(['globals', 'locals', 'vars', 'eval', 'exec', 'compile', 'open', 'input', 'breakpoint', 'getattr', 'setattr', 'delattr', 'memoryview', 'help'])('rejects the built-in %s', (name) => {
    const e = errs(`x = 1\ny = ${name}(x)`)[0];
    expect(e).toMatchObject({ rule: 'builtin', line: 2, col: 5 });
    expect(e!.hint).toMatch(/len, range/);
  });

  it('allows type(x) (one argument) and iter/next; rejects the class-building type(name, bases, dict)', () => {
    expect(validateScript('r = github.get(x=1)\nif type(r) == dict and isinstance(r, dict):\n    it = iter(r.get("items", []))\n    return next(it, None)\nreturn type(f(a, b)) == list', NS)).toEqual({ ok: true });
    expect(validateScript('return type(x,)', NS)).toEqual({ ok: true });
    const e = errs('X = type("X", (), {})')[0];
    expect(e).toMatchObject({ rule: 'builtin', line: 1, col: 5, message: 'type() takes one argument in scripts' });
  });

  it('allows forbidden names as keyword arguments, attributes and string content', () => {
    expect(validateScript('r = github.search(type="pr", open=True)\nx = r.type\ns = "eval(import os)"\nreturn x', NS)).toEqual({ ok: true });
  });

  it('allows raise … from, lambda, print, comprehensions and ops.parallel', () => {
    const code = [
      'nums = [i for i in range(3)]',
      'f = lambda x: x * 2',
      'print("hello", f(2))',
      'try:',
      '    x = 1',
      'except RuntimeError as e:',
      '    raise ValueError("bad") from e',
      'res = ops.parallel([("github.get_issue", {"issue_number": n}) for n in nums])',
      'return {"n": len(res)}',
    ].join('\n');
    expect(validateScript(code, NS)).toEqual({ ok: true });
  });

  it('looks inside f-string replacement fields', () => {
    expect(errs('x = f"{eval(\'1\')}"')[0]).toMatchObject({ rule: 'builtin', line: 1, col: 8 });
    expect(errs('x = f"{().__class__}"')[0]).toMatchObject({ rule: 'dunder' });
    expect(validateScript('x = 3\ny = f"{{literal}} {x:>4} {x!r}"\nreturn y', NS)).toEqual({ ok: true });
  });

  it('does not see keywords in comments or strings', () => {
    expect(validateScript('# import os\nx = """\nimport os\nclass X\n"""\nreturn x', NS)).toEqual({ ok: true });
  });

  it('enforces size, line count and nesting limits', () => {
    expect(errs('x = 1\n'.repeat(3000))[0]).toMatchObject({ rule: 'size' });
    expect(errs('x = 1\n'.repeat(401))[0]).toMatchObject({ rule: 'lines', line: 401 });
    expect(validateScript('x = 1\n'.repeat(400), NS)).toEqual({ ok: true });
    let deep = '';
    for (let d = 0; d < 13; d++) deep += `${' '.repeat(4 * d)}if True:\n`;
    deep += `${' '.repeat(52)}pass`;
    expect(errs(deep)[0]).toMatchObject({ rule: 'nesting' });
    expect(errs(`x = ${'['.repeat(13)}${']'.repeat(13)}`)[0]).toMatchObject({ rule: 'nesting' });
  });

  it('rejects non-UTF-8 text (lone surrogates, NUL)', () => {
    expect(errs('x = "\uD800"')[0]).toMatchObject({ rule: 'encoding' });
    expect(errs('x = 1\0')[0]).toMatchObject({ rule: 'encoding' });
  });

  it('reports tokenizer errors with positions', () => {
    expect(errs('x = "abc\nreturn x')[0]).toMatchObject({ rule: 'syntax', line: 1, col: 5 });
    expect(errs('x = (1, 2')[0]).toMatchObject({ rule: 'syntax', line: 1, col: 5 });
    expect(errs('if x:\n        a = 1\n    b = 2')[0]).toMatchObject({ rule: 'syntax', line: 3 });
  });

  it('reports several violations in source order', () => {
    const e = errs('import os\nclass A:\n    pass\nx = eval("1")');
    expect(e.map((x) => x.rule)).toEqual(['import', 'class', 'builtin']);
  });
});

describe('tokenize', () => {
  it('handles prefixes, triple quotes, continuations and indentation', () => {
    const { tokens, errors } = tokenize('s = rb"\\x" + b\'y\'\nt = """a\n"b"\n"""\nu = 1 + \\\n  2\nif u:\n    v = (1,\n2)\n');
    expect(errors).toEqual([]);
    const types = tokens.map((t) => t.type);
    expect(types.filter((t) => t === 'STRING')).toHaveLength(3);
    expect(types.filter((t) => t === 'INDENT')).toHaveLength(1);
    expect(types.filter((t) => t === 'DEDENT')).toHaveLength(1);
    expect(tokens.filter((t) => t.type === 'NEWLINE')).toHaveLength(5);
  });
});
