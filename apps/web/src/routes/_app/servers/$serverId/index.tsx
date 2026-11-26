import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { PlugIcon } from 'lucide-react';
import { CopyButton } from '@/components/code/copy-button';
import { ErrorState } from '@/components/feedback/states';
import { WriteBadge } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { runsQuery } from '@/features/evals/queries';
import { needGroupsQuery } from '@/features/inbox/queries';
import { callsByModeQuery, overviewQuery } from '@/features/overview/queries';
import { ReadinessCard } from '@/features/readiness/readiness-card';
import { CallsChart, ChartLegend } from '@/features/servers/calls-chart';
import { EnvMiniCard } from '@/features/servers/env-summary';
import { connectQuery, readinessQuery } from '@/features/servers/queries';
import { environmentsQuery } from '@/features/environments/queries';
import { toolsQuery } from '@/features/tools/queries';
import { useMediaQuery } from '@/hooks/use-media-query';
import { formatNumber, formatPercent } from '@/lib/format';

export const Route = createFileRoute('/_app/servers/$serverId/')({
  component: ServerOverview,
});

const DAY = 86_400_000;

/** Server overview tab (prototype Main / MainDark / OverviewMobile). */
function ServerOverview() {
  const { serverId } = Route.useParams();
  const phone = !useMediaQuery('(min-width: 768px)');
  const readiness = useQuery(readinessQuery(serverId));
  const runs = useQuery(runsQuery({ serverId }));
  const envs = useQuery(environmentsQuery(serverId));
  const needs = useQuery(needGroupsQuery({ serverId }));
  const chart = useQuery(callsByModeQuery(serverId));
  const [now] = useState(() => Date.now());
  const metrics = useQuery(overviewQuery({ serverId, from: new Date(now - 14 * DAY).toISOString(), to: new Date(now).toISOString() }));
  const tools = useQuery(toolsQuery(serverId, {}));
  const connectEnv = envs.data?.items.find((e) => e.kind === 'qa') ?? envs.data?.items.find((e) => !e.isMock);
  const connect = useQuery({ ...connectQuery(serverId, connectEnv?.id), enabled: !!connectEnv });
  const writeOf = new Map(tools.data?.items.map((t) => [t.name, t.write]) ?? []);
  const k = metrics.data?.kpis;

  const readinessCard = readiness.isError ? (
    <ErrorState error={readiness.error} onRetry={() => void readiness.refetch()} />
  ) : readiness.data ? (
    <ReadinessCard serverId={serverId} readiness={readiness.data} runs={runs.data?.items} compact={phone} />
  ) : (
    <Skeleton className="h-64 rounded-xl" />
  );

  const callsCard = (
    <section aria-labelledby="calls-title" className="flex flex-col gap-3.5 rounded-xl border bg-card p-5">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <h2 id="calls-title" className="flex-1 text-base font-semibold">
          Calls per day
        </h2>
        <ChartLegend />
        <span className="text-[12.5px] text-muted-foreground">Last 14 days</span>
      </div>
      {chart.isError ? (
        <ErrorState error={chart.error} onRetry={() => void chart.refetch()} />
      ) : chart.data ? (
        chart.data.series.every((s) => s.points.every((p) => !p.v)) ? (
          <div className="flex flex-col items-start gap-2 py-6 text-[13.5px] text-muted-foreground">
            No agent calls yet.
            <Button size="sm" variant="outline" render={<Link to="/connect" search={{ server: serverId }} />} nativeButton={false}>
              <PlugIcon /> Connect a client
            </Button>
          </div>
        ) : (
          <CallsChart data={chart.data} />
        )
      ) : (
        <Skeleton className="h-[170px]" />
      )}
      <div className="grid grid-cols-3 gap-3 border-t pt-3.5">
        {[
          ['Calls (14 d)', formatNumber(k?.calls)],
          ['Task success', formatPercent(k?.taskSuccessRate, 0)],
          ['Error rate', formatPercent(k?.errorRate, 1)],
        ].map(([label, value]) => (
          <div key={label}>
            <div className="text-[12.5px] text-muted-foreground">{label}</div>
            <div className="text-xl font-semibold tabular-nums">{k ? value : <Skeleton className="h-6 w-16" />}</div>
          </div>
        ))}
      </div>
    </section>
  );

  const topTools = (
    <section aria-labelledby="top-title" className="overflow-hidden rounded-xl border bg-card">
      <h2 id="top-title" className="px-5 py-4 text-base font-semibold">
        Top tools
      </h2>
      {metrics.isError ? (
        <div className="px-5 pb-4">
          <ErrorState error={metrics.error} onRetry={() => void metrics.refetch()} />
        </div>
      ) : !metrics.data ? (
        <div className="flex flex-col gap-3 px-5 pb-4" aria-busy="true" aria-label="Loading top tools">
          {[140, 110, 160, 120].map((w) => (
            <div key={w} className="flex gap-4">
              <Skeleton className="h-3" style={{ width: w }} />
              <span className="flex-1" />
              <Skeleton className="h-3 w-[60px]" />
            </div>
          ))}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-medium">Tool</th>
                <th scope="col" className="px-2 py-2 font-medium">Kind</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Calls</th>
                <th scope="col" className="px-5 py-2 text-right font-medium">Errors</th>
              </tr>
            </thead>
            <tbody>
              {metrics.data.topTools.map((t) => (
                <tr key={t.tool} className="border-t">
                  <td className="px-5 py-2.5 font-mono text-[13px]">{t.tool}</td>
                  <td className="px-2 py-2.5">{writeOf.has(t.tool) ? <WriteBadge write={!!writeOf.get(t.tool)} /> : null}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{formatNumber(t.calls)}</td>
                  <td className="px-5 py-2.5 text-right text-muted-foreground tabular-nums">{formatPercent(t.errorRate, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );

  const envCard = (
    <section aria-labelledby="env-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
      <div className="flex items-center">
        <h2 id="env-title" className="flex-1 text-base font-semibold">
          Environments
        </h2>
        <Link to="/servers/$serverId/environments" params={{ serverId }} className="text-[13px] text-primary hover:underline">
          Manage
        </Link>
      </div>
      {envs.data ? envs.data.items.map((e) => <EnvMiniCard key={e.id} env={e} compact={phone} />) : <Skeleton className="h-40" />}
    </section>
  );

  const inbox = (
    <section aria-labelledby="wish-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
      <div className="flex items-center">
        <h2 id="wish-title" className="flex-1 text-base font-semibold">
          What agents wish they could do
        </h2>
        <Link to="/inbox" search={{ server: serverId }} className="text-[13px] text-primary hover:underline">
          Inbox
        </Link>
      </div>
      {needs.data?.items.length === 0 ? <p className="text-[13px] text-muted-foreground">No unmet needs reported.</p> : null}
      {needs.data?.items.slice(0, phone ? 2 : 3).map((g) => (
        <div key={g.id} className="flex items-center gap-2.5 text-[13.5px]">
          <Link to="/inbox/needs/$groupId" params={{ groupId: g.id }} className="min-w-0 flex-1 hover:underline">
            {g.label}
          </Link>
          <span className="rounded-full bg-muted px-2 py-px font-semibold tabular-nums">{g.count}</span>
        </div>
      ))}
    </section>
  );

  const connectCard = (
    <section id="connect" aria-labelledby="conn-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
      <h2 id="conn-title" className="text-base font-semibold">
        Connect an agent
      </h2>
      {connect.data ? (
        <>
          <label htmlFor="mcp-url" className="text-[12.5px] text-muted-foreground">
            MCP endpoint ({connect.data.environment.slug})
          </label>
          <div className="flex gap-1.5">
            <input id="mcp-url" readOnly value={connect.data.mcpUrl} className="h-9 min-w-0 flex-1 rounded-lg border bg-muted/50 px-2.5 font-mono text-xs" />
            <CopyButton value={connect.data.mcpUrl} label="Copy" variant="outline" size="sm" />
          </div>
          <span className="text-[12.5px] text-muted-foreground">
            Claude Code, Cursor and VS Code snippets in{' '}
            <Link to="/connect" search={{ server: serverId }} className="text-primary hover:underline">
              Connect a client
            </Link>
            .
          </span>
        </>
      ) : (
        <Skeleton className="h-16" />
      )}
    </section>
  );

  if (phone) {
    return (
      <div className="flex flex-col gap-4">
        {readinessCard}
        {envCard}
        {inbox}
        {connectCard}
        {callsCard}
        {topTools}
      </div>
    );
  }
  return (
    <div className="grid gap-5 lg:grid-cols-3">
      <div className="flex min-w-0 flex-col gap-5 lg:col-span-2">
        {readinessCard}
        {callsCard}
        {topTools}
      </div>
      <div className="flex min-w-0 flex-col gap-5">
        {envCard}
        {inbox}
        {connectCard}
      </div>
    </div>
  );
}
