/**
 * Applies a parsed overlay to the tool model (backend spec §8.4). Selector resolution order:
 * `defaults` → `"*"` → `tag:<tag>` → specific keys (`operationId:`, `"<METHOD> <path>"`, `graphql:`),
 * file order within each class.
 */
import type { GraphQLSchema } from 'graphql';
import type { ArgTransforms, CompositeBinding, Diagnostic, GraphqlBinding, HttpBinding, JsonSchema, Overlay, OverlayToolEntry, ToolDef } from '@neurouter/shared';
import { documentWithSelection } from '../graphql/compile-graphql.js';
import { uniquify } from '../naming.js';
import { clone, isObj } from '../util.js';
import { cleanDescription } from '../openapi/compile-openapi.js';

export interface ApplyResult {
  tools: ToolDef[];
  diagnostics: Diagnostic[];
  orphanedOverlayKeys: string[];
  profiles: Record<string, string[]>;
}

export function selectorClass(selector: string): 0 | 1 | 2 {
  if (selector === '*') return 0;
  if (selector.startsWith('tag:')) return 1;
  return 2;
}

/** True when the overlay selector addresses the tool (uses the tool's source identity, not overlay renames). */
export function matchesSelector(tool: Pick<ToolDef, 'key' | 'sourceRef' | 'tags'>, selector: string, originalTags?: string[]): boolean {
  if (selector === '*') return tool.key.startsWith('composite:') ? false : true;
  if (selector.startsWith('tag:')) return (originalTags ?? tool.tags).includes(selector.slice(4));
  if (selector === tool.key) return true;
  const ref = tool.sourceRef as { operationId?: string; method?: string; path?: string; rootType?: string; field?: string };
  if (selector.startsWith('operationId:')) return ref.operationId === selector.slice('operationId:'.length);
  if (selector.startsWith('graphql:')) return `graphql:${ref.rootType}.${ref.field}` === selector;
  const m = /^([A-Za-z]+)\s+(\/.*)$/.exec(selector);
  if (m && ref.method && ref.path) return ref.method.toUpperCase() === m[1]!.toUpperCase() && ref.path === m[2];
  return false;
}

interface Ctx {
  diagnostics: Diagnostic[];
  graphqlSchema: GraphQLSchema | null;
  lineOf: (selector: string) => number | undefined;
}

function props(tool: ToolDef): Record<string, JsonSchema> {
  const p = tool.inputSchema.properties;
  if (isObj(p)) return p as Record<string, JsonSchema>;
  tool.inputSchema.properties = {};
  return tool.inputSchema.properties as Record<string, JsonSchema>;
}

function required(tool: ToolDef): string[] {
  return Array.isArray(tool.inputSchema.required) ? (tool.inputSchema.required as string[]) : [];
}

function setRequired(tool: ToolDef, req: string[]): void {
  if (req.length) tool.inputSchema.required = [...new Set(req)];
  else delete tool.inputSchema.required;
}

function applyArgs(tool: ToolDef, selector: string, args: NonNullable<OverlayToolEntry['args']>, ctx: Ctx): void {
  const t: ArgTransforms = tool.args ?? {};
  t.renamed ??= {};
  t.hidden ??= {};
  t.defaults ??= {};
  const P = props(tool);
  const warn = (msg: string) => ctx.diagnostics.push({ severity: 'warning', code: 'overlay_unknown_arg', message: `${selector}: ${msg}`, overlayPath: `tools["${selector}"].args`, line: ctx.lineOf(selector) });
  /** visible name for an original-or-visible arg name */
  const resolve = (name: string): string | null => {
    if (name in P) return name;
    for (const [vis, orig] of Object.entries(t.renamed!)) if (orig === name && vis in P) return vis;
    return null;
  };
  const originalOf = (vis: string) => t.renamed![vis] ?? vis;

  for (const [from, to] of Object.entries(args.rename ?? {})) {
    const vis = resolve(from);
    if (!vis) {
      warn(`cannot rename unknown argument "${from}"`);
      continue;
    }
    if (to in P && to !== vis) {
      ctx.diagnostics.push({ severity: 'error', code: 'overlay_arg_collision', message: `${selector}: renaming "${from}" to "${to}" collides with an existing argument`, line: ctx.lineOf(selector) });
      continue;
    }
    const orig = originalOf(vis);
    P[to] = P[vis]!;
    if (to !== vis) delete P[vis];
    delete t.renamed![vis];
    if (to !== orig) t.renamed![to] = orig;
    setRequired(tool, required(tool).map((r) => (r === vis ? to : r)));
    if (vis in t.defaults!) {
      t.defaults![to] = t.defaults![vis];
      delete t.defaults![vis];
    }
  }

  const hideSet = new Set<string>();
  for (const h of args.hide ?? []) {
    const vis = resolve(h);
    if (!vis) warn(`cannot hide unknown argument "${h}"`);
    else hideSet.add(vis);
  }
  const defaults: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args.defaults ?? {})) {
    const vis = resolve(k);
    if (!vis) warn(`default for unknown argument "${k}"`);
    else defaults[vis] = v;
  }
  for (const vis of hideSet) {
    const schemaDefault = (P[vis] as JsonSchema | undefined)?.default;
    const value = vis in defaults ? defaults[vis] : schemaDefault;
    if (required(tool).includes(vis) && value === undefined) {
      ctx.diagnostics.push({ severity: 'error', code: 'overlay_hides_required_arg', message: `${selector}: "${vis}" is required and has no default, so it cannot be hidden`, overlayPath: `tools["${selector}"].args.hide`, line: ctx.lineOf(selector) });
      continue;
    }
    const orig = originalOf(vis);
    if (value !== undefined) t.hidden![orig] = value;
    delete P[vis];
    delete t.renamed![vis];
    delete t.defaults![vis];
    setRequired(tool, required(tool).filter((r) => r !== vis));
  }
  for (const [vis, value] of Object.entries(defaults)) {
    if (hideSet.has(vis)) continue;
    P[vis] = { ...P[vis], default: value };
    t.defaults![vis] = value;
    setRequired(tool, required(tool).filter((r) => r !== vis));
  }
  for (const [k, d] of Object.entries(args.describe ?? {})) {
    const vis = resolve(k);
    if (!vis) warn(`description for unknown argument "${k}"`);
    else P[vis] = { ...P[vis], description: d };
  }
  for (const [k, values] of Object.entries(args.enum ?? {})) {
    const vis = resolve(k);
    if (!vis) warn(`enum for unknown argument "${k}"`);
    else P[vis] = { ...P[vis], enum: values };
  }
  for (const k of args.required ?? []) {
    const vis = resolve(k);
    if (!vis) warn(`cannot require unknown argument "${k}"`);
    else setRequired(tool, [...required(tool), vis]);
  }
  for (const key of ['renamed', 'hidden', 'defaults'] as const) if (Object.keys(t[key]!).length === 0) delete t[key];
  if (Object.keys(t).length) tool.args = t;
  else delete tool.args;
}

function applyEntry(tool: ToolDef, selector: string, e: OverlayToolEntry, ctx: Ctx): void {
  if (e.name !== undefined) tool.name = e.name;
  if (e.title !== undefined) tool.title = e.title;
  if (e.description !== undefined) tool.description = cleanDescription(undefined, e.description, tool.description).text;
  if (e.hidden !== undefined) tool.hidden = e.hidden;
  if (e.pinned !== undefined) tool.pinned = e.pinned;
  if (e.deprecated !== undefined) tool.deprecated = e.deprecated;
  if (e.risk) {
    Object.assign(tool.risk, e.risk);
    if (e.risk.readOnly !== undefined && e.risk.write === undefined) tool.risk.write = !e.risk.readOnly;
    if (e.risk.write !== undefined && e.risk.readOnly === undefined) tool.risk.readOnly = !e.risk.write;
  }
  if (e.tags) tool.tags = [...new Set([...tool.tags, ...e.tags])];
  if (e.args) applyArgs(tool, selector, e.args, ctx);
  if (e.response) tool.shaping = { ...(tool.shaping ?? {}), ...e.response };
  if (e.examples) tool.examples = e.examples.map((x) => ({ ...(x.title ? { title: x.title } : {}), arguments: x.arguments, source: 'overlay' as const }));
  if (e.idempotencyHeader && tool.binding.type === 'http') (tool.binding as HttpBinding).idempotencyHeader = e.idempotencyHeader;
  if (e.readBack) tool.readBack = typeof e.readBack === 'string' ? { tool: e.readBack } : { tool: e.readBack.tool, ...(e.readBack.label?.length ? { label: e.readBack.label } : {}) };
  if (e.graphql?.selection) {
    if (tool.binding.type !== 'graphql' || !ctx.graphqlSchema) {
      ctx.diagnostics.push({ severity: 'warning', code: 'overlay_graphql_selection', message: `${selector}: graphql.selection applies only to GraphQL tools`, line: ctx.lineOf(selector) });
    } else {
      const doc = documentWithSelection(ctx.graphqlSchema, tool.binding as GraphqlBinding, tool.name, e.graphql.selection);
      if (doc) (tool.binding as GraphqlBinding).document = doc;
    }
  }
  if (!tool.overlayApplied.includes(selector)) tool.overlayApplied.push(selector);
}

/** Spec examples use pre-overlay argument names; map them to the agent-visible names. */
function remapSpecExamples(tool: ToolDef): void {
  if (!tool.args) return;
  const toVisible = new Map<string, string>();
  for (const [vis, orig] of Object.entries(tool.args.renamed ?? {})) toVisible.set(orig, vis);
  const hidden = new Set(Object.keys(tool.args.hidden ?? {}));
  tool.examples = tool.examples.map((ex) => {
    if (ex.source === 'overlay') return ex;
    const args: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ex.arguments)) {
      if (hidden.has(k)) continue;
      args[toVisible.get(k) ?? k] = v;
    }
    return { ...ex, arguments: args };
  });
}

export function compositeTool(name: string, c: NonNullable<Overlay['composites']>[string], namespace: string): ToolDef {
  const schema: JsonSchema = { type: 'object', properties: {}, ...clone(c.inputSchema), additionalProperties: false };
  const binding: CompositeBinding = { type: 'composite', script: c.script, namespace };
  const words = name.split('_').join(' ');
  return {
    name,
    pyName: '',
    title: c.title ?? words.charAt(0).toUpperCase() + words.slice(1),
    description: cleanDescription(undefined, c.description, name).text,
    kind: 'composite',
    inputSchema: schema,
    binding,
    risk: { readOnly: !c.write, destructive: false, idempotent: false, openWorld: true, write: c.write },
    tags: c.tags ?? [],
    hidden: false,
    pinned: c.pinned ?? false,
    deprecated: false,
    examples: [],
    pySignature: '',
    sourceRef: { pointer: `/composites/${name}` },
    overlayApplied: [`composite:${name}`],
    key: `composite:${name}`,
    defHash: '',
  };
}

export function applyOverlay(baseTools: ToolDef[], overlay: Overlay | null, opts: { namespace: string; graphqlSchema: GraphQLSchema | null; lineOf?: (selector: string) => number | undefined }): ApplyResult {
  const diagnostics: Diagnostic[] = [];
  const ctx: Ctx = { diagnostics, graphqlSchema: opts.graphqlSchema, lineOf: opts.lineOf ?? (() => undefined) };
  const tools = baseTools.map((t) => clone(t));
  if (!overlay) return { tools, diagnostics, orphanedOverlayKeys: [], profiles: {} };
  const originalTags = tools.map((t) => [...t.tags]);
  if (overlay.defaults?.hidden !== undefined) for (const t of tools) t.hidden = overlay.defaults.hidden;

  const entries = Object.entries(overlay.tools ?? {});
  const ordered = [0, 1, 2].flatMap((cls) => entries.filter(([sel]) => selectorClass(sel) === cls));
  const orphaned: string[] = [];
  for (const [sel, entry] of ordered) {
    let hit = 0;
    tools.forEach((t, i) => {
      if (matchesSelector(t, sel, originalTags[i])) {
        applyEntry(t, sel, entry, ctx);
        hit++;
      }
    });
    if (hit === 0 && sel !== '*') orphaned.push(sel);
  }
  for (const t of tools) remapSpecExamples(t);
  for (const [name, c] of Object.entries(overlay.composites ?? {})) tools.push(compositeTool(name, c, opts.namespace));

  // names may collide after renames
  const { names, collided } = uniquify(tools.map((t) => t.name));
  for (const i of collided) {
    diagnostics.push({ severity: 'warning', code: 'name_collision', message: `Tool name "${tools[i]!.name}" is used more than once after the overlay; renamed to "${names[i]}"` });
    tools[i]!.name = names[i]!;
  }
  const profiles: Record<string, string[]> = {};
  const known = new Set(tools.map((t) => t.name));
  for (const [p, def] of Object.entries(overlay.profiles ?? {})) {
    profiles[p] = def.tools;
    for (const n of def.tools) if (!known.has(n)) diagnostics.push({ severity: 'warning', code: 'profile_unknown_tool', message: `profile "${p}" lists unknown tool "${n}"`, overlayPath: `profiles.${p}.tools` });
  }
  // readBack must name a visible read tool whose required arguments the write has
  for (const t of tools) {
    if (!t.readBack) continue;
    const r = tools.find((x) => x.name === t.readBack!.tool);
    const req = r && Array.isArray(r.inputSchema.required) ? (r.inputSchema.required as string[]) : [];
    const have = new Set(Object.keys((t.inputSchema.properties as object | undefined) ?? {}));
    const problem = !t.risk.write ? 'is only used on write tools' : !r ? `names unknown tool "${t.readBack.tool}"` : r.risk.write ? `"${r.name}" is not a read` : req.some((a) => !have.has(a)) ? `"${r.name}" needs ${req.filter((a) => !have.has(a)).join(', ')}, which ${t.name} does not have` : null;
    if (problem) {
      diagnostics.push({ severity: 'warning', code: 'overlay_read_back', message: `${t.name}: readBack ${problem}; ignored`, overlayPath: `tools.readBack` });
      delete t.readBack;
    }
  }
  for (const o of orphaned) diagnostics.push({ severity: 'warning', code: 'overlay_orphaned', message: `Overlay key "${o}" matches no operation`, overlayPath: `tools["${o}"]`, line: ctx.lineOf(o) });
  return { tools, diagnostics, orphanedOverlayKeys: orphaned, profiles };
}
