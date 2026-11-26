/**
 * Python `.pyi` stubs for code mode (backend spec §8.5). Generated from the visible tools of a
 * namespace; the server regenerates them for the per-principal allowed set.
 */
import { scriptBuiltinsLine, type JsonSchema, type ToolDef } from '@neurouter/shared';
import { PY_KEYWORDS, pyIdent } from './naming.js';
import { isObj, jcsHash, type Obj } from './util.js';
import { COMPILER_VERSION } from './version.js';

export const MAX_TYPED_DICTS = 200;
const MAX_TD_DEPTH = 4;

export interface StubOptions {
  buildHash?: string;
  maxTypedDicts?: number;
}

class TypeRegistry {
  readonly classes: string[] = [];
  private readonly byHash = new Map<string, string>();
  private readonly names = new Set<string>();
  constructor(readonly cap: number) {}
  get full(): boolean {
    return this.byHash.size >= this.cap;
  }
  register(baseName: string, hash: string, render: (name: string) => string): string {
    const known = this.byHash.get(hash);
    if (known) return known;
    let name = baseName;
    let k = 2;
    while (this.names.has(name) || PY_KEYWORDS.has(name)) name = `${baseName}${k++}`;
    this.names.add(name);
    this.byHash.set(hash, name);
    this.classes.push(render(name));
    return name;
  }
}

export function pascalCase(s: string): string {
  const out = s
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(' ')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join('');
  return /^[A-Za-z]/.test(out) ? out : `T${out}`;
}

function pyLiteral(v: unknown): string | null {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v === 'string') return JSON.stringify(v);
  return null;
}

function union(parts: string[]): string {
  const uniq = [...new Set(parts)];
  if (uniq.includes('Any')) return 'Any';
  const nonNone = uniq.filter((p) => p !== 'None');
  return [...nonNone, ...(uniq.includes('None') ? ['None'] : [])].join(' | ') || 'Any';
}

interface TypeCtx {
  reg: TypeRegistry;
  defs: Obj;
  depth: number;
  seenRefs: string[];
}

function pyType(schema: unknown, nameHint: string, ctx: TypeCtx): string {
  if (!isObj(schema) || Object.keys(schema).length === 0) return 'Any';
  if (typeof schema.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(schema.$ref);
    const name = m?.[1];
    if (!name || !isObj(ctx.defs[name]) || ctx.seenRefs.includes(name)) return 'dict[str, Any]';
    return pyType({ ...(ctx.defs[name] as Obj), 'x-schema-name': name }, name, { ...ctx, seenRefs: [...ctx.seenRefs, name] });
  }
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const lits = schema.enum.map(pyLiteral);
    if (lits.every((l) => l !== null) && schema.enum.length <= 64) return `Literal[${lits.join(', ')}]`;
  }
  if (schema.const !== undefined) {
    const l = pyLiteral(schema.const);
    if (l) return `Literal[${l}]`;
  }
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(schema[k])) return union((schema[k] as unknown[]).map((s, i) => pyType(s, `${nameHint}${i + 1}`, ctx)));
  }
  if (Array.isArray(schema.allOf) && schema.allOf.length === 1) return pyType(schema.allOf[0], nameHint, ctx);
  const types = Array.isArray(schema.type) ? (schema.type as string[]) : typeof schema.type === 'string' ? [schema.type] : schema.properties ? ['object'] : schema.items ? ['array'] : [];
  if (types.length === 0) return 'Any';
  const parts = types.map((t) => {
    switch (t) {
      case 'string':
        return 'str';
      case 'integer':
        return 'int';
      case 'number':
        return 'float';
      case 'boolean':
        return 'bool';
      case 'null':
        return 'None';
      case 'array':
        return `list[${pyType(schema.items, `${nameHint}Item`, ctx)}]`;
      case 'object':
        return objectType(schema, nameHint, ctx);
      default:
        return 'Any';
    }
  });
  const t = union(parts);
  return schema.nullable === true && !t.includes('None') ? `${t} | None` : t;
}

function objectType(schema: Obj, nameHint: string, ctx: TypeCtx): string {
  const p = isObj(schema.properties) ? schema.properties : null;
  if (!p || Object.keys(p).length === 0) {
    if (isObj(schema.additionalProperties)) return `dict[str, ${pyType(schema.additionalProperties, `${nameHint}Value`, ctx)}]`;
    return 'dict[str, Any]';
  }
  if (ctx.reg.full || ctx.depth >= MAX_TD_DEPTH) return 'dict[str, Any]';
  const base = pascalCase(typeof schema['x-schema-name'] === 'string' ? (schema['x-schema-name'] as string) : typeof schema.title === 'string' ? schema.title : nameHint);
  const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const inner: TypeCtx = { ...ctx, depth: ctx.depth + 1 };
  const fields = Object.entries(p).map(([k, v]) => {
    const t = pyType(v, `${base}${pascalCase(k)}`, inner);
    return { key: k, type: req.has(k) ? t : `NotRequired[${t}]` };
  });
  const classSyntax = fields.every((f) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(f.key) && !PY_KEYWORDS.has(f.key));
  const hash = jcsHash({ base, fields });
  return ctx.reg.register(base, hash, (name) =>
    classSyntax
      ? `class ${name}(TypedDict):\n${fields.map((f) => `    ${f.key}: ${f.type}`).join('\n')}\n`
      : `${name} = TypedDict(${JSON.stringify(name)}, {\n${fields.map((f) => `    ${JSON.stringify(f.key)}: ${f.type},`).join('\n')}\n})\n`,
  );
}

/** Python keyword-safe arg name → schema arg name, for host calls (`from_` → `from`). */
export function pyArgMap(tool: Pick<ToolDef, 'inputSchema'>): Record<string, string> {
  const out: Record<string, string> = {};
  const props = isObj(tool.inputSchema.properties) ? tool.inputSchema.properties : {};
  for (const k of Object.keys(props)) out[pyIdent(k)] = k;
  return out;
}

function docstring(tool: ToolDef): string {
  const paras = tool.description.split(/\n\s*\n/);
  let first = paras[0]!.trim();
  if (first.length > 500) first = `${first.slice(0, 497)}...`;
  const notes: string[] = [];
  notes.push(tool.risk.write ? 'WRITE: in dry_run mode returns a planned change instead of calling the API.' : 'Read-only.');
  if (tool.shaping?.maxItems) notes.push(`Returns at most ${tool.shaping.maxItems} items; more are summarised in the result.`);
  const text = `${first}\n\n${notes.join(' ')}`.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"');
  return `    """${text
    .split('\n')
    .map((l, i) => (i === 0 || l === '' ? l : `    ${l}`))
    .join('\n')}"""`;
}

function returnSchema(tool: ToolDef): unknown {
  const o = tool.outputSchema;
  if (!isObj(o)) return undefined;
  const wrapped = o['x-neurouter-wrapped'];
  if (typeof wrapped === 'string' && isObj(o.properties)) return { ...(o.properties as Obj)[wrapped] as Obj };
  return o;
}

function renderFunction(tool: ToolDef, reg: TypeRegistry): { signature: string; text: string } {
  const fn = pyIdent(tool.name);
  const hint = pascalCase(tool.name);
  const defs = isObj(tool.inputSchema.$defs) ? (tool.inputSchema.$defs as Obj) : {};
  const ctx: TypeCtx = { reg, defs, depth: 0, seenRefs: [] };
  const props = isObj(tool.inputSchema.properties) ? (tool.inputSchema.properties as Record<string, JsonSchema>) : {};
  const req = new Set(Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : []);
  const reqArgs: string[] = [];
  const optArgs: string[] = [];
  for (const [k, s] of Object.entries(props)) {
    const t = pyType(s, `${hint}Arg${pascalCase(k)}`, ctx);
    const name = pyIdent(k);
    if (req.has(k)) {
      reqArgs.push(`${name}: ${t}`);
    } else {
      const def = s.default !== undefined ? pyLiteral(s.default) : null;
      optArgs.push(def !== null ? `${name}: ${t} = ${def}` : `${name}: ${t.includes('None') ? t : `${t} | None`} = None`);
    }
  }
  const outDefs = isObj(tool.outputSchema?.$defs) ? (tool.outputSchema!.$defs as Obj) : {};
  const rs = returnSchema(tool);
  let ret = rs === undefined ? 'Any' : pyType(rs, `${hint}Result`, { reg, defs: outDefs, depth: 0, seenRefs: [] });
  if (tool.risk.write) ret = ret.startsWith('list[') ? 'Any' : 'dict[str, Any]';
  if (ret === 'None') ret = 'Any';
  const args = [...reqArgs, ...optArgs];
  const signature = `def ${fn}(${args.length ? `*, ${args.join(', ')}` : ''}) -> ${ret}`;
  return { signature, text: `${signature}:\n${docstring(tool)}\n` };
}

/** The `def …` line used as `ToolDef.pySignature` (types reference this tool's TypedDicts). */
export function pySignatureFor(tool: ToolDef): string {
  return renderFunction(tool, new TypeRegistry(MAX_TYPED_DICTS)).signature;
}

/** One namespace's `.pyi`, from the tools given (hidden tools are skipped). */
export function generateStubs(tools: ToolDef[], namespace: string, opts: StubOptions = {}): string {
  const reg = new TypeRegistry(opts.maxTypedDicts ?? MAX_TYPED_DICTS);
  const fns = tools.filter((t) => !t.hidden).map((t) => renderFunction(t, reg).text);
  const header = `# ${namespace}.pyi  (generated; Neurouter compiler ${COMPILER_VERSION}${opts.buildHash ? `; build ${opts.buildHash.slice(0, 12)}` : ''})\n# ${scriptBuiltinsLine()}\n# Inside run_script, tool results are whole values (no byte truncation; an overlay maxItems still caps lists).\nfrom typing import Any, Literal, NotRequired, TypedDict\n`;
  return [header, ...reg.classes, ...fns].join('\n');
}

interface OpsFn {
  name: string;
  sig: string;
  doc: string;
}

const OPS_FUNCTIONS: Record<string, OpsFn> = {
  begin_task: { name: 'begin_task', sig: 'def begin_task(*, goal: str) -> dict[str, Any]', doc: 'Start a task for the user request; later calls attach to it.' },
  end_task: { name: 'end_task', sig: 'def end_task(*, outcome: Literal["success", "partial", "failure"], notes: str | None = None, task_id: str | None = None) -> dict[str, Any]', doc: 'Finish the current task with its outcome.' },
  log_decision: { name: 'log_decision', sig: 'def log_decision(*, choice: str, reason: str, alternatives: list[str] | None = None) -> dict[str, Any]', doc: 'Record a decision you made and why.' },
  report_unmet_need: { name: 'report_unmet_need', sig: 'def report_unmet_need(*, intent: str, attempted: list[str] | None = None) -> dict[str, Any]', doc: 'Report something the user needs that no tool can do.' },
  report_issue: { name: 'report_issue', sig: 'def report_issue(*, tool: str, problem: str, evidence: dict[str, Any] | None = None, error_id: str | None = None) -> dict[str, Any]', doc: 'Report a tool that behaves wrongly or is documented badly.' },
  explain_error: { name: 'explain_error', sig: 'def explain_error(*, error_id: str) -> dict[str, Any]', doc: 'Explain an error_id and how to fix the call.' },
  get_examples: { name: 'get_examples', sig: 'def get_examples(*, tool: str, kind: Literal["call", "script"] | None = None) -> dict[str, Any]', doc: 'Get working examples for a tool.' },
  whoami: { name: 'whoami', sig: 'def whoami() -> dict[str, Any]', doc: 'Describe the current principal, environment, scopes and limits.' },
};

/** The `ops` namespace stub: enabled ops tools + `parallel`, `days_since`, `now`. */
export function generateOpsStub(enabledOpsTools: readonly string[]): string {
  const lines = [`# ops.pyi  (generated; Neurouter compiler ${COMPILER_VERSION})`, 'from typing import Any, Literal', ''];
  lines.push(
    'def parallel(calls: list[tuple[str, dict[str, Any]]]) -> list[dict[str, Any]]:',
    '    """Run several tool calls concurrently, e.g. ops.parallel([("ns.fn", {"arg": 1}), ...]).',
    '',
    '    Returns one {"ok": True, "value": ...} or {"ok": False, "error": {...}} per call, in input order."""',
    '',
    'def days_since(iso: str) -> float:',
    '    """Days elapsed between an ISO-8601 timestamp and the run start time."""',
    '',
    'def now() -> str:',
    '    """The run start time as an ISO-8601 UTC string (fixed for the whole run)."""',
    '',
  );
  for (const t of enabledOpsTools) {
    const f = OPS_FUNCTIONS[t];
    if (!f) continue;
    lines.push(`${f.sig}:`, `    """${f.doc}"""`, '');
  }
  return lines.join('\n');
}
