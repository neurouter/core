import {
  CALL_TOOL,
  META_CONFIRM,
  META_DEF_HASH,
  META_DEFER_LOADING,
  META_NEXT_TOOLS,
  META_WRITE,
  META_WRITES_ENABLED,
  OPS_VISIBILITY,
  READ_RESULT,
  SEARCH_TOOLS,
  type OpsTool,
  type ToolDef,
} from '@neurouter/shared';
import type { RunContext } from '../pipeline/context.js';
import { resolveVisibleTool, writeEnabled } from '../pipeline/pipeline.js';
import { enabledOps, opsDefinition } from '../ops/ops.js';
import { codeModeAvailable, RUN_SCRIPT_DEFINITION } from '../code/run-script.js';

export interface McpToolEntry {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export const SEARCH_TOOLS_DEFINITION: McpToolEntry = {
  name: SEARCH_TOOLS,
  title: 'Search the API tools',
  description: 'Find tools for what you want to do (natural language). Returns tool names with their input schemas or Python signatures. Search "neurouter" for the helper tools.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1, maxLength: 500 },
      limit: { type: 'integer', minimum: 1, maximum: 25, default: 8 },
      format: { type: 'string', enum: ['json', 'python'] },
      include_schemas: { type: 'boolean', default: true },
    },
    required: ['query'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export const CALL_TOOL_DEFINITION: McpToolEntry = {
  name: CALL_TOOL,
  title: 'Call a tool by name',
  description: 'Call an API tool found with search_tools: pass its exact name and arguments.',
  inputSchema: { type: 'object', properties: { name: { type: 'string' }, arguments: { type: 'object', default: {} } }, required: ['name'], additionalProperties: false },
  annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
};

/** Tools the principal may see (hidden + profile filter), before discovery. */
export function visibleTools(ctx: RunContext): ToolDef[] {
  return ctx.bundle.build.tools.filter((t) => resolveVisibleTool(ctx, t.name) !== null);
}

export function apiToolEntry(ctx: RunContext, t: ToolDef, deferLoading?: boolean): McpToolEntry {
  const writes = !t.risk.write || writeEnabled(ctx, t);
  return {
    name: t.name,
    ...(t.title ? { title: t.title } : {}),
    description: t.description,
    inputSchema: t.inputSchema,
    ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
    annotations: { title: t.title, readOnlyHint: t.risk.readOnly, destructiveHint: t.risk.destructive, idempotentHint: t.risk.idempotent, openWorldHint: t.risk.openWorld },
    _meta: {
      [META_WRITE]: t.risk.write,
      [META_WRITES_ENABLED]: writes,
      // both confirm modes ask the user through elicitation; they differ only for clients that cannot be asked
      [META_CONFIRM]: t.risk.write && ctx.bundle.environment.writes.confirm !== 'none' ? 'elicit' : 'none',
      [META_DEF_HASH]: t.defHash,
      [META_DEFER_LOADING]: deferLoading ?? false,
    },
  };
}

export function opsEntry(op: OpsTool | typeof READ_RESULT): McpToolEntry {
  const d = opsDefinition(op);
  return { name: d.name, title: d.title, description: d.description, inputSchema: d.inputSchema, annotations: d.annotations };
}

export interface Surface {
  mode: 'tools' | 'code' | 'both';
  discovery: 'full' | 'search';
  code: boolean;
  tools: McpToolEntry[];
}

/** Effective exposure (§9.3): mode × env code mode × scope code:run × kill switches (+ eval override header). */
export function effectiveMode(ctx: RunContext, executorHealthy: boolean): 'tools' | 'code' | 'both' {
  const code = codeModeAvailable(ctx, executorHealthy);
  const m = ctx.exposureOverride ?? ctx.bundle.server.exposure.mode;
  if (m === 'tools') return 'tools';
  if (m === 'code') return code ? 'code' : 'tools';
  if (m === 'both') return code ? 'both' : 'tools';
  return code ? 'both' : 'tools';
}

/**
 * `tools/list` composition (§9.3, §9.4): API tools per discovery (+ pinned ops tools) in tools
 * mode; `search_tools` + `run_script` (+ pinned ops) in code mode; both adds run_script.
 * discovery=search lists pinned tools + search_tools + call_tool. Native-search clients get
 * every tool with `_meta.defer_loading` on non-pinned ones (A6).
 */
export function buildSurface(ctx: RunContext, opts: { executorHealthy: boolean; usagePinned?: string[]; nativeSearchClients?: string[] }): Surface {
  const mode = effectiveMode(ctx, opts.executorHealthy);
  const visible = visibleTools(ctx);
  const envOverride = ctx.bundle.environment.discoveryOverride;
  const configured = envOverride ?? ctx.bundle.server.exposure.discovery;
  const discovery: 'full' | 'search' = configured === 'auto' ? (visible.length <= 40 ? 'full' : 'search') : configured;
  const pinnedNames = new Set([...ctx.bundle.server.exposure.pinned, ...ctx.bundle.build.pinned]);
  for (const n of (opts.usagePinned ?? []).slice(0, 5)) pinnedNames.add(n);
  const pinned = visible.filter((t) => pinnedNames.has(t.name)).slice(0, 15);
  const ops = enabledOps(ctx);
  const pinnedOps = ops.filter((o) => OPS_VISIBILITY[o] === 'pinned').map(opsEntry);
  const native = Boolean(ctx.client.name && opts.nativeSearchClients?.includes(ctx.client.name));
  const out: McpToolEntry[] = [];
  const code = mode !== 'tools';
  if (mode === 'code') {
    out.push(SEARCH_TOOLS_DEFINITION, RUN_SCRIPT_DEFINITION as unknown as McpToolEntry, ...pinnedOps);
    return { mode, discovery, code, tools: out };
  }
  if (native) {
    for (const t of visible) out.push(apiToolEntry(ctx, t, !pinnedNames.has(t.name)));
  } else if (discovery === 'full') {
    for (const t of visible) out.push(apiToolEntry(ctx, t, false));
  } else {
    for (const t of pinned) out.push(apiToolEntry(ctx, t, false));
    out.push(SEARCH_TOOLS_DEFINITION, CALL_TOOL_DEFINITION);
  }
  out.push(...pinnedOps);
  if (discovery === 'full' && !native) {
    for (const o of ops.filter((x) => OPS_VISIBILITY[x] === 'search')) out.push(opsEntry(o));
    out.push(opsEntry(READ_RESULT));
  }
  if (mode === 'both') out.push(RUN_SCRIPT_DEFINITION as unknown as McpToolEntry);
  return { mode, discovery, code, tools: out };
}

/** Server `instructions` (§9.5), generated per bundle. */
export function instructions(ctx: RunContext, surface: Surface): string {
  const e = ctx.bundle.environment;
  const writeState = !e.writes.enabled ? 'read-only' : e.writes.confirm !== 'none' ? "writes need your user's confirmation" : 'writes enabled';
  const ns = ctx.server.slug.replace(/-/g, '_');
  const lines = [
    `This MCP server exposes the ${ctx.bundle.server.name} API (${e.slug}, ${writeState}) through Neurouter.`,
    'Start every user request with neurouter_begin_task(goal) and finish with neurouter_end_task(outcome). If the user needs something no tool can do, call neurouter_report_unmet_need instead of guessing.',
  ];
  if (surface.discovery === 'search' && surface.mode !== 'code') lines.push('Not every tool is listed: call search_tools with what you want to do, then call_tool with the exact name.');
  if (surface.code) lines.push(`For multi-step work, prefer run_script: a short Python script (no imports, no I/O) that calls tools as ${ns}.<fn>(...) and returns a small result. Get signatures with search_tools. Use mode="dry_run" first for anything that writes.`);
  lines.push('Errors include an error_id; neurouter_explain_error(error_id) tells you how to fix the call. Search "neurouter" to find the other helper tools.');
  return lines.join('\n');
}

/** Tool hints attached to an empty search (§9.4). */
export const EMPTY_SEARCH_META = { [META_NEXT_TOOLS]: ['neurouter_report_unmet_need'] };
