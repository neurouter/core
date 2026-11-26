import type { TimelineItem } from '@/contract';

/** Idle gap separator threshold: a pause of more than a minute between two items. */
export const IDLE_GAP_MS = 60_000;

export type Row = { type: 'item'; item: TimelineItem; offsetMs: number; latencyPct: number } | { type: 'gap'; id: string; ms: number };

/**
 * Timeline rows (adapted from Hub's session timeline): items sorted by time, an idle-gap
 * separator between items more than `IDLE_GAP_MS` apart, the offset from the task start and a
 * latency bar width relative to the slowest item. Backend `gap` items pass through as separators.
 */
export function buildRows(items: TimelineItem[], startedAt: string): Row[] {
  const start = Date.parse(startedAt);
  const sorted = [...items].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  const max = Math.max(1, ...sorted.map((i) => i.durationMs ?? 0));
  const rows: Row[] = [];
  let prevEnd: number | null = null;
  for (const item of sorted) {
    const ts = Date.parse(item.ts);
    if (item.kind === 'gap') {
      rows.push({ type: 'gap', id: item.id, ms: item.durationMs ?? 0 });
      prevEnd = ts + (item.durationMs ?? 0);
      continue;
    }
    if (prevEnd !== null && ts - prevEnd > IDLE_GAP_MS) rows.push({ type: 'gap', id: `gap-${item.id}`, ms: ts - prevEnd });
    rows.push({ type: 'item', item, offsetMs: ts - start, latencyPct: Math.round(((item.durationMs ?? 0) / max) * 100) });
    prevEnd = ts + (item.durationMs ?? 0);
  }
  return rows;
}

/** Every write call in the task, including the ones inside scripts. */
export function writeCalls(items: TimelineItem[]): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const i of items) {
    if (i.kind === 'call' && i.write && !i.dryRun) out.push(i);
    if (i.children) out.push(...writeCalls(i.children));
  }
  return out;
}

/** Decision items in order. */
export function decisions(items: TimelineItem[]): TimelineItem[] {
  return items.filter((i) => i.kind === 'decision');
}

/** "4 m 12 s", "1.2 s", "380 ms" */
export function compactDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return s ? `${m} m ${s} s` : `${m} m`;
}
