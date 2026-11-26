/** Tool and argument naming (backend spec §8.1). */

const MAX = 64;

/** camelCase / kebab / slash / dotted → snake_case with only [a-z0-9_]. */
export function snakeCase(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .toLowerCase()
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** A valid exposed tool name: ^[a-z][a-z0-9_]{0,63}$ */
export function toToolName(input: string): string {
  let s = snakeCase(input).replace(/^[0-9_]+/, '');
  if (!s) s = 'op';
  if (!/^[a-z]/.test(s)) s = `op_${s}`;
  return s.slice(0, MAX).replace(/_+$/, '');
}

/** `<method>_<path segments>`, `{param}` → `by_param`. */
export function nameFromMethodPath(method: string, path: string): string {
  const segs = path
    .split('/')
    .filter(Boolean)
    .map((s) => {
      const m = /^\{(.+)\}$/.exec(s);
      return m ? `by_${snakeCase(m[1]!)}` : snakeCase(s);
    });
  return toToolName([method.toLowerCase(), ...segs].join('_'));
}

/** Assigns `_2`, `_3`, … suffixes to repeated names in order; returns the names and which were renamed. */
export function uniquify(names: string[]): { names: string[]; collided: number[] } {
  const seen = new Map<string, number>();
  const used = new Set(names);
  const out: string[] = [];
  const collided: number[] = [];
  names.forEach((n, i) => {
    const count = seen.get(n) ?? 0;
    seen.set(n, count + 1);
    if (count === 0) {
      out.push(n);
      return;
    }
    let k = count + 1;
    let candidate = `${n.slice(0, MAX - 1 - String(k).length)}_${k}`;
    while (used.has(candidate)) {
      k++;
      candidate = `${n.slice(0, MAX - 1 - String(k).length)}_${k}`;
    }
    used.add(candidate);
    out.push(candidate);
    collided.push(i);
  });
  return { names: out, collided };
}

/** Python namespace for a server slug (`my-api` → `my_api`). */
export function pyNamespace(slug: string): string {
  const s = slug.replace(/-/g, '_').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(s) ? s : `_${s}`;
}

export const PY_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except',
  'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try',
  'while', 'with', 'yield',
]);

/** Python-safe identifier for an argument / field name (keywords get a `_` suffix). */
export function pyIdent(name: string): string {
  let s = name.replace(/[^A-Za-z0-9_]/g, '_');
  if (!/^[A-Za-z_]/.test(s)) s = `_${s}`;
  if (PY_KEYWORDS.has(s)) s = `${s}_`;
  return s;
}

const VERBS = new Set(
  'get list create update delete remove add set find search upload download login logout log place check fetch read write put patch post replace start stop run cancel close open merge move copy rename archive unarchive restore enable disable lock unlock approve reject request submit send mark star unstar follow unfollow watch block unblock transfer sync generate render compare review dismiss revoke rotate reset test verify validate count export import invite accept decline assign unassign label unlabel publish unpublish pin unpin subscribe unsubscribe register deregister rerun retry resolve reopen convert redeliver ping list_all query mutate edit apply calculate compute triage show describe return retrieve lookup look summarize'.split(
    ' ',
  ),
);

/** True when the word is (a form of) a common API verb: `list`, `lists`, `listing`, `created`. */
export function isVerb(word: string): boolean {
  const w = word.toLowerCase();
  if (VERBS.has(w)) return true;
  for (const suf of ['s', 'es', 'd', 'ed', 'ing']) if (w.endsWith(suf) && VERBS.has(w.slice(0, -suf.length))) return true;
  if (w.endsWith('ies') && VERBS.has(w.slice(0, -3) + 'y')) return true;
  if (w.endsWith('ing') && VERBS.has(w.slice(0, -3) + 'e')) return true;
  return false;
}

/** Effect verbs that make a write destructive (irreversible or hard to undo). */
export const DESTRUCTIVE_VERBS = ['cancel', 'delete', 'remove', 'close', 'merge', 'refund', 'revoke', 'archive', 'void', 'reset', 'overwrite', 'purge', 'destroy', 'terminate', 'wipe', 'erase', 'disable', 'deactivate', 'suspend', 'reject', 'decline', 'expire', 'unpublish', 'uninstall', 'unlink', 'detach'] as const;

/**
 * The destructive effect verb in a write's name or summary (`cancel_order`, "Refund a charge"), or
 * null. Words are matched whole (snake_case/camelCase split), so "disclosure" is not "close".
 */
export function destructiveVerb(...texts: Array<string | null | undefined>): string | null {
  const words = new Set(
    texts
      .filter((t): t is string => typeof t === 'string')
      .flatMap((t) => t.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/))
      .filter(Boolean),
  );
  for (const v of DESTRUCTIVE_VERBS) if (words.has(v) || words.has(`${v}s`) || words.has(`${v}d`) || words.has(`${v}ed`)) return v;
  return null;
}
