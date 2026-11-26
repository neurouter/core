import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { InboxIcon } from 'lucide-react';
import type { NeedGroupRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { ButtonTabs } from '@/components/app/link-tabs';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Segmented } from '@/components/filters/segmented';
import { PageHeader } from '@/components/layout/page-header';
import { rememberedServer } from '@/components/layout/server-switcher';
import { EnvBadge, Pill } from '@/components/status/status';
import { Skeleton } from '@/components/ui/skeleton';
import { ISSUE_STATUS, NEED_STATUS, NeedGroupPanel, Sparkline } from '@/features/inbox/components';
import { inboxSummaryQuery, issuesQuery, needGroupQuery, needGroupsQuery } from '@/features/inbox/queries';
import { useMinWidth } from '@/hooks/use-min-width';
import { formatRelative } from '@/lib/format';
import { cn } from '@/lib/utils';

const search = z.object({
  tab: z.enum(['needs', 'issues']).optional().catch(undefined),
  server: z.string().optional().catch(undefined),
  sort: z.enum(['count', 'recent']).optional().catch(undefined),
  need: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/inbox/')({
  validateSearch: search,
  beforeLoad: guard(['inbox:read']),
  staticData: { crumbs: ['Inbox'] },
  component: InboxPage,
});


/** Ops inbox (spec §9.13, prototype Inbox): unmet needs grouped by intent, and issues. */
function InboxPage() {
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const server = f.server ?? rememberedServer();
  const tab = f.tab ?? 'needs';
  const wide = useMinWidth(1024);
  const summary = useQuery(inboxSummaryQuery(server));
  const needs = useQuery(needGroupsQuery({ ...(server ? { serverId: server } : {}), sort: f.sort ?? 'count' }));
  const issues = useQuery(issuesQuery(server ? { serverId: server } : {}));
  const selected = f.need ?? needs.data?.items[0]?.id;
  return (
    <>
      <PageHeader
        title="What agents wish your API could do"
        description={
          <>
            Reported by agents through <span className="font-mono text-[13px]">neurouter_report_unmet_need</span> and <span className="font-mono text-[13px]">neurouter_report_issue</span>, grouped by intent. Last 30 days.
          </>
        }
      />
      <ButtonTabs
        label="Inbox"
        value={tab}
        onChange={(v) => void navigate({ search: (p) => ({ ...p, tab: v }) })}
        tabs={[
          { value: 'needs', label: 'Unmet needs', count: needs.data?.items.length ?? summary.data?.needs.open },
          { value: 'issues', label: 'Issues', count: issues.data?.items.length ?? summary.data?.issues.open },
        ]}
      />
      {tab === 'needs' ? (
        <div role="tabpanel" id="panel-needs" aria-labelledby="tab-needs" className="flex flex-wrap items-start gap-5">
          <div className="flex min-w-0 flex-[999_1_560px] flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-[13px] text-muted-foreground">Ranked by reports × recency.</span>
              <Segmented label="Sort" size="sm" value={f.sort ?? 'count'} onChange={(v) => void navigate({ search: (p) => ({ ...p, sort: v }) })} options={[{ value: 'count', label: 'Most reports' }, { value: 'recent', label: 'Newest' }]} />
            </div>
            {needs.isError ? <ErrorState error={needs.error} onRetry={() => void needs.refetch()} /> : null}
            {!needs.data && !needs.isError ? <Skeleton className="h-60 rounded-xl" /> : null}
            {needs.data && !needs.data.items.length ? (
              <EmptyState
                icon={InboxIcon}
                title="No unmet needs reported"
                description={
                  <>
                    Agents report them with <code>report_unmet_need</code>. Make sure it is enabled in the server's Ops tools settings.
                  </>
                }
              />
            ) : null}
            {needs.data?.items.length ? (
              <div className="overflow-x-auto rounded-xl border">
                <table className="w-full text-[13.5px]">
                  <caption className="sr-only">Unmet-need groups</caption>
                  <thead>
                    <tr className="bg-muted/50 text-left text-muted-foreground">
                      <th scope="col" className="px-4 py-2 font-medium">Need</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Reports</th>
                      <th scope="col" className="px-2 py-2 text-right font-medium">Keys</th>
                      <th scope="col" className="hidden px-2 py-2 font-medium sm:table-cell">14 days</th>
                      <th scope="col" className="px-2 py-2 font-medium">Last seen</th>
                      <th scope="col" className="px-4 py-2 font-medium">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {needs.data.items.map((g) => (
                      <NeedRowView key={g.id} g={g} selected={wide && g.id === selected} onSelect={() => (wide ? void navigate({ search: (p) => ({ ...p, need: g.id }), replace: true }) : void navigate({ to: '/inbox/needs/$groupId', params: { groupId: g.id } }))} />
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}
          </div>
          {wide && selected ? (
            <aside aria-label="Selected need" className="flex min-w-[300px] flex-[1_1_340px] flex-col rounded-xl border border-brand-border p-4.5">
              <NeedGroupPanel groupId={selected} />
            </aside>
          ) : null}
        </div>
      ) : (
        <div role="tabpanel" id="panel-issues" aria-labelledby="tab-issues">
          {issues.isError ? <ErrorState error={issues.error} onRetry={() => void issues.refetch()} /> : null}
          {issues.data && !issues.data.items.length ? <EmptyState icon={InboxIcon} title="No issues reported" description="Agents file issues with report_issue when a tool is broken or confusing." /> : null}
          {issues.data?.items.length ? (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full text-[13.5px]">
                <caption className="sr-only">Issues reported by agents</caption>
                <thead>
                  <tr className="bg-muted/50 text-left text-muted-foreground">
                    <th scope="col" className="px-4 py-2 font-medium">Problem</th>
                    <th scope="col" className="px-2 py-2 font-medium">Tool</th>
                    <th scope="col" className="px-2 py-2 font-medium">Environment</th>
                    <th scope="col" className="px-2 py-2 font-medium">Failing call</th>
                    <th scope="col" className="px-2 py-2 font-medium">Last update</th>
                    <th scope="col" className="px-4 py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {issues.data.items.map((i) => (
                    <tr key={i.id} className="border-t">
                      <td className="px-4 py-2.5">
                        <Link to="/inbox/issues/$issueId" params={{ issueId: i.id }} className="font-medium hover:underline">
                          {i.problem}
                        </Link>
                      </td>
                      <td className="px-2 py-2.5 font-mono text-[13px]">{i.tool}</td>
                      <td className="px-2 py-2.5">
                        <EnvBadge slug={i.environment.slug} kind={i.environment.kind} />
                      </td>
                      <td className="px-2 py-2.5 text-[13px]">{i.hasFailingCall ? 'attached' : '—'}</td>
                      <td className="px-2 py-2.5 whitespace-nowrap text-muted-foreground">{formatRelative(i.updatedAt)}</td>
                      <td className="px-4 py-2.5">
                        <Pill tone={ISSUE_STATUS[i.status].tone}>{ISSUE_STATUS[i.status].label}</Pill>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}

function NeedRowView({ g, selected, onSelect }: { g: NeedGroupRow; selected: boolean; onSelect: () => void }) {
  const detail = useQuery(needGroupQuery(g.id));
  const last14 = detail.data?.daily.slice(-14).map((d) => d.count);
  return (
    <tr className={cn('cursor-pointer border-t hover:bg-muted/40', selected && 'bg-brand-muted hover:bg-brand-muted')} onClick={onSelect}>
      <td className="px-4 py-3">
        <button type="button" onClick={(e) => (e.stopPropagation(), onSelect())} aria-current={selected ? 'true' : undefined} className="text-left font-medium hover:underline">
          {g.label}
        </button>
      </td>
      <td className="px-2 py-3 text-right font-semibold tabular-nums">{g.count}</td>
      <td className="px-2 py-3 text-right text-muted-foreground tabular-nums">{g.distinctPrincipals}</td>
      <td className="hidden px-2 py-3 sm:table-cell">{last14 ? <Sparkline values={last14} label={`${g.count} reports over 14 days`} /> : null}</td>
      <td className="px-2 py-3 whitespace-nowrap text-muted-foreground">{formatRelative(g.lastSeenAt)}</td>
      <td className="px-4 py-3">
        <Pill tone={NEED_STATUS[g.status].tone}>{NEED_STATUS[g.status].label}</Pill>
      </td>
    </tr>
  );
}
