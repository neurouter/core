import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { RotateCwIcon } from 'lucide-react';
import type { TaskResultRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { ButtonTabs } from '@/components/app/link-tabs';
import { CATEGORY_LABEL, runLabel } from '@/components/app/labels';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { PageHeader } from '@/components/layout/page-header';
import { Pill } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { Skeleton } from '@/components/ui/skeleton';
import { FixSuggestionCard, ModelModeMatrix } from '@/features/evals/components';
import { runQuery, runsQuery, suitesQuery, suggestionsQuery, useCancelRun, useCreateRun } from '@/features/evals/queries';
import { ModeRecommendation } from '@/features/readiness/mode-recommendation';
import { ScoreBreakdown, ScoreDelta, ScoreRing } from '@/features/readiness/score-ring';
import { notifyError } from '@/lib/notify';
import { cn } from '@/lib/utils';

const search = z.object({ tab: z.enum(['summary', 'tasks', 'fixes']).optional().catch(undefined) });

export const Route = createFileRoute('/_app/evals/runs/$runId')({
  validateSearch: search,
  beforeLoad: guard(['evals:read']),
  component: RunPage,
});

const CAUSE = { wrong_tool: 'wrong tool', bad_arguments: 'bad arguments', missing_capability: 'missing capability', gave_up: 'gave up', hallucinated: 'hallucinated', policy_blocked: 'policy blocked', no_framing: 'no framing', over_budget: 'over budget', error: 'error', provider_refusal: 'provider refusal' } as const;

/** Eval run detail (spec §9.14, prototype EvalRun): score, matrix, breakdown, task results, fixes. */
function RunPage() {
  const { runId } = Route.useParams();
  const { tab = 'summary' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const run = useQuery(runQuery(runId));
  const serverId = run.data?.server.id ?? '';
  const runs = useQuery({ ...runsQuery({ serverId }), enabled: !!serverId });
  const suites = useQuery({ ...suitesQuery(serverId), enabled: !!serverId });
  const fixes = useQuery({ ...suggestionsQuery(runId), enabled: !!run.data });
  const cancel = useCancelRun();
  const rerun = useCreateRun();
  useSetCrumbs([{ label: 'Evals', to: '/evals' }, { label: `Run ${runLabel(runId)}` }]);
  if (run.isPending) return <PageSkeleton />;
  if (run.isError) return <ErrorState error={run.error} onRetry={() => void run.refetch()} />;
  const r = run.data;
  const suite = suites.data?.items.find((s) => s.id === r.suite.id);
  const bc = suite?.byCategory;
  const done = r.status === 'succeeded' && r.score;
  const base = r.baseRunId ? runs.data?.items.find((x) => x.id === r.baseRunId) : undefined;
  const later = runs.data?.items.find((x) => x.status === 'succeeded' && Date.parse(x.createdAt) > Date.parse(r.createdAt));
  const facts = [
    r.server.name,
    `suite v${r.suite.version}${suite ? ` (${suite.status === 'frozen' ? 'frozen, ' : ''}${suite.taskCount} tasks${bc ? `: ${bc.single} single · ${bc.multi} multi-step · ${bc.ambiguous} ambiguous · ${bc.impossible} impossible` : ''})` : ''}`,
    `target ${r.environment.slug}`,
    r.overlayRev ? `overlay v${r.overlayRev}${r.temporaryBuild ? ' (temporary)' : ''}` : null,
    `${r.models.length} ${r.models.length === 1 ? 'model' : 'models'}`,
    r.modes.join(' + '),
    `N = ${r.repeats}`,
  ].filter(Boolean);
  const visible = fixes.data?.items.filter((s) => s.cause !== 'missing_capability') ?? [];
  const missing = fixes.data?.items.filter((s) => s.cause === 'missing_capability') ?? [];
  return (
    <div className="flex flex-col gap-4.5">
      <PageHeader
        title={`Run ${runLabel(r)}${!base ? ' · baseline' : ''}`}
        description={facts.join(' · ')}
        actions={
          <>
            {r.status === 'running' || r.status === 'queued' ? (
              <GatedButton cap="evals:run" variant="outline" onClick={() => cancel.mutate(r.id)}>
                Cancel run
              </GatedButton>
            ) : null}
            {later && done ? (
              <Button variant="outline" render={<Link to="/evals/compare" search={{ base: r.id, head: later.id }} />} nativeButton={false}>
                Compare with run {runLabel(later)}
              </Button>
            ) : base && done ? (
              <Button variant="outline" render={<Link to="/evals/compare" search={{ base: base.id, head: r.id }} />} nativeButton={false}>
                Compare with run {runLabel(base)}
              </Button>
            ) : null}
            <GatedButton cap="evals:run" variant="outline" disabled={rerun.isPending || r.status === 'running'} onClick={() => rerun.mutate({ serverId, environmentId: r.environment.id, suiteId: r.suite.id, models: r.models, modes: r.modes, repeats: r.repeats }, { onSuccess: (n) => void navigate({ to: '/evals/runs/$runId', params: { runId: n.id } }), onError: (e) => notifyError(e) })}>
              <RotateCwIcon /> Re-run
            </GatedButton>
          </>
        }
      />
      <ButtonTabs
        label="Run sections"
        value={tab}
        onChange={(v) => void navigate({ search: { tab: v }, replace: true })}
        tabs={[
          { value: 'summary', label: 'Summary' },
          { value: 'tasks', label: 'Tasks', count: r.tasks.length || undefined },
          { value: 'fixes', label: 'Fix suggestions', count: r.suggestionsCount || undefined },
        ]}
      />
      {r.status === 'failed' ? <ErrorState error={new Error(r.error ?? 'The run failed')} onRetry={() => rerun.mutate({ serverId, environmentId: r.environment.id })} /> : null}
      {r.status === 'running' || r.status === 'queued' ? (
        <section aria-live="polite" className="flex flex-wrap items-center gap-6 rounded-xl border bg-card p-5">
          <ScoreRing progress={r.progress.done / Math.max(1, r.progress.total)} progressLabel={`${r.progress.done} / ${r.progress.total}`} size="lg" />
          <div className="flex min-w-60 flex-1 flex-col gap-2">
            <span className="text-base font-semibold">Running…</span>
            <span className="text-muted-foreground">
              {r.progress.done} of {r.progress.total} task runs done. Results appear as cells finish.
            </span>
            <Progress value={(r.progress.done / Math.max(1, r.progress.total)) * 100} aria-label="Run progress" />
          </div>
        </section>
      ) : null}
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex flex-col gap-4.5">
        {tab === 'summary' && done ? (
          <>
            <div className="flex flex-wrap items-stretch gap-5">
              <section aria-label="Score" className="flex flex-[0_1_220px] flex-col items-center gap-2 rounded-xl border bg-card p-4.5">
                <ScoreRing score={r.score!.headline} size="lg" />
                {base?.headline != null ? <ScoreDelta delta={r.score!.headline - base.headline} suffix={`vs run ${runLabel(base)}`} /> : null}
                <span className="text-center text-[12.5px] text-muted-foreground">Best mode per model counts toward the score</span>
              </section>
              <section aria-labelledby="mx-title" className="min-w-0 flex-[999_1_560px] overflow-hidden rounded-xl border bg-card">
                <h2 id="mx-title" className="px-4.5 py-3.5 text-base font-semibold">
                  Task success by model and mode
                </h2>
                <ModelModeMatrix cells={r.matrix} />
              </section>
            </div>
            <ModeRecommendation mode={r.score!.recommendedMode} text={r.score!.recommendation} />
            <section aria-labelledby="bd-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
              <h2 id="bd-title" className="text-base font-semibold">
                Score breakdown
              </h2>
              <ScoreBreakdown items={r.score!.breakdown} />
            </section>
            <FixesSection serverId={serverId} visible={visible.slice(0, 4)} missing={missing} more={visible.length > 4 ? visible.length - 4 : 0} onMore={() => void navigate({ search: { tab: 'fixes' } })} />
          </>
        ) : null}
        {tab === 'summary' && !done && r.status === 'succeeded' ? <Skeleton className="h-40" /> : null}
        {tab === 'tasks' ? <TaskResults rows={r.tasks} runId={r.id} /> : null}
        {tab === 'fixes' ? <FixesSection serverId={serverId} visible={visible} missing={missing} more={0} /> : null}
      </div>
    </div>
  );
}

function FixesSection({ serverId, visible, missing, more, onMore }: { serverId: string; visible: Parameters<typeof FixSuggestionCard>[0]['s'][]; missing: Parameters<typeof FixSuggestionCard>[0]['s'][]; more: number; onMore?: () => void }) {
  return (
    <section aria-labelledby="fix-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline gap-2.5">
        <h2 id="fix-title" className="text-base font-semibold">
          Fix suggestions
        </h2>
        <span className="text-[13px] text-muted-foreground">Failures clustered by cause; each fix is re-run before it is called verified.</span>
      </div>
      {!visible.length && !missing.length ? <p className="text-[13.5px] text-muted-foreground">No suggestions for this run.</p> : null}
      <div className="grid gap-3.5 md:grid-cols-2">
        {visible.map((s) => (
          <FixSuggestionCard key={s.id} s={s} serverId={serverId} />
        ))}
      </div>
      {more ? (
        <Button variant="ghost" className="self-start" onClick={onMore}>
          {more} more suggestions
        </Button>
      ) : null}
      {missing.map((s) => (
        <div key={s.id} className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-brand-border px-4 py-3.5">
          <span className="font-semibold">Missing capability: {s.tools[0] ?? 'new tool'}</span>
          <span className="flex-1 text-[13px] text-muted-foreground">{s.rationale}</span>
          <Link to="/inbox" search={{ server: serverId }} className="text-[13px] text-primary hover:underline">
            Open in inbox
          </Link>
        </div>
      ))}
    </section>
  );
}

function TaskResults({ rows, runId }: { rows: TaskResultRow[]; runId: string }) {
  if (!rows.length) return <p className="text-[13.5px] text-muted-foreground">Task results appear when the run finishes.</p>;
  const cols = rows[0]!.cells.map((c) => `${c.model}|${c.mode}`);
  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[720px] text-[13px]">
        <caption className="sr-only">Passes per task, model and mode (n of N)</caption>
        <thead>
          <tr className="bg-muted/50 text-left text-muted-foreground">
            <th scope="col" className="px-4 py-2 font-medium">Task</th>
            <th scope="col" className="px-2 py-2 font-medium">Category</th>
            {cols.map((c) => {
              const [m, mode] = c.split('|');
              return (
                <th key={c} scope="col" className="px-2 py-2 text-center font-medium">
                  <span className="font-mono">{m}</span>
                  <span className={cn('block text-xs', mode === 'code' ? 'text-mode-code' : 'text-mode-tool')}>{mode}</span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((t) => (
            <tr key={t.taskId} className="border-t">
              <th scope="row" className="max-w-sm px-4 py-2 text-left font-normal">
                {t.prompt}
              </th>
              <td className="px-2 py-2 text-muted-foreground">{CATEGORY_LABEL[t.category]}</td>
              {t.cells.map((c) => (
                <td key={`${c.model}|${c.mode}`} className="px-2 py-2 text-center">
                  <span className={cn('font-semibold tabular-nums', c.passes === c.attempts ? 'text-success' : c.passes === 0 ? 'text-destructive' : 'text-warning')} title={c.failureCause ? CAUSE[c.failureCause] : undefined}>
                    {c.passes}/{c.attempts}
                  </span>
                  {c.flaky ? <Pill tone="warn" className="ml-1">flaky</Pill> : null}
                  {c.failureCause && c.passes < c.attempts ? <span className="block text-xs text-muted-foreground">{CAUSE[c.failureCause]}</span> : null}
                  <AttemptTraces runs={c.runs} task={t.key} model={c.model} mode={c.mode} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-4 py-2 text-xs text-muted-foreground">
        Each attempt links to its trace (run {runLabel(runId)}). Eval traffic never reaches the inbox, usage or analytics.
      </p>
    </div>
  );
}

const TRACE_NOTE = { none: 'no trace', expired: 'expired' } as const;
const TRACE_TITLE = { none: 'No trace was recorded: the agent made no tool call in this attempt.', expired: 'The trace was removed by the retention policy.' } as const;

/** One link per attempt to its task trace (tasks/$taskId), or why there is none. */
function AttemptTraces({ runs, task, model, mode }: { runs: TaskResultRow['cells'][number]['runs']; task: string; model: string; mode: string }) {
  if (!runs.length) return null;
  const single = runs.length === 1;
  return (
    <ul aria-label={`Attempt traces for ${task}, ${model} ${mode}`} className="mt-1 flex flex-wrap justify-center gap-x-2 gap-y-0.5 text-xs">
      {runs.map((a) => {
        const label = single ? 'trace' : `#${a.attempt}`;
        const outcome = a.passed ? 'passed' : 'failed';
        const why = a.trace === 'expired' ? 'expired' : 'none';
        return (
          <li key={a.attempt}>
            {a.trace === 'recorded' && a.taskId ? (
              <Link to="/tasks/$taskId" params={{ taskId: a.taskId }} className={cn('hover:underline', a.passed ? 'text-primary' : 'text-destructive')} aria-label={`Trace of attempt ${a.attempt} (${outcome})`}>
                {label}
              </Link>
            ) : (
              <span className="text-muted-foreground" title={TRACE_TITLE[why]}>
                {single ? '' : `${label} `}
                {TRACE_NOTE[why]}
                <span className="sr-only"> (attempt {a.attempt} {outcome}: {TRACE_TITLE[why]})</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
