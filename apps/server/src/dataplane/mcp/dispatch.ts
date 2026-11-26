import { CALL_TOOL, META_CALL_ID, META_NEXT_TOOLS, META_TASK_ID, META_TOOL_NAMES, OPS_TOOLS, opsMcpName, READ_RESULT, REPORT, RUN_SCRIPT, scriptBuiltinsLine, SEARCH_TOOLS, type OpsTool, type ToolDef } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import { newId } from '../../kernel/lib/ids.js';
import type { RunContext } from '../pipeline/context.js';
import { errorResult } from '../pipeline/errors.js';
import type { ArgValidator } from '../pipeline/arg-validate.js';
import { resolveVisibleTool } from '../pipeline/pipeline.js';
import { applyArgTransforms } from '../http/request-builder.js';
import type { Confirmer, McpToolResult, Pipeline } from '../pipeline/pipeline.js';
import type { ToolSearchService } from '../search/search.service.js';
import type { ScriptRunner } from '../code/run-script.js';
import { opFor, opsDefinition, reportEnabled, type OpsOp, type OpsTools } from '../ops/ops.js';
import type { TaskTracker } from '../tasks/tracker.js';
import { errorDraft, okDraft, type Draft } from '../envelope/draft.js';
import { EnvelopeRenderer, TypedSchemaIssues } from '../envelope/render.js';
import { closestNames, exampleArgs } from '../envelope/relations.js';
import { TaskStateSource } from '../envelope/state.js';
import { BUDGET } from '../envelope/types.js';
import { v1Result, withExtraText } from '../envelope/v1.js';
import { agentInputSchema, visibleTools, type Surface } from './surface.js';

export interface DispatchDeps {
  pipeline: Pipeline;
  ops: OpsTools;
  scripts: ScriptRunner;
  search: ToolSearchService;
  tracker: TaskTracker;
  audit: AuditRecorder;
  args: ArgValidator;
  now: () => number;
  /** contract 2: typed outputSchema mismatches (shared with tools/list) */
  typedIssues?: TypedSchemaIssues;
  /** tools/list changed (a typed outputSchema was dropped): notify open streams */
  onToolsChanged?: () => void;
  log?: { warn: (o: object, m: string) => void };
  /** contract 2: throw on envelopes that fail the envelope schema or a budget (tests) */
  strictEnvelopes?: boolean;
}

export type DispatchResult =
  | { kind: 'result'; result: McpToolResult }
  | { kind: 'input_required'; result: unknown }
  /** Unknown tool on a direct call: JSON-RPC -32602 in contract 1 (Hub behaviour); an envelope in contract 2. */
  | { kind: 'unknown'; message: string };

export interface SearchItem {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  write: boolean;
  destructive?: boolean;
  inputSchema?: Record<string, unknown>;
  /** Compact arguments (`owner*: string, state?: "open"|"closed"`), json format. */
  args?: string;
  pySignature?: string;
  pyName?: string;
  score: number;
  /** the API tool behind the hit (absent for ops tools) */
  tool?: ToolDef;
}

/** What a route produced before rendering: both renderings, or a protocol-level answer. */
type Routed =
  | {
      kind: 'reply';
      result: McpToolResult;
      draft: Draft;
      /** the API tool behind the answer (typed outputSchema, write state) */
      tool?: ToolDef | null;
      /** contract 2 renders `call_tool` as the inner call */
      as?: { name: string; args: Record<string, unknown> };
      /** v1: may carry the one-time begin_task tip */
      tip?: boolean;
    }
  | { kind: 'input_required'; result: unknown }
  | { kind: 'unknown'; message: string };

/**
 * `tools/call` router: meta-tools (`search_tools`, `call_tool`, `run_script`), ops tools
 * (`neurouter_*`) and API tools (the pipeline). Also used by the console's test-search box.
 *
 * Every route answers in both renderings (v1 result + contract-neutral draft); `finish` is the single place
 * that picks the session's contract: the v1 result as is, or the contract-2 envelope from the renderer.
 */
export class Dispatcher {
  readonly typedIssues: TypedSchemaIssues;
  private readonly renderer: EnvelopeRenderer;

  constructor(private readonly d: DispatchDeps) {
    this.typedIssues = d.typedIssues ?? new TypedSchemaIssues();
    this.renderer = new EnvelopeRenderer({
      // the state block is counted in the task row (works across instances); calls without a task use memory
      state: new TaskStateSource(d.tracker),
      typed: this.typedIssues,
      closest: (ctx, name) => this.closest(ctx, name),
      onSchemaMismatch: (ctx, tool, errors) => {
        void d.ops.recordToolIssue(ctx, tool.name, `The response does not match the typed outputSchema; the tool is now listed without it. ${errors.slice(0, 3).join('; ')}`.slice(0, 500), { errors }).catch(() => {});
        d.onToolsChanged?.();
      },
      log: d.log ?? { warn: () => {} },
      now: d.now,
      strict: d.strictEnvelopes ?? false,
    });
  }

  async call(ctx: RunContext, name: string, args: Record<string, unknown>, surface: Surface, confirmer: Confirmer | null, signal?: AbortSignal): Promise<DispatchResult> {
    return this.finish(ctx, name, args, await this.route(ctx, name, args, surface, confirmer, signal));
  }

  /** The one exit of every tools/call answer: contract 1 → the v1 result; contract 2 → the envelope. */
  private async finish(ctx: RunContext, name: string, args: Record<string, unknown>, out: Routed): Promise<DispatchResult> {
    if (out.kind === 'input_required') return out;
    if (ctx.contract === 2) {
      // contract 2: unknown tools are an envelope (`unknown_tool` + closest + next), never a JSON-RPC error
      const reply = out.kind === 'unknown' ? { draft: errorDraft({ code: 'unknown_tool', message: out.message, name, args }), tool: null, as: undefined } : out;
      const target = reply.as ?? { name, args };
      const result = await this.renderer.render(ctx, { name: target.name, args: target.args, tool: reply.tool ?? null, draft: reply.draft }, ctx.outputSchema ?? 'envelope');
      this.labelTask(ctx, target.name, target.args, reply.tool ?? null, result);
      return { kind: 'result', result };
    }
    if (out.kind === 'unknown') return out;
    return { kind: 'result', result: out.tip ? await this.tip(ctx, name, out.result) : out.result };
  }

  /**
   * Contract 2 (D1): without begin_task, an inferred task is labelled from its first calls: the first search
   * query (`Find: …`), else the first API tool's title. Only while the task has neither goal nor label.
   */
  private labelTask(ctx: RunContext, name: string, args: Record<string, unknown>, tool: ToolDef | null, result: McpToolResult): void {
    if (!ctx.taskId || ctx.framing === 'explicit') return;
    const call = ((result.structuredContent as { state?: { call?: number } } | undefined)?.state?.call ?? 99) as number;
    if (call > 3) return;
    const goal = name === SEARCH_TOOLS && typeof args.query === 'string' ? `Find: ${args.query}` : tool && tool.kind !== 'composite' ? tool.title || tool.name : null;
    if (goal) void this.d.tracker.labelOnce(ctx.taskId, ctx.tenantId, goal).catch(() => {});
  }

  /** v1: first call in an inferred task gets a one-time begin_task tip (§11.3). */
  private async tip(ctx: RunContext, name: string, r: McpToolResult): Promise<McpToolResult> {
    if (!ctx.taskId || name === opsMcpName('begin_task')) return r;
    const t = ctx.framing === 'inferred' && (await this.d.tracker.takeHint(ctx.taskId));
    if (!t) return r;
    const meta = { ...(r._meta ?? {}) };
    meta[META_NEXT_TOOLS] = [...new Set([...((meta[META_NEXT_TOOLS] as string[] | undefined) ?? []), 'neurouter_begin_task'])];
    return withExtraText(r, 'Tip: call neurouter_begin_task(goal) so this work is tracked as one task.', meta);
  }

  private async route(ctx: RunContext, name: string, args: Record<string, unknown>, surface: Surface, confirmer: Confirmer | null, signal?: AbortSignal): Promise<Routed> {
    if (name === SEARCH_TOOLS) return { kind: 'reply', ...(await this.searchReply(ctx, args, surface)), tip: true };
    if (name === RUN_SCRIPT) {
      if (!surface.code) return { kind: 'unknown', message: `Unknown tool: ${name}` };
      const r = await this.d.scripts.run({ ...ctx, mode: 'code' }, args, confirmer, signal);
      if (r.inputRequired) return { kind: 'input_required', result: r.inputRequired };
      return { kind: 'reply', result: r.result, draft: r.draft };
    }
    if (name === CALL_TOOL) {
      if (surface.discovery !== 'search' && surface.mode === 'code') return { kind: 'unknown', message: `Unknown tool: ${name}` };
      const inner = typeof args.name === 'string' ? args.name : '';
      const innerArgs = args.arguments === undefined ? {} : args.arguments;
      if (!inner || typeof innerArgs !== 'object' || innerArgs === null || Array.isArray(innerArgs)) {
        const message = 'call_tool needs { name: string, arguments?: object }';
        const issues = !inner ? [{ path: '', keyword: 'required', params: { missingProperty: 'name' }, message: 'required' }] : [{ path: '/arguments', keyword: 'type', params: { type: 'object' }, message: 'must be object' }];
        return { kind: 'reply', result: errorResult(message, null, 'invalid_args'), draft: errorDraft({ code: 'invalid_args', message, text: `${message}; nothing was called.`, name: CALL_TOOL, args, issues, next: inner ? [{ tool: CALL_TOOL, args: { name: inner, arguments: {} } }] : [] }) };
      }
      if ((META_TOOL_NAMES as readonly string[]).includes(inner)) {
        const message = `call_tool cannot call ${inner}`;
        return { kind: 'reply', result: errorResult(message, null, 'invalid_args'), draft: errorDraft({ code: 'invalid_args', message, text: `call_tool cannot call ${inner}; call ${inner} directly. Nothing was called.`, name: CALL_TOOL, args, next: [{ tool: inner, args: innerArgs as Record<string, unknown> }] }) };
      }
      const as = { name: inner, args: innerArgs as Record<string, unknown> };
      const op = opFor(ctx, inner);
      if (op) {
        const r = await this.d.ops.call(ctx, op, innerArgs as Record<string, unknown>);
        return { kind: 'reply', result: r.result, draft: r.draft, as, tip: true };
      }
      const composite = await this.composite(ctx, inner, innerArgs as Record<string, unknown>, confirmer, signal);
      if (composite) return composite.kind === 'reply' ? { ...composite, as } : composite;
      const out = await this.d.pipeline.invoke({ ...ctx, via: ctx.via === 'eval' ? 'eval' : 'call_tool' }, inner, innerArgs as Record<string, unknown>, { confirmer, ...(signal ? { signal } : {}) });
      if (out.inputRequired) return { kind: 'input_required', result: out.inputRequired };
      return { kind: 'reply', result: out.result, draft: out.draft, tool: out.tool ?? null, as, tip: true };
    }
    const op = opFor(ctx, name);
    // contract 2 also answers the unlisted v1 names (begin/end_task, whoami, explain_error, get_examples, read_result; contract-v2 §1)
    if (op) {
      const r = await this.d.ops.call(ctx, op, args);
      return { kind: 'reply', result: r.result, draft: r.draft, tip: true };
    }
    const composite = await this.composite(ctx, name, args, confirmer, signal);
    if (composite) return composite;
    // a tool that is not on the surface is still callable directly when visible (clients may cache lists)
    const out = await this.d.pipeline.invoke(ctx, name, args, { confirmer, ...(signal ? { signal } : {}) });
    if (out.unknown && ctx.contract !== 2) return { kind: 'unknown', message: `Unknown tool: ${name}` };
    if (out.inputRequired) return { kind: 'input_required', result: out.inputRequired };
    return { kind: 'reply', result: out.result, draft: out.draft, tool: out.tool ?? null, tip: true };
  }

  /**
   * Composite tools (§8.4): the overlay script runs through code mode with the composite's arguments
   * bound as globals; every inner call goes through the pipeline under the caller's policy.
   */
  private async composite(ctx: RunContext, name: string, args: Record<string, unknown>, confirmer: Confirmer | null, signal?: AbortSignal): Promise<Routed | null> {
    const t = resolveVisibleTool(ctx, name);
    if (!t || t.binding.type !== 'composite') return null;
    // contract 2 (D5): a composite with destructive calls takes the confirm token like run_script
    const confirm = ctx.contract === 2 && typeof args.confirm === 'string' && !('confirm' in ((t.inputSchema.properties as object | undefined) ?? {})) ? args.confirm : undefined;
    if (confirm !== undefined) args = Object.fromEntries(Object.entries(args).filter(([k]) => k !== 'confirm'));
    const check = this.d.args.check(t.defHash, t.inputSchema, applyArgTransforms(t, args));
    if (!check.ok) {
      const message = `Invalid arguments for ${t.name}:\n- ${check.errors.join('\n- ')}`;
      return { kind: 'reply', result: errorResult(message, null, 'invalid_args'), draft: errorDraft({ code: 'invalid_args', message, tool: t, name: t.name, args, issues: check.issues }), tool: t };
    }
    const inputs = applyArgTransforms(t, args);
    for (const [k, v] of Object.entries((t.inputSchema.properties ?? {}) as Record<string, { default?: unknown }>)) if (inputs[k] === undefined && v?.default !== undefined) inputs[k] = v.default;
    const r = await this.d.scripts.run({ ...ctx, mode: 'code' }, { code: t.binding.script, mode: 'execute', inputs, ...(confirm ? { confirm } : {}) }, confirmer, signal, { allowWithoutScope: true, callAs: { name: t.name, args } });
    if (r.inputRequired) return { kind: 'input_required', result: r.inputRequired };
    return { kind: 'reply', result: r.result, draft: r.draft, tool: t };
  }

  /** Nearest visible tool names for an unknown name: the search index (top 3), else name similarity. */
  async closest(ctx: RunContext, name: string): Promise<string[]> {
    const names = visibleTools(ctx).map((t) => t.name);
    const similar = closestNames(name, names, 3);
    if (similar.length) return similar;
    try {
      const res = await this.search(ctx, name.replace(/[_.-]+/g, ' '), 3, 'json', false);
      return res.tools.filter((t) => names.includes(t.name)).map((t) => t.name).slice(0, 3);
    } catch {
      return [];
    }
  }

  /** `search_tools` (§9.4): ACL before ranking (only the principal's visible tools are scored). v1 result + contract-2 draft. */
  private async searchReply(ctx: RunContext, args: Record<string, unknown>, surface: Surface): Promise<{ result: McpToolResult; draft: Draft }> {
    const start = this.d.now();
    const v2 = ctx.contract === 2;
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 500) {
      const message = 'search_tools needs a query of 1–500 characters';
      return {
        result: errorResult(message, null, 'invalid_args'),
        draft: errorDraft({ code: 'invalid_args', message, text: `${message}; nothing was searched.`, name: SEARCH_TOOLS, args, issues: [{ path: '/query', keyword: query ? 'maxLength' : 'minLength', params: {}, message: 'must be 1–500 characters' }], next: [] }),
      };
    }
    const limit = Number.isInteger(args.limit) ? Math.min(25, Math.max(1, args.limit as number)) : 8;
    const format = args.format === 'json' || args.format === 'python' ? args.format : (v2 ? surface.mode === 'code' : surface.code) ? 'python' : 'json';
    const includeSchemas = v2 ? args.detail === 'full' : args.include_schemas !== false;
    // contract 2 asks for one more hit to know whether there are more
    const res = await this.hits(ctx, query, v2 ? limit + 1 : limit, format, includeSchemas, v2);
    const auditId = newId();
    this.d.audit.record({ ...this.d.pipeline.auditBase(ctx), id: auditId, kind: 'tool_search', toolName: SEARCH_TOOLS, decision: 'allowed', status: 'ok', decisionReason: `search:${res.mode}`, params: { query, limit, format }, output: { names: res.tools.map((t) => t.name) }, latencyMs: this.d.now() - start });
    this.d.tracker.bump(ctx.taskId, { ops_count: 0 });
    const meta: Record<string, unknown> = { [META_CALL_ID]: auditId, ...(ctx.taskId ? { [META_TASK_ID]: ctx.taskId } : {}) };
    if (v2) return { result: v1Result('', {}, meta), draft: this.searchDraft(ctx, query, limit, format, includeSchemas, res.tools, meta) };
    const structured: Record<string, unknown> = { tools: res.tools.map(({ tool: _t, destructive: _d, ...x }) => x), totalVisible: res.totalVisible };
    let text: string;
    if (!res.tools.length) {
      structured.hint = 'No tool matches. If the user needs something this API cannot do, call neurouter_report_unmet_need.';
      meta[META_NEXT_TOOLS] = ['neurouter_report_unmet_need'];
      text = String(structured.hint);
    } else if (format === 'python') {
      // the stubs are bare `def`s; say how to call them (gemini-3.5-flash-lite called `find_pets_by_status(...)` without the namespace)
      const ns = ctx.server.slug.replace(/-/g, '_');
      const how = surface.code ? `# In run_script call these as ${ns}.<name>(...), e.g. ${res.tools.find((t) => t.pyName && !t.pyName.startsWith('ops.'))?.pyName ?? `${ns}.<name>`}(...); helpers as ops.<name>(...).\n# ${scriptBuiltinsLine()}\n\n` : '';
      text = how + res.tools.map((t) => (t.pySignature ? `${t.pySignature}\n    """${t.description.split('\n')[0]!.slice(0, 300)}"""` : `${t.name} — ${t.description.split('\n')[0]!.slice(0, 200)}`)).join('\n\n');
    } else {
      // the text is what most clients give the model: each hit with its arguments (required ones marked)
      text = res.tools.map((t) => `${t.name}(${t.args ?? ''}) — ${t.description.split('\n')[0]!.slice(0, 200)}${t.write ? ' (write)' : ''}`).join('\n');
      text += `\n\nArguments: name: type; "*" = required.${includeSchemas ? ' Full JSON Schemas are in structuredContent.tools[].inputSchema.' : ''}`;
    }
    return { result: v1Result(text, structured, meta), draft: okDraft(structured) };
  }

  /**
   * Contract-2 search answer (contract-v2 §4.4): one entry per hit with purpose, signature (Python with the
   * namespace in code mode) and a copy-ready example; `detail: "full"` adds the input schema and the
   * top-level keys of the result. Zero hits: `ok`, `count: 0` and a hint naming the unmet-need report.
   */
  private searchDraft(ctx: RunContext, query: string, limit: number, format: 'json' | 'python', full: boolean, hits: SearchItem[], meta: Record<string, unknown>): Draft {
    const ns = ctx.server.slug.replace(/-/g, '_');
    const shown = hits.slice(0, limit);
    const tools = shown.map((h) => {
      const purpose = h.description.split('\n').find((l) => l.trim())?.trim().slice(0, 200) ?? h.title;
      const ex = h.tool ? exampleArgs(h.tool) : null;
      const python = format === 'python' && h.pySignature;
      const signature = python ? pySignatureLine(h.pySignature!, h.pyName ?? `${ns}.${h.name}`) : `${h.name}(${h.args ?? ''})`;
      const example = ex ? (python && h.tool ? pyCall(h.pyName ?? h.tool.pyName, ex, h.tool) : `${h.name}(${JSON.stringify(ex)})`) : undefined;
      const returns = full && h.tool?.outputSchema ? topKeys(h.tool.outputSchema) : undefined;
      return {
        name: h.name,
        purpose,
        signature,
        ...(example && example.length <= 300 ? { example } : {}),
        read_only: h.readOnly,
        destructive: Boolean(h.destructive),
        ...(full && h.inputSchema ? { input_schema: h.inputSchema } : {}),
        ...(returns ? { returns } : {}),
      };
    });
    const has_more = hits.length > limit;
    const data = { tools, total_matches: has_more ? null : tools.length };
    if (tools.length) return okDraft(data, { page: { count: tools.length, total: has_more ? null : tools.length, has_more, next_cursor: null }, meta });
    const names = visibleTools(ctx).map((t) => t.name);
    const near = closestNames(query.replace(/\s+/g, '_'), names, 3);
    const report = reportEnabled(ctx) && ctx.bundle.server.opsTools.report_unmet_need ? ` If the API cannot do it: neurouter_report({"kind":"unmet_need","text":"…"}).` : '';
    const hint = `No tool matches.${near.length ? ` Closest: ${near.join(', ')}.` : ' Try other words.'}${report}`;
    return okDraft(data, { page: { count: 0, total: 0, has_more: false, next_cursor: null, scope: { query, limit } }, hint: hint.length <= BUDGET.hintChars ? hint : hint.slice(0, BUDGET.hintChars), meta });
  }

  /** Ranked search hits as the console and contract 1 show them. */
  async search(ctx: RunContext, query: string, limit: number, format: 'json' | 'python', includeSchemas: boolean): Promise<{ tools: SearchItem[]; totalVisible: number; mode: string }> {
    const r = await this.hits(ctx, query, limit, format, includeSchemas, false);
    return { ...r, tools: r.tools.map(({ tool: _t, destructive: _d, ...x }) => x) };
  }

  /** Ranked hits with the API tool behind each (internal: contract-2 search entries need examples and schemas). */
  private async hits(ctx: RunContext, query: string, limit: number, format: 'json' | 'python', includeSchemas: boolean, v2: boolean): Promise<{ tools: SearchItem[]; totalVisible: number; mode: string }> {
    const visible = visibleTools(ctx).filter((t) => t.kind !== 'composite' || ctx.mode === 'code');
    const rowIds = ctx.bundle.build.toolRowIds;
    const allowed = new Map<string, string>();
    for (const t of visible) {
      const id = rowIds[t.name];
      if (id) allowed.set(id, t.name);
    }
    const { ranked, mode } = await this.d.search.search(query, allowed, limit);
    const byName = new Map(visible.map((t) => [t.name, t]));
    const items: SearchItem[] = [];
    for (const r of ranked) {
      const t = byName.get(r.name);
      if (!t) continue;
      items.push({
        name: t.name,
        title: t.title,
        description: t.description,
        readOnly: t.risk.readOnly,
        write: t.risk.write,
        destructive: t.risk.destructive,
        ...(includeSchemas && format === 'json' ? { inputSchema: v2 ? agentInputSchema(t) : t.inputSchema } : {}),
        ...(format === 'json' ? { args: argSignature(v2 ? agentInputSchema(t) : t.inputSchema) } : {}),
        ...(format === 'python' ? { pySignature: t.pySignature, pyName: t.pyName } : {}),
        score: r.score,
        tool: t,
      });
    }
    // ops tools are searchable too ("neurouter" finds them all); contract 2 only finds the listed ones
    const q = query.toLowerCase();
    const words = q.match(/[a-z0-9]+/g) ?? [];
    // read_result is always available (truncated tool results point at it), so it is searchable too (contract 1)
    const searchable: OpsOp[] = v2 ? (reportEnabled(ctx) ? [REPORT] : []) : [...OPS_TOOLS.filter((o) => ctx.bundle.server.opsTools[o as OpsTool]), READ_RESULT];
    for (const op of searchable) {
      const d = opsDefinition(op);
      const hay = `${d.name} ${d.title} ${d.description}`.toLowerCase();
      const matched = words.filter((w) => hay.includes(w)).length;
      const hit = q.includes('neurouter') || (words.length > 0 && words.filter((w) => w.length > 3).some((w) => hay.includes(w)) && matched >= Math.min(2, words.length));
      // a strong match (most query words) ranks before the API tools, so the limit does not cut it
      const strong = words.length >= 2 && matched >= Math.ceil(words.length * 0.6);
      if (hit && items.length < limit + 8) items[strong ? 'unshift' : 'push']({ name: d.name, title: d.title, description: d.description, readOnly: Boolean(d.annotations.readOnlyHint), write: false, ...(includeSchemas && format === 'json' ? { inputSchema: d.inputSchema } : {}), ...(format === 'json' ? { args: argSignature(d.inputSchema) } : {}), ...(format === 'python' && d.pyName ? { pySignature: `ops.${op}(...)`, pyName: d.pyName } : {}), score: 0 });
    }
    return { tools: items.slice(0, Math.max(limit, q.includes('neurouter') ? limit + 8 : limit)), totalVisible: visible.length, mode };
  }
}

/** `def list_orders(*, status: … = None) -> ListOrdersResult` → `acme.list_orders(*, status: … = None) -> ListOrdersResult`. */
function pySignatureLine(sig: string, pyName: string): string {
  const first = sig.split('\n').find((l) => l.trim().startsWith('def ')) ?? sig.split('\n')[0]!;
  const m = /^\s*def\s+[A-Za-z_][A-Za-z0-9_]*\s*(\(.*)$/.exec(first);
  const out = m ? `${pyName}${m[1]!.replace(/:\s*$/, '')}` : first.trim();
  return out.length <= 400 ? out : `${out.slice(0, 399)}…`;
}

function pyCall(pyName: string, args: Record<string, unknown>, t: ToolDef): string {
  void t;
  const lit = (v: unknown): string => (v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : typeof v === 'string' ? JSON.stringify(v) : typeof v === 'number' ? String(v) : JSON.stringify(v));
  return `${pyName}(${Object.entries(args).map(([k, v]) => `${k}=${lit(v)}`).join(', ')})`;
}

/** Top-level keys of a (shaped) success schema, `[]` wrapped for lists. */
function topKeys(s: Record<string, unknown>): string[] | undefined {
  const props = (x: Record<string, unknown>): string[] | undefined => (x.properties && typeof x.properties === 'object' ? Object.keys(x.properties as object).slice(0, 30) : undefined);
  if (s.type === 'array' && s.items && typeof s.items === 'object') return props(s.items as Record<string, unknown>)?.map((k) => `[].${k}`);
  return props(s);
}

/** Compact argument list of an input schema: `owner*: string, state?: "open"|"closed", labels?: string[]`. */
export function argSignature(schema: Record<string, unknown>, max = 12): string {
  const props = schema.properties && typeof schema.properties === 'object' ? (schema.properties as Record<string, Record<string, unknown>>) : {};
  const req = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const typeOf = (p: Record<string, unknown>, depth = 0): string => {
    if (!p || typeof p !== 'object' || depth > 2) return 'any';
    if (Array.isArray(p.enum) && p.enum.length && p.enum.length <= 6) return p.enum.map((e) => JSON.stringify(e)).join('|');
    for (const k of ['anyOf', 'oneOf'] as const) if (Array.isArray(p[k])) return [...new Set((p[k] as Array<Record<string, unknown>>).map((x) => typeOf(x, depth + 1)))].filter((x) => x !== 'null').join('|') || 'any';
    const t = Array.isArray(p.type) ? (p.type as string[]).filter((x) => x !== 'null').join('|') : typeof p.type === 'string' ? p.type : p.properties ? 'object' : typeof p.$ref === 'string' ? 'object' : 'any';
    if (t === 'array') return `${typeOf((p.items ?? {}) as Record<string, unknown>, depth + 1)}[]`;
    return t;
  };
  const names = Object.keys(props).sort((a, b) => Number(req.has(b)) - Number(req.has(a)));
  const parts = names.slice(0, max).map((k) => `${k}${req.has(k) ? '*' : '?'}: ${typeOf(props[k]!)}`);
  if (names.length > max) parts.push(`… ${names.length - max} more`);
  return parts.join(', ');
}
