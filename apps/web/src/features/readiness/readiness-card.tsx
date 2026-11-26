import { Link } from '@tanstack/react-router';
import type { EvalRunRow, ReadinessSummary } from '@/contract';
import { runLabel } from '@/components/app/labels';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ModeRecommendation } from './mode-recommendation';
import { BAND_MUTED, BAND_TEXT, bandTone, formatScoreDelta, readinessBand } from './score';
import { ScoreBreakdown, ScoreRing } from './score-ring';

/** "+35 since run #14": the server's first measured run (runs come newest first). */
export function previousRun(runs: EvalRunRow[] | undefined, current: string | null): EvalRunRow | undefined {
  if (!runs || !current) return undefined;
  return runs.filter((r) => r.status === 'succeeded' && r.headline !== null && !r.temporaryBuild && r.id !== current).at(-1);
}

/**
 * Readiness card on the server overview (prototype Main): big ring + band + delta, the breakdown
 * bars and the mode recommendation. Preliminary scores draw the dashed ring.
 */
export function ReadinessCard({ serverId, readiness, runs, compact = false }: { serverId: string; readiness: ReadinessSummary; runs?: EvalRunRow[]; compact?: boolean }) {
  const prelim = readiness.confidence === 'preliminary';
  const run = runs?.find((r) => r.id === readiness.runId);
  const prev = prelim ? undefined : previousRun(runs, readiness.runId);
  const delta = prev?.headline != null ? readiness.score - prev.headline : null;
  const tone = bandTone(readinessBand(readiness.score));
  return (
    <section aria-labelledby="readiness-title" className={cn('flex flex-wrap gap-7 rounded-xl border bg-card p-5', compact && 'flex-col items-center gap-3 p-4')}>
      <div className={cn('flex w-[168px] flex-col items-center gap-2', compact && 'w-full')}>
        <h2 id="readiness-title" className={cn('self-start text-base font-semibold', compact && 'sr-only')}>
          Agent readiness
        </h2>
        <ScoreRing score={readiness.score} size={compact ? 'md' : 'lg'} preliminary={prelim} />
        {delta !== null && prev ? (
          <span className={cn('rounded-full px-2.5 py-0.5 text-[12.5px] font-semibold tabular-nums', BAND_TEXT[tone], BAND_MUTED[tone])}>
            {formatScoreDelta(delta)} since run {runLabel(prev)}
          </span>
        ) : null}
        {prev && !compact ? (
          <Link to="/evals/compare" search={{ base: prev.id, head: readiness.runId! }} className="text-[12.5px] text-primary hover:underline">
            Compare runs
          </Link>
        ) : null}
      </div>
      <div className={cn('flex min-w-[280px] flex-1 flex-col gap-2.5', compact && 'w-full min-w-0')}>
        {!compact ? (
          <span className="text-[12.5px] text-muted-foreground">
            {prelim ? (
              'Preliminary: spec checks only. Run an eval to measure how agents do.'
            ) : run ? (
              <>
                <Link to="/evals/runs/$runId" params={{ runId: run.id }} className="text-primary hover:underline">
                  Run {runLabel(run)}
                </Link>{' '}
                · suite v{run.suite.version} · {run.models.length} {run.models.length === 1 ? 'model' : 'models'} · {run.modes.join(' + ')} · {formatRelative(run.endedAt)}
              </>
            ) : (
              <>Measured {formatRelative(readiness.measuredAt)}</>
            )}
          </span>
        ) : null}
        <ScoreBreakdown items={readiness.breakdown} compact={compact} />
        {!prelim ? <ModeRecommendation mode={readiness.recommendedMode} text={readiness.recommendation} compact={compact} className="mt-1.5" /> : null}
        {prelim && !compact ? (
          <Link to="/evals" search={{ server: serverId, new: '1' }} className="mt-1 text-[13px] font-medium text-primary hover:underline">
            Run your first eval
          </Link>
        ) : null}
      </div>
    </section>
  );
}
