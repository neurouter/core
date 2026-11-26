import { readinessBand, type ReadinessBand } from '@neurouter/shared';

export { readinessBand };

/** Band labels (A-BANDS). The label always appears next to the number. */
export const BAND_LABEL: Record<ReadinessBand, string> = {
  not_ready: 'Not ready',
  needs_work: 'Needs work',
  ready: 'Ready',
  excellent: 'Excellent',
};

/** CSS colour token per band: 0–49 destructive, 50–74 warning, 75+ success. */
export function bandTone(band: ReadinessBand): 'low' | 'mid' | 'high' {
  return band === 'not_ready' ? 'low' : band === 'needs_work' ? 'mid' : 'high';
}

export const BAND_TEXT = { low: 'text-destructive', mid: 'text-warning', high: 'text-success' } as const;
export const BAND_BG = { low: 'bg-destructive', mid: 'bg-warning', high: 'bg-success' } as const;
export const BAND_MUTED = { low: 'bg-destructive-muted', mid: 'bg-warning-muted', high: 'bg-success-muted' } as const;
export const BAND_STROKE = { low: 'var(--destructive)', mid: 'var(--warning)', high: 'var(--success)' } as const;
export const BAND_TRACK = { low: 'var(--destructive-muted)', mid: 'var(--warning-muted)', high: 'var(--success-muted)' } as const;

/** "Agent readiness 87 out of 100, Ready" (ScoreRing aria-label). */
export function scoreAriaLabel(score: number, preliminary = false): string {
  const band = BAND_LABEL[readinessBand(score)];
  return preliminary ? `Preliminary score ${Math.round(score)} out of 100, from spec checks only` : `Agent readiness ${Math.round(score)} out of 100, ${band}`;
}

/** "+35" / "−4" / "±0" with a typographic minus. */
export function formatScoreDelta(delta: number): string {
  const d = Math.round(delta);
  if (d > 0) return `+${d}`;
  if (d < 0) return `−${Math.abs(d)}`;
  return '±0';
}

/** Component score 0..1 → 0..100 integer for the breakdown bars. */
export function componentPoints(score01: number): number {
  return Math.round(Math.max(0, Math.min(1, score01)) * 100);
}
