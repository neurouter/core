import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { Share2Icon } from 'lucide-react';
import type { RunComparison } from '@/contract';
import { guard } from '@/app/route-guards';
import { CATEGORY_LABEL, runLabel } from '@/components/app/labels';
import { copyText } from '@/components/code/copy-button';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { PageHeader } from '@/components/layout/page-header';
import { ModeBadge } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { compareQuery } from '@/features/evals/queries';
import { formatScoreDelta } from '@/features/readiness/score';
import { ScoreRing } from '@/features/readiness/score-ring';
import { serverQuery } from '@/features/servers/queries';
import { runTasksQuery } from '@/features/evals/run-tasks';
import { notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/utils';

const search = z.object({ base: z.string().catch(''), head: z.string().catch('') });

export const Route = createFileRoute('/_app/evals/compare')({
  validateSearch: search,
  beforeLoad: guard(['evals:read']),
  component: ComparePage,
});

const passOf = (s: string | null) => (s ? Number(s.split('/')[0]) : null);

/** Flipped tasks: fail → pass and pass → fail between two runs. */
export function flips(tasks: RunComparison['tasks']): { fixed: RunComparison['tasks']; regressed: RunComparison['tasks'] } {
  const fixed = tasks.filter((t) => passOf(t.base) === 0 && (passOf(t.head) ?? 0) > 0);
  const regressed = tasks.filter((t) => {
    const b = passOf(t.base);
    const h = passOf(t.head);
    return b !== null && h !== null && h < b && b === Number(t.base?.split('/')[1]);
  });
  return { fixed, regressed };
}

/** Average success of the cells of one run (tool-mode cells only for `mode: 'tool'`). */
function successOf(cmp: RunComparison, side: 'base' | 'head', bestPerModel: boolean): number | null {
  const cells = cmp.matrix.map((m) => m[side]).filter((c): c is NonNullable<typeof c> => !!c);
  if (!cells.length) return null;
  if (!bestPerModel) {
    const tool = cells.filter((c) => c.mode === 'tool');
    return tool.reduce((a, c) => a + c.successRate, 0) / Math.max(1, tool.length);
  }
  const models = [...new Set(cells.map((c) => c.model))];
  return models.reduce((a, m) => a + Math.max(...cells.filter((c) => c.model === m).map((c) => c.successRate)), 0) / models.length;
}

/** Before / after (spec §9.14, prototype Compare): the launch demo screen. */
function ComparePage() {
  const { base, head } = Route.useSearch();
  const cmp = useQuery({ ...compareQuery(base, head), enabled: !!base && !!head });
  const server = useQuery({ ...serverQuery(cmp.data?.base.server.id ?? ''), enabled: !!cmp.data });
  const prompts = useQuery({ ...runTasksQuery(head), enabled: !!head });
  useSetCrumbs([{ label: 'Evals', to: '/evals' }, { label: `Compare ${runLabel(base)} → ${runLabel(head)}` }]);
  if (!base || !head) return <ErrorState error={new Error('Pick two runs to compare from the Evals list.')} />;
  if (cmp.isPending) return <PageSkeleton />;
  if (cmp.isError) return <ErrorState error={cmp.error} onRetry={() => void cmp.refetch()} />;
  const c = cmp.data;
  const promptOf = new Map(prompts.data?.items.map((t) => [t.key, t.prompt]) ?? []);
  const { fixed, regressed } = flips(c.tasks);
  const sBase = successOf(c, 'base', false);
  const sHead = successOf(c, 'head', true);
  const deltas = [
    { label: 'Task success', value: sBase !== null && sHead !== null ? `${Math.round(sBase * 100)}% → ${Math.round(sHead * 100)}%` : '—' },
    { label: 'Tokens per multi-step task', value: c.tokensDelta !== null ? `${c.tokensDelta < 0 ? '−' : '+'}${Math.abs(Math.round(c.tokensDelta * 100))}%` : '—' },
    { label: 'Calls per task', value: c.callsDelta !== null ? `${c.callsDelta < 0 ? '−' : '+'}${Math.abs(c.callsDelta).toFixed(1)}` : '—' },
  ];
  const side = (run: RunComparison['base'], after: boolean) => (
    <section aria-label={after ? 'After' : 'Before'} className={cn('flex flex-col items-center gap-2.5 rounded-[14px] border p-5.5', after && 'border-success/30 bg-success-muted')}>
      <span className={cn('text-[12.5px] font-semibold tracking-wider uppercase', after ? 'text-success' : 'text-muted-foreground')}>
        {after ? 'After' : 'Before'} · run {runLabel(run)}
      </span>
      <ScoreRing score={run.headline} size="xl" />
      <span className="flex items-center gap-1.5 text-muted-foreground">
        overlay v{run.overlayRev ?? '–'} · <ModeBadge mode={run.modes.length === 2 ? 'both' : (run.modes[0] ?? 'tool')} />
      </span>
    </section>
  );
  return (
    <div className="flex flex-col gap-5.5">
      <PageHeader
        title={`${server.data?.name ?? c.base.server.name}: before and after`}
        description={`Same suite v${c.head.suite.version} on the ${c.head.environment.slug} environment. Only the overlay and the mode changed.`}
        actions={
          <Button onClick={() => void copyText(window.location.href).then((ok) => ok && notifySuccess('Link copied'))}>
            <Share2Icon /> {server.data?.publicReport ? 'Share report' : 'Share'}
          </Button>
        }
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_300px_minmax(0,1fr)]">
        {side(c.base, false)}
        <section aria-label="What changed" className="flex flex-col justify-center gap-2.5">
          <div className={cn('text-center text-[40px] font-bold tabular-nums', (c.scoreDelta ?? 0) >= 0 ? 'text-success' : 'text-destructive')}>{c.scoreDelta !== null ? `${formatScoreDelta(c.scoreDelta)} pts` : '—'}</div>
          {deltas.map((d) => (
            <div key={d.label} className="flex flex-col rounded-[10px] border bg-card px-3 py-2.5">
              <span className="text-[12.5px] text-muted-foreground">{d.label}</span>
              <span className="text-[17px] font-semibold tabular-nums">{d.value}</span>
            </div>
          ))}
        </section>
        {side(c.head, true)}
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <section aria-labelledby="flip-title" className="overflow-hidden rounded-xl border bg-card">
          <h2 id="flip-title" className="bg-muted/50 px-4 py-3 text-[15px] font-semibold">
            Flipped to pass ({fixed.length})
          </h2>
          <ul>
            {fixed.map((t) => (
              <li key={t.taskKey} className="flex gap-2.5 border-t px-4 py-2.5">
                <span aria-hidden="true" className="font-bold text-success">
                  ✓
                </span>
                <span className="flex-1">{promptOf.get(t.taskKey) ?? t.taskKey}</span>
                <span className="text-xs text-muted-foreground">{t.category ? CATEGORY_LABEL[t.category] : ''}</span>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="reg-title" className="self-start overflow-hidden rounded-xl border bg-card">
          <h2 id="reg-title" className="bg-muted/50 px-4 py-3 text-[15px] font-semibold">
            Regressed ({regressed.length})
          </h2>
          {regressed.map((t) => (
            <div key={t.taskKey} className="flex flex-col gap-1 border-t px-4 py-3">
              <span>
                <span aria-hidden="true" className="font-bold text-destructive">
                  ✕
                </span>{' '}
                {promptOf.get(t.taskKey) ?? t.taskKey} ({t.base} → {t.head})
              </span>
            </div>
          ))}
          {!regressed.length ? <p className="border-t px-4 py-3 text-[13.5px] text-muted-foreground">No task got worse.</p> : null}
        </section>
      </div>
      <p className="text-[12.5px] text-muted-foreground">
        <Link to="/evals/runs/$runId" params={{ runId: c.head.id }} className="text-primary hover:underline">
          Open run {runLabel(c.head)}
        </Link>{' '}
        for the matrix and remaining fix suggestions.
      </p>
    </div>
  );
}
