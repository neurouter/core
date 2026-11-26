import { describe, expect, it } from 'vitest';
import type { TimelineItem } from '@/contract';
import { buildRows, compactDuration, decisions, writeCalls } from './timeline';

const t0 = Date.parse('2026-11-26T09:14:00.000Z');
const at = (s: number) => new Date(t0 + s * 1000).toISOString();
const item = (id: string, s: number, extra: Partial<TimelineItem> = {}): TimelineItem => ({ id, kind: 'call', ts: at(s), summary: id, ...extra });

describe('task timeline', () => {
  it('orders items, computes offsets and latency bars', () => {
    const rows = buildRows([item('b', 5, { durationMs: 100 }), item('a', 1, { durationMs: 400 })], at(0));
    expect(rows.map((r) => (r.type === 'item' ? r.item.id : 'gap'))).toEqual(['a', 'b']);
    expect(rows[0]).toMatchObject({ offsetMs: 1000, latencyPct: 100 });
    expect(rows[1]).toMatchObject({ offsetMs: 5000, latencyPct: 25 });
  });

  it('inserts an idle-gap separator for pauses over a minute', () => {
    const rows = buildRows([item('a', 0), item('b', 200)], at(0));
    expect(rows.map((r) => r.type)).toEqual(['item', 'gap', 'item']);
    expect(rows[1]).toMatchObject({ type: 'gap', ms: 200_000 });
  });

  it('collects writes inside scripts but not planned (dry-run) ones', () => {
    const script = item('s', 1, { kind: 'script', children: [item('w1', 2, { write: true }), item('p', 3, { write: true, dryRun: true })] });
    expect(writeCalls([script, item('w2', 4, { write: true })]).map((i) => i.id)).toEqual(['w1', 'w2']);
  });

  it('lists decisions in order', () => {
    expect(decisions([item('d', 1, { kind: 'decision' }), item('c', 2)]).map((i) => i.id)).toEqual(['d']);
  });

  it('formats durations compactly', () => {
    expect(compactDuration(252_000)).toBe('4 m 12 s');
    expect(compactDuration(1200)).toBe('1.2 s');
    expect(compactDuration(380)).toBe('380 ms');
    expect(compactDuration(null)).toBe('—');
  });
});
