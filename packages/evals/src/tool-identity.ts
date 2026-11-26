/**
 * Suite stability across tool renames. Assertions and reference calls carry the tool's stable key
 * (`ToolDef.key`: `operationId:<id>`, `"<METHOD> <path>"`, …) next to its display name; before a run
 * they are resolved against the build's tools, so a frozen suite keeps working when an overlay renames
 * tools (before/after comparisons with renames). Older suites without keys fall back to the name, and
 * to the tool's spec-derived (pre-overlay) name when the overlay renamed it.
 */
import { nameFromMethodPath, toToolName } from '@neurouter/compiler';
import type { Assertion, ReferenceCall } from '@neurouter/shared';
import type { EvalTask } from './types.js';

/** What resolution needs from a build tool. */
export interface ToolIdentity {
  name: string;
  key: string;
  /** Name the compiler gives the source operation without an overlay (derived from `key` when omitted). */
  sourceName?: string | null;
}

/** The name an OpenAPI tool gets from its key without overlay renames (null for other kinds). */
export function sourceNameOfKey(key: string): string | null {
  if (key.startsWith('operationId:')) return toToolName(key.slice('operationId:'.length));
  const m = /^(GET|PUT|POST|DELETE|PATCH|HEAD) (\/.*)$/.exec(key);
  return m ? nameFromMethodPath(m[1]!.toLowerCase(), m[2]!) : null;
}

export interface ToolResolver {
  /** Current name of the tool an assertion/reference names (unchanged when unknown). */
  name(tool: string, toolKey?: string): string;
  /** Stable key of a current tool name (for stamping generated tasks). */
  key(name: string): string | undefined;
}

export function toolResolver(tools: ToolIdentity[]): ToolResolver {
  const byKey = new Map(tools.map((t) => [t.key, t.name]));
  const byName = new Map(tools.map((t) => [t.name, t.key]));
  const bySource = new Map<string, string>();
  for (const t of tools) {
    const src = t.sourceName ?? sourceNameOfKey(t.key);
    if (src && !bySource.has(src)) bySource.set(src, t.name);
  }
  return {
    name(tool, toolKey) {
      if (toolKey && byKey.has(toolKey)) return byKey.get(toolKey)!;
      if (byName.has(tool)) return tool;
      return bySource.get(tool) ?? tool;
    },
    key: (name) => byName.get(name),
  };
}

/** Tasks with `called`/`not_called` assertions and reference calls pointing at the build's current names. */
export function resolveTaskTools(tasks: EvalTask[], tools: ToolIdentity[]): EvalTask[] {
  const r = toolResolver(tools);
  const assertion = (a: Assertion): Assertion => (a.type === 'called' || a.type === 'not_called' ? { ...a, tool: r.name(a.tool, a.toolKey) } : a);
  const ref = (c: ReferenceCall): ReferenceCall => ({ ...c, tool: r.name(c.tool, c.toolKey) });
  return tasks.map((t) => ({ ...t, assertions: t.assertions.map(assertion), referenceCalls: t.referenceCalls.map(ref) }));
}

/** Stamps tool keys on a task's assertions and reference calls (generation, import). Existing keys are kept. */
export function stampToolKeys(task: EvalTask, tools: ToolIdentity[]): EvalTask {
  const r = toolResolver(tools);
  const stamp = <T extends { tool: string; toolKey?: string | undefined }>(x: T): T => {
    if (x.toolKey) return x;
    const k = r.key(x.tool);
    return k ? { ...x, toolKey: k } : x;
  };
  return {
    ...task,
    assertions: task.assertions.map((a) => (a.type === 'called' || a.type === 'not_called' ? stamp(a) : a)),
    referenceCalls: task.referenceCalls.map(stamp),
  };
}
