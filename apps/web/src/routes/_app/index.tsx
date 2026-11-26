import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ClipboardPasteIcon, FileUpIcon, LinkIcon, SparklesIcon } from 'lucide-react';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { runLabel } from '@/components/app/labels';
import { KpiCard, computeDelta } from '@/components/charts/kpi-card';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { EnvBadge, HealthDot, OutcomeBadge, SpecKindBadge } from '@/components/status/status';
import { Skeleton } from '@/components/ui/skeleton';
import { runsQuery } from '@/features/evals/queries';
import { inboxSummaryQuery, issuesQuery, needGroupsQuery } from '@/features/inbox/queries';
import { overviewQuery } from '@/features/overview/queries';
import { ScoreBadge } from '@/features/readiness/score-ring';
import { serversQuery } from '@/features/servers/queries';
import { useMe } from '@/hooks/use-me';
import { formatNumber, formatPercent, formatRelative } from '@/lib/format';
import { can } from '@/lib/permissions';

export const Route = createFileRoute('/_app/')({
  beforeLoad: guard(['servers:read']),
  staticData: { crumbs: ['Overview'] },
  component: OverviewPage,
});

const WEEK = 7 * 86_400_000;

function OverviewPage() {
  const servers = useQuery(serversQuery());
  if (servers.isPending) return <PageSkeleton />;
  if (servers.isError) return <ErrorState error={servers.error} onRetry={() => void servers.refetch()} />;
  if (!servers.data.items.length) return <EmptyOverview />;
  return <Dashboard />;
}

/** No servers: "Import your first API" hero (spec §9.1). */
function EmptyOverview() {
  const me = useMe();
  const admin = can(me, 'servers:write');
  return (
    <>
      <PageHeader title="Overview" />
      <section aria-labelledby="hero-title" className="flex flex-col gap-5 rounded-xl border bg-brand-muted p-6 md:p-8">
        <div className="flex flex-col gap-1">
          <h2 id="hero-title" className="text-xl font-semibold">
            Import your first API
          </h2>
          <p className="max-w-2xl text-muted-foreground">Point Neurouter at an OpenAPI 3.x or GraphQL spec. You get a governed MCP server and a readiness score in a few minutes.</p>
        </div>
        {admin ? (
          <div className="grid gap-3 md:grid-cols-3">
            {[
              { icon: LinkIcon, title: 'Paste a URL', text: 'Fetch an openapi.yaml or a GraphQL endpoint.', search: { tab: 'url' as const } },
              { icon: FileUpIcon, title: 'Upload a file', text: '.yaml, .json, .graphql up to 10 MB.', search: { tab: 'upload' as const } },
              { icon: SparklesIcon, title: 'Try the sample', text: 'Acme Orders API (fictional), 46 operations.', search: { tab: 'url' as const, sample: '1' } },
            ].map((t) => (
              <Link key={t.title} to="/servers/new" search={t.search} className="flex flex-col gap-1 rounded-xl border bg-card p-4 outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring">
                <t.icon aria-hidden="true" className="size-5 text-primary" />
                <span className="font-semibold">{t.title}</span>
                <span className="text-[13px] text-muted-foreground">{t.text}</span>
              </Link>
            ))}
          </div>
        ) : (
          <p className="text-[13.5px]">Ask an admin to import a spec.</p>
        )}
      </section>
      <ol className="grid gap-3 md:grid-cols-3" aria-label="How it works">
        {[
          ['1', 'Import', 'The spec becomes a curated set of MCP tools. Writes stay off until you enable them.'],
          ['2', 'Connect', 'Create a key for one environment and add the server to Claude Code, Cursor or VS Code.'],
          ['3', 'Measure', 'Run an eval: generated tasks × models × tool and code mode give a 0–100 score.'],
        ].map(([n, title, text]) => (
          <li key={n} className="flex gap-3 rounded-xl border bg-card p-4">
            <span aria-hidden="true" className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {n}
            </span>
            <span className="flex flex-col gap-0.5">
              <span className="font-semibold">{title}</span>
              <span className="text-[13px] text-muted-foreground">{text}</span>
            </span>
          </li>
        ))}
      </ol>
    </>
  );
}

function Dashboard() {
  const me = useMe();
  const [now] = useState(() => Date.now());
  const range = { from: new Date(now - WEEK).toISOString(), to: new Date(now).toISOString() };
  const overview = useQuery(overviewQuery(range));
  const servers = useQuery(serversQuery());
  const needs = useQuery(needGroupsQuery({ status: undefined }));
  const issues = useQuery(issuesQuery({ status: 'open' }));
  const inbox = useQuery(inboxSummaryQuery());
  const runs = useQuery(runsQuery());
  const k = overview.data?.kpis;
  const prev = overview.data?.previous;
  return (
    <>
      <PageHeader
        title="Overview"
        description={`${me.instance.name} · last 7 days`}
        actions={
          <GatedButton cap="servers:write" demoOp="specs.preview" render={<Link to="/servers/new" />} nativeButton={false}>
            <FileUpIcon /> Import a spec
          </GatedButton>
        }
      />
      {overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <KpiCard label="Tasks" loading={!k} value={formatNumber(k?.tasks)} delta={k && prev ? computeDelta(k.tasks, prev.tasks, 'neutral') : null} vs="previous 7 days" />
          <KpiCard label="Task success" loading={!k} value={formatPercent(k?.taskSuccessRate, 0)} delta={k && prev ? computeDelta(k.taskSuccessRate, prev.taskSuccessRate, 'higher-is-better', 'rate') : null} vs="previous 7 days" />
          <KpiCard label="Tool calls" loading={!k} value={formatNumber(k?.calls)} delta={k && prev ? computeDelta(k.calls, prev.calls, 'neutral') : null} vs="previous 7 days" />
          <KpiCard label="Error rate" loading={!k} value={formatPercent(k?.errorRate, 1)} delta={k && prev ? computeDelta(k.errorRate, prev.errorRate, 'lower-is-better', 'rate') : null} vs="previous 7 days" />
          <KpiCard label="Open inbox items" loading={!inbox.data} value={formatNumber(inbox.data ? inbox.data.needs.open + inbox.data.issues.open : undefined)} className="col-span-2 md:col-span-1" />
        </div>
      )}

      <section aria-labelledby="servers-title" className="flex flex-col gap-3">
        <div className="flex items-center">
          <h2 id="servers-title" className="flex-1 text-base font-semibold">
            Servers
          </h2>
          <Link to="/servers" className="text-[13px] text-primary hover:underline">
            All servers
          </Link>
        </div>
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {servers.data?.items.map((s) => (
            <Link key={s.id} to="/servers/$serverId" params={{ serverId: s.id }} className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 outline-none hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring">
              <div className="flex items-start gap-2">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate font-semibold">{s.name}</span>
                  {s.specFormat ? <SpecKindBadge format={s.specFormat} /> : null}
                </div>
                <ScoreBadge score={s.readiness?.score} preliminary={s.readiness?.confidence === 'preliminary'} />
              </div>
              <div className="flex flex-wrap gap-1.5">
                {s.environments.map((e) => (
                  <span key={e.id} className="inline-flex items-center gap-1">
                    <HealthDot status={e.health} />
                    <EnvBadge slug={e.slug} kind={e.isMock ? 'mock' : e.kind} />
                  </span>
                ))}
              </div>
              <span className="text-[12.5px] text-muted-foreground">
                {s.visibleToolCount} of {s.toolCount} tools exposed · {s.writeToolCount} write
              </span>
            </Link>
          ))}
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-2 [&>*]:min-w-0">
        <section aria-labelledby="attention-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 md:p-5">
          <div className="flex items-center">
            <h2 id="attention-title" className="flex-1 text-base font-semibold">
              Needs attention
            </h2>
            <Link to="/inbox" className="text-[13px] text-primary hover:underline">
              Inbox
            </Link>
          </div>
          {!needs.data ? (
            <Skeleton className="h-24" />
          ) : (
            <ul className="flex flex-col divide-y">
              {needs.data.items
                .filter((g) => g.status === 'open' || g.status === 'planned')
                .slice(0, 3)
                .map((g) => (
                  <li key={g.id} className="flex items-center gap-2.5 py-2 text-[13.5px]">
                    <Link to="/inbox/needs/$groupId" params={{ groupId: g.id }} className="min-w-0 flex-1 truncate hover:underline">
                      {g.label}
                    </Link>
                    <span className="rounded-full bg-muted px-2 py-px font-semibold tabular-nums" aria-label={`${g.count} reports`}>
                      {g.count}
                    </span>
                  </li>
                ))}
              {issues.data?.items.slice(0, 2).map((i) => (
                <li key={i.id} className="flex items-center gap-2.5 py-2 text-[13.5px]">
                  <span className="rounded-full bg-warning-muted px-2 py-px text-xs font-medium text-warning">Issue</span>
                  <Link to="/inbox/issues/$issueId" params={{ issueId: i.id }} className="min-w-0 flex-1 truncate hover:underline">
                    {i.problem}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section aria-labelledby="recent-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 md:p-5">
          <div className="flex items-center">
            <h2 id="recent-title" className="flex-1 text-base font-semibold">
              Recent tasks
            </h2>
            <Link to="/tasks" className="text-[13px] text-primary hover:underline">
              All tasks
            </Link>
          </div>
          {!overview.data ? (
            <Skeleton className="h-24" />
          ) : (
            <ul className="flex flex-col divide-y">
              {overview.data.recentTasks.map((t) => (
                <li key={t.id} className="flex items-center gap-2.5 py-2 text-[13.5px]">
                  <Link to="/tasks/$taskId" params={{ taskId: t.id }} className={`min-w-0 flex-1 truncate hover:underline ${t.goal ? '' : 'text-muted-foreground italic'}`}>
                    {t.goal ?? t.inferredLabel?.goal ?? 'Inferred task'}
                  </Link>
                  <OutcomeBadge outcome={t.outcome} status={t.status} framing={t.framing} />
                  <span className="hidden text-xs text-muted-foreground sm:inline">{formatRelative(t.startedAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="runs-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4 md:p-5">
        <div className="flex items-center">
          <h2 id="runs-title" className="flex-1 text-base font-semibold">
            Latest eval runs
          </h2>
          <Link to="/evals" className="text-[13px] text-primary hover:underline">
            All runs
          </Link>
        </div>
        <ul className="flex flex-col divide-y">
          {runs.data?.items.slice(0, 3).map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-2.5 py-2 text-[13.5px]">
              <Link to="/evals/runs/$runId" params={{ runId: r.id }} className="font-medium hover:underline">
                Run {runLabel(r)}
              </Link>
              <span className="text-muted-foreground">{r.server.name}</span>
              <span className="flex-1" />
              {r.status === 'running' ? <span className="text-xs text-muted-foreground">running {Math.round((r.progress.done / Math.max(1, r.progress.total)) * 100)}%</span> : <ScoreBadge score={r.headline} />}
              <span className="text-xs text-muted-foreground">{formatRelative(r.endedAt ?? r.createdAt)}</span>
            </li>
          ))}
        </ul>
      </section>
      <p className="text-xs text-muted-foreground">
        <ClipboardPasteIcon aria-hidden="true" className="mr-1 inline size-3" />
        Counts cover the local retention window (30 days).
      </p>
    </>
  );
}
