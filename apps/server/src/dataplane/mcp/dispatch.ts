import { CALL_TOOL, META_CALL_ID, META_NEXT_TOOLS, META_TASK_ID, META_TOOL_NAMES, OPS_TOOLS, opsMcpName, RUN_SCRIPT, SEARCH_TOOLS, type OpsTool } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import { newId } from '../../kernel/lib/ids.js';
import type { RunContext } from '../pipeline/context.js';
import { errorResult } from '../pipeline/errors.js';
import type { Confirmer, McpToolResult, Pipeline } from '../pipeline/pipeline.js';
import type { ToolSearchService } from '../search/search.service.js';
import type { ScriptRunner } from '../code/run-script.js';
import { opFor, opsDefinition, type OpsTools } from '../ops/ops.js';
import type { TaskTracker } from '../tasks/tracker.js';
import { visibleTools, type Surface } from './surface.js';

export interface DispatchDeps {
  pipeline: Pipeline;
  ops: OpsTools;
  scripts: ScriptRunner;
  search: ToolSearchService;
  tracker: TaskTracker;
  audit: AuditRecorder;
  now: () => number;
}

export type DispatchResult =
  | { kind: 'result'; result: McpToolResult }
  | { kind: 'input_required'; result: unknown }
  /** Unknown tool on a direct call: JSON-RPC -32602 (Hub behaviour). */
  | { kind: 'unknown'; message: string };

export interface SearchItem {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  write: boolean;
  inputSchema?: Record<string, unknown>;
  pySignature?: string;
  pyName?: string;
  score: number;
}

/**
 * `tools/call` router: meta-tools (`search_tools`, `call_tool`, `run_script`), ops tools
 * (`neurouter_*`) and API tools (the pipeline). Also used by the console's test-search box.
 */
export class Dispatcher {
  constructor(private readonly d: DispatchDeps) {}

  async call(ctx: RunContext, name: string, args: Record<string, unknown>, surface: Surface, confirmer: Confirmer | null, signal?: AbortSignal): Promise<DispatchResult> {
    // first call in an inferred task: one-time begin_task tip (§11.3)
    const tip = async (r: McpToolResult): Promise<McpToolResult> => {
      if (!ctx.taskId || name === opsMcpName('begin_task')) return r;
      const t = ctx.framing === 'inferred' && (await this.d.tracker.takeHint(ctx.taskId));
      if (!t) return r;
      const meta = { ...(r._meta ?? {}) };
      meta[META_NEXT_TOOLS] = [...new Set([...((meta[META_NEXT_TOOLS] as string[] | undefined) ?? []), 'neurouter_begin_task'])];
      return { ...r, content: [...r.content, { type: 'text', text: 'Tip: call neurouter_begin_task(goal) so this work is tracked as one task.' }], _meta: meta };
    };
    if (name === SEARCH_TOOLS) return { kind: 'result', result: await tip(await this.searchTools(ctx, args, surface)) };
    if (name === RUN_SCRIPT) {
      if (!surface.code) return { kind: 'unknown', message: `Unknown tool: ${name}` };
      const r = await this.d.scripts.run({ ...ctx, mode: 'code' }, args, confirmer, signal);
      if (r.inputRequired) return { kind: 'input_required', result: r.inputRequired };
      return { kind: 'result', result: r.result };
    }
    if (name === CALL_TOOL) {
      if (surface.discovery !== 'search' && surface.mode === 'code') return { kind: 'unknown', message: `Unknown tool: ${name}` };
      const inner = typeof args.name === 'string' ? args.name : '';
      const innerArgs = args.arguments === undefined ? {} : args.arguments;
      if (!inner || typeof innerArgs !== 'object' || innerArgs === null || Array.isArray(innerArgs)) return { kind: 'result', result: errorResult('call_tool needs { name: string, arguments?: object }', null, 'invalid_args') };
      if ((META_TOOL_NAMES as readonly string[]).includes(inner)) return { kind: 'result', result: errorResult(`call_tool cannot call ${inner}`, null, 'invalid_args') };
      const op = opFor(ctx, inner);
      if (op) return { kind: 'result', result: await tip((await this.d.ops.call(ctx, op, innerArgs as Record<string, unknown>)).result) };
      const out = await this.d.pipeline.invoke({ ...ctx, via: ctx.via === 'eval' ? 'eval' : 'call_tool' }, inner, innerArgs as Record<string, unknown>, { confirmer, ...(signal ? { signal } : {}) });
      if (out.inputRequired) return { kind: 'input_required', result: out.inputRequired };
      return { kind: 'result', result: await tip(out.result) };
    }
    const op = opFor(ctx, name);
    if (op) return { kind: 'result', result: await tip((await this.d.ops.call(ctx, op, args)).result) };
    // a tool that is not on the surface is still callable directly when visible (clients may cache lists)
    const out = await this.d.pipeline.invoke(ctx, name, args, { confirmer, ...(signal ? { signal } : {}) });
    if (out.unknown) return { kind: 'unknown', message: `Unknown tool: ${name}` };
    if (out.inputRequired) return { kind: 'input_required', result: out.inputRequired };
    return { kind: 'result', result: await tip(out.result) };
  }

  /** `search_tools` (§9.4): ACL before ranking (only the principal's visible tools are scored). */
  async searchTools(ctx: RunContext, args: Record<string, unknown>, surface: Surface): Promise<McpToolResult> {
    const start = this.d.now();
    const query = typeof args.query === 'string' ? args.query.trim() : '';
    if (!query || query.length > 500) return errorResult('search_tools needs a query of 1–500 characters', null, 'invalid_args');
    const limit = Number.isInteger(args.limit) ? Math.min(25, Math.max(1, args.limit as number)) : 8;
    const format = args.format === 'json' || args.format === 'python' ? args.format : surface.code ? 'python' : 'json';
    const includeSchemas = args.include_schemas !== false;
    const res = await this.search(ctx, query, limit, format, includeSchemas);
    const auditId = newId();
    this.d.audit.record({ ...this.d.pipeline.auditBase(ctx), id: auditId, kind: 'tool_search', toolName: SEARCH_TOOLS, decision: 'allowed', status: 'ok', decisionReason: `search:${res.mode}`, params: { query, limit, format }, output: { names: res.tools.map((t) => t.name) }, latencyMs: this.d.now() - start });
    this.d.tracker.bump(ctx.taskId, { ops_count: 0 });
    const meta: Record<string, unknown> = { [META_CALL_ID]: auditId, ...(ctx.taskId ? { [META_TASK_ID]: ctx.taskId } : {}) };
    const structured: Record<string, unknown> = { tools: res.tools, totalVisible: res.totalVisible };
    let text: string;
    if (!res.tools.length) {
      structured.hint = 'No tool matches. If the user needs something this API cannot do, call neurouter_report_unmet_need.';
      meta[META_NEXT_TOOLS] = ['neurouter_report_unmet_need'];
      text = String(structured.hint);
    } else if (format === 'python') {
      text = res.tools.map((t) => (t.pySignature ? `${t.pySignature}\n    """${t.description.split('\n')[0]!.slice(0, 300)}"""` : `${t.name} — ${t.description.split('\n')[0]!.slice(0, 200)}`)).join('\n\n');
    } else {
      text = res.tools.map((t) => `${t.name} — ${t.description.split('\n')[0]!.slice(0, 200)}${t.write ? ' (write)' : ''}`).join('\n');
    }
    return { content: [{ type: 'text', text }], structuredContent: structured, _meta: meta };
  }

  async search(ctx: RunContext, query: string, limit: number, format: 'json' | 'python', includeSchemas: boolean): Promise<{ tools: SearchItem[]; totalVisible: number; mode: string }> {
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
        ...(includeSchemas && format === 'json' ? { inputSchema: t.inputSchema } : {}),
        ...(format === 'python' ? { pySignature: t.pySignature, pyName: t.pyName } : {}),
        score: r.score,
      });
    }
    // ops tools are searchable too ("neurouter" finds them all)
    const q = query.toLowerCase();
    const words = q.match(/[a-z0-9]+/g) ?? [];
    for (const op of OPS_TOOLS.filter((o) => ctx.bundle.server.opsTools[o as OpsTool])) {
      const d = opsDefinition(op);
      const hay = `${d.name} ${d.title} ${d.description}`.toLowerCase();
      const hit = q.includes('neurouter') || (words.length > 0 && words.filter((w) => w.length > 3).some((w) => hay.includes(w)) && words.filter((w) => hay.includes(w)).length >= Math.min(2, words.length));
      if (hit && items.length < limit + 8) items.push({ name: d.name, title: d.title, description: d.description, readOnly: Boolean(d.annotations.readOnlyHint), write: false, ...(includeSchemas && format === 'json' ? { inputSchema: d.inputSchema } : {}), ...(format === 'python' && d.pyName ? { pySignature: `ops.${op}(...)`, pyName: d.pyName } : {}), score: 0 });
    }
    return { tools: items.slice(0, Math.max(limit, q.includes('neurouter') ? limit + 8 : limit)), totalVisible: visible.length, mode };
  }
}
