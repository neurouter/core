/**
 * Built-ins a `run_script` script can use (verified against the pinned Monty: `type` with one
 * argument, `iter`/`next` included). Names Monty lacks (`map`, `filter`, `getattr`, `hasattr`,
 * `callable`, `format`) are rejected by the type check with a hint naming these.
 */
export const SCRIPT_BUILTINS = [
  'len', 'range', 'enumerate', 'zip', 'sorted', 'reversed', 'min', 'max', 'sum', 'any', 'all', 'abs', 'round', 'divmod', 'pow',
  'int', 'float', 'str', 'bool', 'list', 'dict', 'set', 'frozenset', 'tuple', 'isinstance', 'type', 'iter', 'next', 'repr', 'chr', 'ord', 'hex', 'print',
] as const;

/** Python built-ins scripts may reach for that are not available, with what to use instead. */
export const SCRIPT_BUILTIN_ALTERNATIVES: Record<string, string> = {
  map: 'use a list comprehension: [f(x) for x in xs]',
  filter: 'use a list comprehension: [x for x in xs if cond(x)]',
  getattr: 'tool results are dicts: use d["key"] or d.get("key")',
  hasattr: 'tool results are dicts: use "key" in d',
  setattr: 'tool results are dicts: use d["key"] = value',
  callable: 'not needed: tool functions are known from search_tools',
  format: 'use an f-string: f"{x:.2f}"',
  open: 'scripts have no files or network; call the tool functions',
};

/** One line for docs and errors: what scripts can use. */
export function scriptBuiltinsLine(): string {
  return `Built-ins: ${SCRIPT_BUILTINS.join(', ')} (type takes one argument). No map/filter (use comprehensions), no getattr/hasattr (results are dicts).`;
}
