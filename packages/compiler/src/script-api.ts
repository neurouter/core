/**
 * Contract-2 script API (contract-v2 §5): what `run_script` code sees.
 *
 * - Agent-facing `.pyi` per namespace: snake_case keyword arguments (D8) and full docstrings (first sentence,
 *   Args with types/enums/defaults, Returns, Raises, Pages, Writes, one example).
 * - A Python prelude (fed before the user's code) that binds each namespace to Python objects: calling a
 *   function returns plain `data`; `fn.page(...)` returns a `Result` (`.data`, `.items`, `.page`, `.next()`,
 *   `.pages()`); `fn.pages(...)` returns the items of every page. Tool errors raise built-in exceptions under
 *   the ToolError names (aliases: the pinned Monty cannot subclass built-in exceptions, and exceptions carry no
 *   attributes there, so `ops.error(e)` returns the structured error).
 * - Type-check stubs for the user code that declare those objects precisely (wrong keyword names are still
 *   caught before any call).
 */
import { scriptBuiltinsLine, type JsonSchema, type ToolDef } from '@neurouter/shared';
import { leadSentences } from './describe.js';
import { pyIdent } from './naming.js';
import { functionParts, paramList, pyNameMap, pyType, returnSchema, TypeRegistry, MAX_TYPED_DICTS, type FunctionParts } from './stubs.js';
import { isObj, type Obj } from './util.js';
import { COMPILER_VERSION } from './version.js';

/** Envelope error code → the built-in exception it raises in scripts and the ToolError name(s) for it. */
export const SCRIPT_ERROR_CLASSES = [
  { name: 'NotFound', base: 'LookupError', codes: ['not_found'], doc: 'the id does not exist (the next call lists the parent collection)' },
  { name: 'InvalidArgs', base: 'ValueError', codes: ['invalid_args'], doc: 'an argument is invalid (error fields name each one; next is a corrected call)' },
  { name: 'UnknownFunction', base: 'AttributeError', codes: ['unknown_tool'], doc: 'no such function in this namespace' },
  { name: 'Forbidden', base: 'PermissionError', codes: ['forbidden', 'policy_denied', 'upstream_auth'], doc: 'not allowed for this credential or by a policy' },
  { name: 'WritesDisabled', base: 'PermissionError', codes: ['writes_disabled'], doc: 'writes are off in this environment' },
  { name: 'ConfirmationRequired', base: 'PermissionError', codes: ['confirmation_required', 'confirmation_declined', 'confirmation_unsupported'], doc: 'a destructive call needs the confirm token of its dry run (ops.error(e) has the plan)' },
  { name: 'Timeout', base: 'TimeoutError', codes: ['timeout'], doc: 'the API did not answer in time' },
  { name: 'RateLimited', base: 'RuntimeError', codes: ['rate_limited'], doc: 'too many calls; retry later (retry_after_ms)' },
  { name: 'UpstreamError', base: 'RuntimeError', codes: ['upstream_error', 'upstream_conflict', 'upstream_rejected', 'unavailable', 'too_large', 'limit_exceeded', 'script_error'], doc: 'the API failed or refused the request' },
] as const;

/** The built-in exception a tool error code raises in contract-2 scripts (P1 types kept: LookupError, ValueError, PermissionError, …). */
export function scriptErrorType(code: string): string {
  return SCRIPT_ERROR_CLASSES.find((c) => (c.codes as readonly string[]).includes(code))?.base ?? 'RuntimeError';
}

/** The ToolError class name for an error code (`not_found` → `NotFound`). */
export function scriptErrorClass(code: string): string {
  return SCRIPT_ERROR_CLASSES.find((c) => (c.codes as readonly string[]).includes(code))?.name ?? 'UpstreamError';
}

const ERROR_BASES = [...new Set(SCRIPT_ERROR_CLASSES.map((c) => c.base))];

export interface ScriptApiOptions {
  buildHash?: string;
  maxTypedDicts?: number;
  /** list tools page (`.page()` / `.pages()`); default: the return schema is an array or wraps one */
  isList?: (t: ToolDef) => boolean;
  /** a copy-ready example call (schema argument names), shown in the docstring */
  example?: (t: ToolDef) => Record<string, unknown> | null;
  /** destructive tools outside prod need the confirm token of their dry run */
  confirmTokens?: boolean;
}

/** A JSON value as a Python literal. */
export function pyValue(v: unknown): string {
  if (v === null || v === undefined) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'None';
  if (typeof v === 'string') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyValue).join(', ')}]`;
  if (isObj(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyValue(x)}`).join(', ')}}`;
  return 'None';
}

/** `acme.get_order(order_id="order_1")`: a call in Python with the contract-2 keyword names. */
export function pyCallText(t: ToolDef, args: Record<string, unknown>, ns?: string): string {
  const names = pyNameMap(t, { snake: true });
  const fn = ns ? `${ns}.${pyIdent(t.name)}` : t.pyName;
  return `${fn}(${Object.entries(args).map(([k, v]) => `${names[k] ?? pyIdent(k)}=${pyValue(v)}`).join(', ')})`;
}

/** The first sentence of a description's effect paragraph (a leading summary title is skipped; ≤ 300 chars). */
export function firstSentence(text: string): string {
  return leadSentences(text, 0);
}

/** The array a list tool's result wraps (`{items: [...], total_count}` → items schema), or the array itself. */
function listItemsSchema(rs: unknown): { prop: string | null; items: unknown } | null {
  if (!isObj(rs)) return null;
  if (rs.type === 'array') return { prop: null, items: rs.items };
  if (!isObj(rs.properties)) return null;
  const arrays = Object.entries(rs.properties).filter(([, v]) => isObj(v) && v.type === 'array');
  return arrays.length === 1 ? { prop: arrays[0]![0], items: (arrays[0]![1] as Obj).items } : null;
}

/** A list result: an array, Neurouter's wrapped array, or an object whose other keys are totals/cursors/links. */
function defaultIsList(t: ToolDef): boolean {
  if (t.risk.write || t.kind === 'composite') return false;
  const o = t.outputSchema;
  if (isObj(o) && typeof o['x-neurouter-wrapped'] === 'string') return true;
  const rs = returnSchema(t);
  const li = listItemsSchema(rs);
  if (!li) return false;
  if (!li.prop) return true;
  return topKeys(rs, 100).every((k) => k === li.prop || /total|count|cursor|next|page|has_?more|links?|token|offset/i.test(k));
}

function topKeys(schema: unknown, max = 10): string[] {
  if (!isObj(schema) || !isObj(schema.properties)) return [];
  return Object.keys(schema.properties).slice(0, max);
}

function shorten(s: string, n: number): string {
  const x = s.replace(/\s+/g, ' ').trim();
  return x.length <= n ? x : `${x.slice(0, n - 1)}…`;
}

/** Range/format notes of a parameter (enums are in its type). */
function constraint(s: JsonSchema): string {
  const bits: string[] = [];
  if (typeof s.minimum === 'number' && typeof s.maximum === 'number') bits.push(`${s.minimum}..${s.maximum}`);
  else if (typeof s.minimum === 'number') bits.push(`≥ ${s.minimum}`);
  else if (typeof s.maximum === 'number') bits.push(`≤ ${s.maximum}`);
  if (typeof s.maxLength === 'number') bits.push(`≤ ${s.maxLength} chars`);
  if (typeof s.format === 'string') bits.push(s.format);
  return bits.join(', ');
}

interface DocInput {
  tool: ToolDef;
  parts: FunctionParts;
  ns: string;
  list: boolean;
  example: Record<string, unknown> | null;
  confirmTokens: boolean;
}

/** Contract-2 docstring (Google style). */
export function docstringV2(d: DocInput): string {
  const { tool: t, parts, ns, list } = d;
  const fn = `${ns}.${parts.fn}`;
  const lines: string[] = [firstSentence(t.description) || t.title || t.name];
  if (parts.params.length) {
    lines.push('', 'Args:');
    for (const p of parts.params.slice(0, 15)) {
      const desc = typeof p.schema.description === 'string' ? shorten(p.schema.description, 120) : '';
      const c = constraint(p.schema);
      const head = `${p.py} (${p.type.replace(/ \| None$/, '')}${p.required ? ', required' : ''}${c ? `, ${c}` : ''}${!p.required && p.default !== 'None' ? `, default ${p.default}` : ''})`;
      lines.push(`    ${head}${desc ? `: ${desc}` : ''}`);
    }
    if (parts.params.length > 15) lines.push(`    … ${parts.params.length - 15} more`);
  }
  const rs = returnSchema(t);
  const li = listItemsSchema(rs);
  if (t.risk.write) lines.push('', 'Returns:', '    The API response (dict). In a dry run: {"plan": {target, effect, reversible, …}}.');
  else if (list && li) {
    const keys = topKeys(li.items);
    lines.push('', 'Returns:', `    ${li.prop ? `A dict with "${li.prop}" (list)${topKeys(rs).filter((k) => k !== li.prop).length ? ` and ${topKeys(rs).filter((k) => k !== li.prop).join(', ')}` : ''}` : 'A list'}${keys.length ? `; each item has ${keys.join(', ')}` : ''}.`);
  } else {
    const keys = topKeys(rs);
    if (keys.length) lines.push('', 'Returns:', `    A dict with ${keys.join(', ')}.`);
  }
  const raises: string[] = [];
  const hasPathId = t.binding.type === 'http' && /\{[^}]+\}/.test(t.binding.pathTemplate);
  if (hasPathId) raises.push(`    NotFound: no such ${t.binding.type === 'http' ? 'id' : 'entity'}; ops.error(e)["next"] is the list call.`);
  raises.push('    InvalidArgs: invalid arguments; ops.error(e)["fields"] names each, ["next"] is a corrected call.');
  if (t.risk.write) raises.push('    WritesDisabled: writes are off in this environment.');
  if (t.risk.destructive) raises.push('    ConfirmationRequired: not in the confirmed plan; ops.error(e)["plan"] says what it would change.');
  lines.push('', 'Raises:', ...raises);
  if (list) {
    lines.push('', 'Pages:', `    ${fn}.pages(..., max_items=500) returns the items of every page (one call per page);`, `    ${fn}.page(...) returns a Result: .data, .items, .page (count, total, has_more, next_cursor), .next().`);
  }
  if (t.risk.write) {
    lines.push('', 'Writes:', `    ${t.risk.destructive ? 'Irreversible. ' : ''}run_script(mode="dry_run") plans it without calling the API${t.risk.destructive && d.confirmTokens ? '; outside prod the run then needs the confirm token from that dry run' : ''}.`);
  }
  if (d.example) lines.push('', 'Example:', `    ${pyCallText(t, d.example, ns)}`);
  const text = lines.join('\n').replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `    """${text
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : `    ${l}`))
    .join('\n')}"""`;
}

/** Identifiers in a type expression → `<alias>.<name>` for the TypedDicts of the namespace module (strings kept). */
function qualify(type: string, names: ReadonlySet<string>, alias: string): string {
  return type.replace(/"(?:[^"\\]|\\.)*"|[A-Za-z_][A-Za-z0-9_]*/g, (m) => (m.startsWith('"') || !names.has(m) ? m : `${alias}.${m}`));
}

export interface ScriptApi {
  /** agent-facing `.pyi` of the namespace (also the executor module's stubs) */
  stubs: string;
  /** type-check declarations for the user code (`RunRequest.typeStubs`) */
  typeStubs: string;
  /** `def` lines per tool name (signature with snake_case keywords) */
  signatures: Record<string, string>;
  /** docstring bodies per tool name (search `detail: "full"`) */
  docs: Record<string, string>;
}

/** The contract-2 namespace stubs, signatures and type-check declarations for the given (visible, allowed) tools. */
export function scriptApi(tools: ToolDef[], ns: string, opts: ScriptApiOptions = {}): ScriptApi {
  const reg = new TypeRegistry(opts.maxTypedDicts ?? MAX_TYPED_DICTS);
  const isList = opts.isList ?? defaultIsList;
  const shown = tools.filter((t) => !t.hidden && t.kind !== 'composite');
  const parts = shown.map((t) => ({ t, p: functionParts(t, reg, { snake: true }), list: isList(t) }));
  // item types for `.pages()` (registered before the module text is rendered)
  const itemType = new Map<string, string>();
  for (const { t, list } of parts) {
    if (!list) continue;
    const li = listItemsSchema(returnSchema(t));
    const outDefs = isObj(t.outputSchema?.$defs) ? (t.outputSchema!.$defs as Obj) : {};
    itemType.set(t.name, li ? pyType(li.items, `${t.name}Item`, { reg, defs: outDefs, depth: 0, seenRefs: [] }) : 'Any');
  }
  const signatures: Record<string, string> = {};
  const docs: Record<string, string> = {};
  const fns = parts.map(({ t, p, list }) => {
    const args = paramList(p.params);
    const sig = `def ${p.fn}(${args.length ? `*, ${args.join(', ')}` : ''}) -> ${p.ret}`;
    signatures[t.name] = sig;
    const doc = docstringV2({ tool: t, parts: p, ns, list, example: opts.example?.(t) ?? null, confirmTokens: opts.confirmTokens ?? false });
    docs[t.name] = doc.replace(/^ {4}"""|"""$/g, '').replace(/\n {4}/g, '\n');
    return `${sig}:\n${doc}\n`;
  });
  const header = [
    `# ${ns}.pyi  (generated; Neurouter compiler ${COMPILER_VERSION}; contract 2${opts.buildHash ? `; build ${opts.buildHash.slice(0, 12)}` : ''})`,
    `# Call as ${ns}.<function>(name=value, ...): keyword arguments only; results are plain data (whole values, no cuts).`,
    `# Lists: ${ns}.<fn>.pages(..., max_items=500) → all items; ${ns}.<fn>.page(...) → Result(.data, .items, .page, .next()).`,
    `# Errors: except NotFound / InvalidArgs / Forbidden / WritesDisabled / ConfirmationRequired / RateLimited / Timeout / UpstreamError, or ToolError for all; ops.error(e) → {code, message, next, fields, retry, …}.`,
    `# ${scriptBuiltinsLine(2)}`,
    'from typing import Any, Literal, NotRequired, TypedDict',
    '',
  ].join('\n');
  const stubs = [header, ...reg.classes, ...fns].join('\n');

  // type-check declarations: each function is an object with __call__/page/pages; TypedDicts come from the module
  const alias = `_nr_t_${ns}`;
  const names = new Set(reg.classes.map((c) => /^(?:class ([A-Za-z_][A-Za-z0-9_]*)|([A-Za-z_][A-Za-z0-9_]*) = TypedDict)/.exec(c)).map((m) => m?.[1] ?? m?.[2]).filter((x): x is string => Boolean(x)));
  const q = (s: string) => qualify(s, names, alias);
  const fnClasses = parts.map(({ t, p, list }) => {
    const cls = `_nr_f_${ns}_${p.fn}`;
    const args = paramList(p.params.map((x) => ({ ...x, type: q(x.type) })));
    const body = [`    def __call__(self${args.length ? `, *, ${args.join(', ')}` : ''}) -> ${q(p.ret)}: ...`];
    if (list) {
      const hasCursor = p.params.some((x) => x.py === 'cursor');
      const pageArgs = [...args, ...(hasCursor ? [] : ['cursor: str | None = None'])];
      const optional = p.params.map((x) => `${x.py}: ${q(x.type).replace(/ \| None$/, '')} | None = None`);
      body.push(`    def page(self, *, ${pageArgs.join(', ')}) -> _nr_Result: ...`);
      body.push(`    def pages(self, args: dict[str, Any] | None = None, max_items: int = 500${optional.length ? `, *, ${optional.join(', ')}` : ''}) -> list[${q(itemType.get(t.name) ?? 'Any')}]: ...`);
    }
    return { name: p.fn, cls, text: `class ${cls}:\n${body.join('\n')}\n` };
  });
  const typeStubs = [
    `import ${ns} as ${alias}`,
    'class _nr_Page:\n    count: int\n    total: int\n    has_more: bool\n    next_cursor: str\n',
    'class _nr_Result:\n    data: Any\n    items: list[Any]\n    page: _nr_Page\n    def next(self) -> "_nr_Result": ...\n    def pages(self, max_items: int = 500) -> list[Any]: ...\n',
    ...fnClasses.map((c) => c.text),
    `class _nr_ns_${ns}:`,
    ...(fnClasses.length ? fnClasses.map((c) => `    ${c.name}: ${c.cls}`) : ['    pass']),
    `${ns}: _nr_ns_${ns}`,
    '',
  ].join('\n');
  return { stubs, typeStubs, signatures, docs };
}

/** Declarations shared by every namespace (Page, Result, the ToolError names, ops). */
export function scriptCommonTypeStubs(forwardedOps: readonly string[], report: boolean): string {
  const ops = OPS_FORWARD_SIGS.filter((o) => forwardedOps.includes(o.name));
  return [
    'from typing import Any, Literal',
    // Page, Result and the ToolError names are defined by the prelude (the checker sees its classes); only the
    // built-ins the checker lacks and the typed ops object are declared here
    'def getattr(o: object, name: str, default: Any = None) -> Any: ...',
    'def hasattr(o: object, name: str) -> bool: ...',
    'class _nr_ops:',
    '    def parallel(self, calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]: ...',
    '    def now(self) -> str: ...',
    '    def days_since(self, iso: str) -> float: ...',
    '    def error(self, e: BaseException) -> dict[str, Any]: ...',
    '    def pages(self, fn: str, args: dict[str, Any] | None = None, max_items: int = 500) -> list[Any]: ...',
    ...(report ? [`    def report(self, kind: Literal["done", "blocked", "unmet_need", "tool_problem", "decision"], text: str, *, attempted: list[str] | None = None, tool: str | None = None, error_id: str | None = None, reason: str | None = None) -> dict[str, Any]: ...`] : []),
    ...ops.map((o) => `    def ${o.name}(self, *, ${o.params}) -> dict[str, Any]: ...`),
    'ops: _nr_ops',
    '',
  ].join('\n');
}

const OPS_FORWARD_SIGS = [
  { name: 'log_decision', params: 'choice: str, reason: str, alternatives: list[str] | None = None' },
  { name: 'report_unmet_need', params: 'intent: str, attempted: list[str] | None = None' },
  { name: 'report_issue', params: 'tool: str, problem: str, evidence: dict[str, Any] | None = None, error_id: str | None = None' },
];

/** Contract-2 `ops` stub (agent-facing). */
export function generateOpsStubV2(forwardedOps: readonly string[], report: boolean): string {
  const lines = [
    `# ops.pyi  (generated; Neurouter compiler ${COMPILER_VERSION}; contract 2)`,
    'from typing import Any, Literal',
    '',
    'def parallel(calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:',
    '    """Run several tool calls concurrently, e.g. ops.parallel([("ns.fn", {"arg": 1}), ...]).',
    '',
    '    Returns one {"ok": True, "value": ...} or {"ok": False, "error": {...}} per call, in input order."""',
    '',
    'def pages(fn: str, args: dict[str, Any] | None = None, max_items: int = 500) -> list[Any]:',
    '    """Alias of <ns>.<fn>.pages(args, max_items) (kept for one release), e.g. ops.pages("ns.list_orders", {"status": "paid"})."""',
    '',
    'def error(e: BaseException) -> dict[str, Any] | None:',
    '    """The structured tool error behind an exception: {code, message, retry, next: [{fn, args}], fields?, plan?, …}; other exceptions give code "script_error"."""',
    '',
    'def days_since(iso: str) -> float:',
    '    """Days elapsed between an ISO-8601 timestamp and the run start time."""',
    '',
    'def now() -> str:',
    '    """The run start time as an ISO-8601 UTC string (fixed for the whole run)."""',
    '',
  ];
  if (report)
    lines.push(
      'def report(kind: Literal["done", "blocked", "unmet_need", "tool_problem", "decision"], text: str, *, attempted: list[str] | None = None, tool: str | None = None, error_id: str | None = None, reason: str | None = None) -> dict[str, Any]:',
      '    """Same as neurouter_report: unmet_need when no function can do it, blocked when you need the user, tool_problem, decision, done."""',
      '',
    );
  for (const o of OPS_FORWARD_SIGS.filter((x) => forwardedOps.includes(x.name))) lines.push(`def ${o.name}(*, ${o.params}) -> dict[str, Any]: ...`, '');
  return lines.join('\n');
}

const PRELUDE_COMMON = `
${SCRIPT_ERROR_CLASSES.map((c) => `${c.name} = ${c.base}`).join('\n')}
ToolError = (${ERROR_BASES.join(', ')})
_nr_errors = {}
_nr_fns = {}


def _nr_raise(r):
    t = r["py"]
    m = r["text"]
    _nr_errors[m] = r["error"]
${ERROR_BASES.filter((b) => b !== 'RuntimeError').map((b) => `    if t == "${b}":\n        raise ${b}(m)`).join('\n')}
    raise RuntimeError(m)


class Page:
    def __init__(self, p):
        self.count = p.get("count", 0)
        self.total = p.get("total")
        self.has_more = p.get("has_more", False)
        self.next_cursor = p.get("next_cursor")

    def __repr__(self):
        return "Page(count=" + str(self.count) + ", total=" + str(self.total) + ", has_more=" + str(self.has_more) + ")"


class Result:
    def __init__(self, fn, args, r):
        self._fn = fn
        self._args = args
        self.data = r["data"]
        self.items = r.get("items")
        p = r.get("page")
        self.page = Page(p) if p else None

    def next(self):
        if self.page is None or not self.page.has_more or not self.page.next_cursor:
            return None
        a = dict(self._args)
        a["cursor"] = self.page.next_cursor
        return self._fn.page(**a)

    def pages(self, max_items=500):
        cap = min(max_items, 5000)
        out = []
        r = self
        while r is not None:
            if r.items is None:
                out.append(r.data)
            else:
                out.extend(r.items)
            if len(out) >= cap:
                break
            r = r.next()
        return out[:cap]

    def __repr__(self):
        return "Result(page=" + repr(self.page) + ")"


class _NrFn:
    def __init__(self, name):
        self._name = name

    def __call__(self, **kw):
        r = _nr.call(fn=self._name, args=kw)
        if not r["ok"]:
            _nr_raise(r)
        return r["data"]

    def page(self, **kw):
        r = _nr.call(fn=self._name, args=kw, page=True)
        if not r["ok"]:
            _nr_raise(r)
        return Result(self, {k: v for k, v in kw.items() if k != "cursor"}, r)

    def pages(self, args=None, max_items=500, **kw):
        a = dict(args) if args else {}
        a.update(kw)
        return self.page(**a).pages(max_items)

    def __repr__(self):
        return "<function " + self._name + ">"


def _nr_fn(name):
    f = _NrFn(name)
    _nr_fns[name] = f
    return f
`;

/**
 * The prelude fed before a contract-2 script (Python): imports the host modules under private names and binds
 * each namespace and `ops` to the objects described above. Host modules: `<ns>` (direct functions, used by
 * `ops.parallel`), `ops` and `_nr` (`_nr.call(fn, args, page?)` answers `{ok, data, items?, page?}` or
 * `{ok: false, py, text, error}`).
 */
export function scriptPrelude(namespaces: Array<{ ns: string; functions: string[] }>, forwardedOps: readonly string[], report: boolean): string {
  const imports = `import _nr, ops as _nr_m_ops${namespaces.map((n) => `, ${n.ns} as _nr_m_${n.ns}`).join('')}`;
  const opsMethods = [
    '    def parallel(self, calls):\n        return _nr_m_ops.parallel(calls)',
    '    def now(self):\n        return _nr_m_ops.now()',
    '    def days_since(self, iso):\n        return _nr_m_ops.days_since(iso)',
    '    def error(self, e):\n        m = str(e)\n        if m in _nr_errors:\n            return _nr_errors[m]\n        return {"code": "script_error", "message": m, "retry": "after_fix", "next": []}',
    '    def pages(self, fn, args=None, max_items=500):\n        f = _nr_fns.get(fn)\n        if f is None:\n            raise AttributeError("unknown_tool: ops.pages has no function " + str(fn) + "; pass fn=\\"<ns>.<list function>\\".")\n        return f.pages(args, max_items)',
    ...(report ? ['    def report(self, kind, text, **kw):\n        return _nr_m_ops.report(kind=kind, text=text, **kw)'] : []),
    ...OPS_FORWARD_SIGS.filter((o) => forwardedOps.includes(o.name)).map((o) => `    def ${o.name}(self, **kw):\n        return _nr_m_ops.${o.name}(**kw)`),
  ];
  return [
    imports,
    PRELUDE_COMMON,
    `class _NrOps:\n${opsMethods.join('\n\n')}\n`,
    'ops = _NrOps()',
    // explicit attributes (the type checker of the prelude has no setattr)
    ...namespaces.map((n) => `class _NrNs_${n.ns}:\n    def __init__(self):\n${n.functions.map((f) => `        self.${f} = _nr_fn("${n.ns}.${f}")`).join('\n') || '        pass'}\n\n    def __repr__(self):\n        return "<namespace ${n.ns}>"\n\n\n${n.ns} = _NrNs_${n.ns}()`),
    '',
  ].join('\n');
}

/** Stubs of the private host module `_nr`. */
export const NR_HOST_STUBS = 'from typing import Any\ndef call(*, fn: str, args: dict[str, Any], page: bool = False) -> dict[str, Any]: ...\n';
