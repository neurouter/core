import type { ToolDef } from '@neurouter/shared';
import type { PolicySpec } from '../../kernel/runtime-config.js';

export interface PriorCall {
  tool: string;
  tags: string[];
  ok: boolean;
}

export type PolicyResult = { deny: false } | { deny: true; policy: string; message: string };

const URL_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Built-in `no-raw-urls` (§9.8): path parameters never carry absolute URLs or `..`. */
export function noRawUrls(tool: ToolDef, args: Record<string, unknown>): PolicyResult {
  if (tool.binding.type !== 'http') return { deny: false };
  const pathArgs = new Set(tool.binding.params.filter((p) => p.in === 'path').map((p) => p.arg));
  const renamed = Object.entries(tool.args?.renamed ?? {});
  for (const [visible, orig] of renamed) if (pathArgs.has(orig)) pathArgs.add(visible);
  for (const [k, v] of Object.entries(args)) {
    if (!pathArgs.has(k) || typeof v !== 'string') continue;
    if (URL_RE.test(v) || v.includes('..')) return { deny: true, policy: 'no-raw-urls', message: `Argument "${k}" must be an identifier, not a URL or relative path.` };
  }
  return { deny: false };
}

function matches(sel: { tags?: string[]; tools?: string[] } | undefined, tool: string, tags: readonly string[]): boolean {
  if (!sel) return true;
  const byTool = sel.tools?.length ? sel.tools.includes(tool) : undefined;
  const byTag = sel.tags?.length ? sel.tags.some((t) => tags.includes(t)) : undefined;
  if (byTool === undefined && byTag === undefined) return true;
  return Boolean(byTool) || Boolean(byTag);
}

/** `"08:00-18:00 Europe/Helsinki"` → true when `now` is outside the window in that zone. */
export function outsideHours(spec: string, now: Date): boolean {
  const m = /^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})(?:\s+(\S+))?$/.exec(spec.trim());
  if (!m) return false;
  const tz = m[5] ?? 'UTC';
  let hh = now.getUTCHours();
  let mm = now.getUTCMinutes();
  try {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(now);
    hh = Number(parts.find((p) => p.type === 'hour')?.value ?? hh) % 24;
    mm = Number(parts.find((p) => p.type === 'minute')?.value ?? mm);
  } catch {
    // unknown zone → UTC
  }
  const cur = hh * 60 + mm;
  const start = Number(m[1]) * 60 + Number(m[2]);
  const end = Number(m[3]) * 60 + Number(m[4]);
  const inside = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
  return !inside;
}

/**
 * Basic environment policies (§9.8): evaluated in order, first deny wins; `sequence` is a
 * data-flow rule over the task's call history (e.g. no external write after a sensitive read).
 */
export function evaluatePolicies(policies: readonly PolicySpec[], tool: ToolDef, args: Record<string, unknown>, history: readonly PriorCall[], now: Date): PolicyResult {
  const builtin = noRawUrls(tool, args);
  if (builtin.deny) return builtin;
  for (const p of policies) {
    const d = p.deny;
    if (d.sequence) {
      const thenHit = matches(d.sequence.then, tool.name, tool.tags);
      if (!thenHit) continue;
      const firstHit = history.some((h) => h.ok && matches(d.sequence!.first, h.tool, h.tags));
      if (!firstHit) continue;
    } else if (!matches({ ...(d.tools ? { tools: d.tools } : {}), ...(d.tags ? { tags: d.tags } : {}) }, tool.name, tool.tags)) continue;
    if (d.when?.argMatches) {
      let all = true;
      for (const [arg, re] of Object.entries(d.when.argMatches)) {
        const v = args[arg];
        let ok: boolean;
        try {
          ok = v !== undefined && new RegExp(re).test(typeof v === 'string' ? v : JSON.stringify(v));
        } catch {
          ok = false;
        }
        if (!ok) all = false;
      }
      if (!all) continue;
    }
    if (d.when?.outsideHours && !outsideHours(d.when.outsideHours, now)) continue;
    return { deny: true, policy: p.name, message: p.message ?? `Blocked by the "${p.name}" policy.` };
  }
  return { deny: false };
}
