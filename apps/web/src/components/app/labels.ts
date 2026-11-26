import type { EvalRunRow, OverlayChange } from '@/contract';

/** "#14" for run ids like `run_14` (demo / sequential ids), otherwise a short id. CR-6 asks for a run number. */
export function runLabel(run: Pick<EvalRunRow, 'id'> | string): string {
  const id = typeof run === 'string' ? run : run.id;
  const m = id.match(/^run_(\d+)$/);
  return m ? `#${m[1]}` : `#${id.slice(-6)}`;
}

/** Original operation name from an overlay selector key (`operationId:getOrdersV2` → `getOrdersV2`). */
export function keyName(key: string): string {
  if (key.startsWith('operationId:')) return key.slice('operationId:'.length);
  if (key.startsWith('graphql:')) return key.slice('graphql:'.length);
  return key;
}

const words = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().split(/\s+/).length : 0);
const list = (v: unknown) => (Array.isArray(v) ? v.length : 0);

/**
 * Overlay change → a sentence (frontend spec §11 "Diffs": changes are said in words, e.g.
 * "Description changed, 2 → 18 words").
 */
export function describeChange(c: OverlayChange): string {
  const f = c.field ?? '';
  if (c.kind !== 'tool') return `${c.kind} ${c.target} ${c.change}`;
  switch (f) {
    case 'name':
      return `Renamed to ${String(c.after ?? '')}`;
    case 'description':
      return `Description changed, ${words(c.before)} → ${words(c.after)} words`;
    case 'hidden':
      return c.after ? 'Hidden from agents' : 'Visible to agents';
    case 'pinned':
      return c.after ? 'Pinned' : 'Unpinned';
    case 'examples':
      return `Examples ${list(c.before)} → ${list(c.after)}`;
    case 'response.include':
      return c.after ? `Response keeps ${list(c.after)} fields` : 'Response keeps all fields';
    case 'response.redact':
      return `${list(c.after)} secret ${list(c.after) === 1 ? 'field' : 'fields'} redacted`;
    case 'response.maxItems':
      return `Max list items ${c.before ?? 'none'} → ${c.after ?? 'none'}`;
    case 'response.exclude':
      return `${list(c.after)} fields excluded`;
    default:
      return `${f} ${c.change}`;
  }
}

export const CATEGORY_LABEL = { single: 'single', multi: 'multi-step', ambiguous: 'ambiguous', impossible: 'impossible' } as const;
