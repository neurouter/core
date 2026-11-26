import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react';
import type { ReadinessComponent } from '@/contract';
import { cn } from '@/lib/utils';
import { BAND_BG, BAND_LABEL, BAND_STROKE, BAND_TEXT, BAND_TRACK, bandTone, componentPoints, formatScoreDelta, readinessBand, scoreAriaLabel } from './score';

const SIZES = { sm: { box: 64, r: 26, stroke: 7, num: 18, label: 0 }, md: { box: 132, r: 54, stroke: 11, num: 34, label: 12 }, lg: { box: 148, r: 62, stroke: 12, num: 40, label: 13 }, xl: { box: 190, r: 80, stroke: 14, num: 52, label: 14 } } as const;

/**
 * Score ring (prototype: full ring track + band-coloured arc from 12 o'clock, number + band label).
 * `preliminary` draws the dashed, muted variant ("Spec checks only"). `progress` (0..1) draws the
 * indigo running state with `progressLabel` in the centre. `role="img"` with a full-sentence label.
 */
export function ScoreRing({
  score, size = 'lg', preliminary = false, progress, progressLabel, className, caption,
}: { score?: number | null; size?: keyof typeof SIZES; preliminary?: boolean; progress?: number; progressLabel?: string; className?: string; caption?: string }) {
  const s = SIZES[size];
  const c = 2 * Math.PI * s.r;
  const mid = s.box / 2;
  if (progress !== undefined) {
    const p = Math.max(0, Math.min(1, progress));
    return (
      <svg width={s.box} height={s.box} viewBox={`0 0 ${s.box} ${s.box}`} role="img" aria-label={progressLabel ? `Eval running, ${progressLabel}` : 'Eval running'} className={className}>
        <circle cx={mid} cy={mid} r={s.r} fill="none" stroke="var(--brand-muted)" strokeWidth={s.stroke} />
        <circle className="score-arc transition-[stroke-dasharray] duration-700" cx={mid} cy={mid} r={s.r} fill="none" stroke="var(--primary)" strokeWidth={s.stroke} strokeLinecap="round" strokeDasharray={`${c * p} ${c}`} transform={`rotate(-90 ${mid} ${mid})`} />
        <text x={mid} y={mid + s.num * 0.25} textAnchor="middle" className="fill-foreground font-bold tabular-nums" fontSize={Math.round(s.num * 0.7)}>
          {progressLabel}
        </text>
      </svg>
    );
  }
  if (score === null || score === undefined) {
    return (
      <svg width={s.box} height={s.box} viewBox={`0 0 ${s.box} ${s.box}`} role="img" aria-label="No readiness score yet" className={className}>
        <circle cx={mid} cy={mid} r={s.r} fill="none" stroke="var(--border)" strokeWidth={s.stroke} strokeDasharray="6 6" />
        <text x={mid} y={mid + s.num * 0.33} textAnchor="middle" className="fill-muted-foreground font-bold" fontSize={s.num}>
          –
        </text>
      </svg>
    );
  }
  const tone = bandTone(readinessBand(score));
  const frac = Math.max(0, Math.min(100, score)) / 100;
  const label = preliminary ? (caption ?? 'Spec checks only') : BAND_LABEL[readinessBand(score)];
  return (
    <svg width={s.box} height={s.box} viewBox={`0 0 ${s.box} ${s.box}`} role="img" aria-label={scoreAriaLabel(score, preliminary)} className={className}>
      <circle cx={mid} cy={mid} r={s.r} fill="none" stroke={preliminary ? 'var(--border)' : BAND_TRACK[tone]} strokeWidth={s.stroke} strokeDasharray={preliminary ? '6 6' : undefined} />
      <circle
        className="score-arc transition-[stroke-dasharray] duration-1000"
        cx={mid}
        cy={mid}
        r={s.r}
        fill="none"
        stroke={BAND_STROKE[tone]}
        strokeOpacity={preliminary ? 0.55 : 1}
        strokeWidth={s.stroke}
        strokeLinecap={preliminary ? 'butt' : 'round'}
        strokeDasharray={`${c * frac} ${c}`}
        transform={`rotate(-90 ${mid} ${mid})`}
      />
      <text x={mid} y={mid + (s.label ? s.num * 0.1 : s.num * 0.35)} textAnchor="middle" className="fill-foreground font-bold tabular-nums" fontSize={s.num}>
        {Math.round(score)}
      </text>
      {s.label ? (
        <text x={mid} y={mid + s.num * 0.1 + s.label * 1.85} textAnchor="middle" fontSize={s.label} fontWeight={preliminary ? 400 : 600} fill={preliminary ? 'var(--muted-foreground)' : BAND_STROKE[tone]}>
          {label}
        </text>
      ) : null}
    </svg>
  );
}

/** Compact "87 · Ready" badge; preliminary scores are dashed and muted (Hub's low-confidence pattern). */
export function ScoreBadge({ score, preliminary = false, className }: { score: number | null | undefined; preliminary?: boolean; className?: string }) {
  if (score === null || score === undefined) return <span className={cn('text-[13px] text-muted-foreground', className)}>No score</span>;
  const band = readinessBand(score);
  const tone = bandTone(band);
  return (
    <span
      className={cn(
        'inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full border px-2 text-xs font-semibold whitespace-nowrap tabular-nums',
        preliminary ? 'border-dashed border-muted-foreground/50 text-muted-foreground' : cn('border-transparent', BAND_TEXT[tone], tone === 'low' ? 'bg-destructive-muted' : tone === 'mid' ? 'bg-warning-muted' : 'bg-success-muted'),
        className,
      )}
      title={preliminary ? 'Preliminary: spec checks only' : undefined}
    >
      {Math.round(score)}
      <span className="font-medium">· {preliminary ? 'Preliminary' : BAND_LABEL[band]}</span>
    </span>
  );
}

/** "+35" with an arrow and screen-reader text. */
export function ScoreDelta({ delta, suffix, className }: { delta: number | null | undefined; suffix?: string; className?: string }) {
  if (delta === null || delta === undefined) return null;
  const up = delta > 0;
  const down = delta < 0;
  const Icon = up ? ArrowUpIcon : down ? ArrowDownIcon : null;
  return (
    <span className={cn('inline-flex items-center gap-0.5 text-xs font-semibold tabular-nums', up ? 'text-success' : down ? 'text-destructive' : 'text-muted-foreground', className)}>
      {Icon ? <Icon aria-hidden="true" className="size-3" /> : null}
      <span className="sr-only">{up ? 'up' : down ? 'down' : 'unchanged'} </span>
      {formatScoreDelta(delta)}
      {suffix ? <span className="font-medium"> {suffix}</span> : null}
    </span>
  );
}

/** Generic breakdown list with bars; the backend owns names and weights (A-SCORE). */
export function ScoreBreakdown({ items, compact = false, className }: { items: Pick<ReadinessComponent, 'key' | 'label' | 'score' | 'detail'>[]; compact?: boolean; className?: string }) {
  return (
    <ul className={cn('flex flex-col gap-2.5', className)} aria-label="Score breakdown">
      {items.map((b) => {
        const v = componentPoints(b.score);
        const tone = bandTone(readinessBand(v));
        return (
          <li key={b.key} className={cn('grid items-center gap-2.5 text-[13.5px]', compact ? 'grid-cols-[1fr_90px_28px]' : 'grid-cols-[minmax(0,180px)_1fr_32px]')} title={b.detail ?? undefined}>
            <span className="min-w-0 truncate">{b.label}</span>
            <span className={cn('overflow-hidden rounded-full bg-muted', compact ? 'h-1.5' : 'h-2')} aria-hidden="true">
              <span className={cn('block h-full rounded-full', BAND_BG[tone])} style={{ width: `${v}%` }} />
            </span>
            <span className="text-right font-semibold tabular-nums">
              {v}
              <span className="sr-only"> out of 100</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}
