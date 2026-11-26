import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { CircleIcon, ListTreeIcon } from 'lucide-react';
import type { TaskRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { Toolbar } from '@/components/layout/section';
import { PageHeader } from '@/components/layout/page-header';
import { rememberedServer } from '@/components/layout/server-switcher';
import { EnvBadge, OutcomeBadge } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { tasksQuery } from '@/features/tasks/queries';
import { compactDuration } from '@/features/tasks/timeline';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { formatDateTime, formatRelative } from '@/lib/format';

const search = z.object({
  server: z.string().optional().catch(undefined),
  env: z.string().optional().catch(undefined),
  outcome: z.enum(['success', 'partial', 'failure', 'abandoned', 'inferred']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  range: z.enum(['24h', '7d', '14d', '30d']).optional().catch(undefined),
  scripts: z.boolean().optional().catch(undefined),
  evals: z.boolean().optional().catch(undefined),
  live: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/tasks/')({
  validateSearch: search,
  beforeLoad: guard(['tasks:read']),
  staticData: { crumbs: ['Tasks'] },
  component: TasksPage,
});

const RANGE_MS = { '24h': 86_400_000, '7d': 7 * 86_400_000, '14d': 14 * 86_400_000, '30d': 30 * 86_400_000 } as const;

/** Tasks explorer (spec §9.11): traces grouped as tasks. */
function TasksPage() {
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const server = f.server ?? rememberedServer();
  const range = f.range ?? '7d';
  const filterKey = JSON.stringify({ ...f, server });
  const cursors = useCursorStack(filterKey);
  const [now] = useState(() => Date.now());
  const from = new Date(Math.floor((now - RANGE_MS[range]) / 60_000) * 60_000).toISOString();
  const query = useQuery(
    tasksQuery(
      { ...(server ? { serverId: server } : {}), ...(f.outcome ? { outcome: [f.outcome] } : {}), ...(f.q ? { q: f.q } : {}), ...(f.evals ? { origin: 'eval' as const } : {}), from, ...(cursors.cursor ? { cursor: cursors.cursor } : {}) },
      !!f.live,
    ),
  );
  const rows = f.scripts ? query.data?.items.filter((t) => t.scriptCount > 0) : query.data?.items;
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const filtered = !!(f.outcome || f.q || f.scripts || f.evals);
  const columns: ColumnSpec<TaskRow>[] = [
    { id: 'started', header: 'Started', priority: 2, cell: (t) => <span className="text-[13px] whitespace-nowrap text-muted-foreground" title={formatDateTime(t.startedAt)}>{formatRelative(t.startedAt)}</span> },
    {
      id: 'goal',
      header: 'Goal',
      priority: 1,
      cell: (t) => (
        <Link to="/tasks/$taskId" params={{ taskId: t.id }} className="block max-w-md truncate hover:underline">
          {t.goal ?? <span className="text-muted-foreground italic">Inferred: {t.inferredLabel?.goal ?? `${t.callCount} calls`}</span>}
        </Link>
      ),
    },
    { id: 'outcome', header: 'Outcome', priority: 1, cell: (t) => <OutcomeBadge outcome={t.outcome} status={t.status} framing={t.framing} /> },
    { id: 'agent', header: 'Agent', priority: 2, cell: (t) => <span className="text-[13px] whitespace-nowrap"><span className="font-mono">{t.principal.name}</span> <span className="text-muted-foreground">· {t.client.name ?? 'unknown'}</span></span> },
    { id: 'env', header: 'Environment', cell: (t) => <EnvBadge slug={t.environment.slug} kind={t.environment.kind} /> },
    { id: 'calls', header: 'Calls', align: 'right', cell: (t) => <span className="tabular-nums">{t.callCount}</span> },
    { id: 'scripts', header: 'Scripts', align: 'right', cell: (t) => <span className="tabular-nums">{t.scriptCount || ''}</span> },
    { id: 'errors', header: 'Errors', align: 'right', cell: (t) => <span className={t.errorCount ? 'text-destructive tabular-nums' : 'text-muted-foreground tabular-nums'}>{t.errorCount}</span> },
    { id: 'decisions', header: 'Decisions', align: 'right', cell: (t) => <span className="text-muted-foreground tabular-nums">{t.decisionCount || ''}</span> },
    { id: 'duration', header: 'Duration', align: 'right', cell: (t) => <span className="text-muted-foreground tabular-nums">{t.status === 'open' ? 'running' : compactDuration(t.durationMs)}</span> },
  ];
  return (
    <>
      <PageHeader title="Tasks" description="What agents did, grouped as tasks: framed by begin_task / end_task, a code-mode script, or inferred from a burst of calls." />
      <Toolbar>
        <SearchInput label="Search goals or task ids" placeholder="Search goals, task ids" value={f.q} onChange={(q) => set({ q })} className="w-60" />
        <Segmented
          label="Outcome"
          size="sm"
          value={f.outcome ?? 'all'}
          onChange={(v) => set({ outcome: v === 'all' ? undefined : v })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'success', label: 'Success' },
            { value: 'partial', label: 'Partial' },
            { value: 'failure', label: 'Failure' },
            { value: 'inferred', label: 'Inferred' },
          ]}
        />
        <Segmented label="Time range" size="sm" value={range} onChange={(v) => set({ range: v })} options={[{ value: '24h', label: '24 h' }, { value: '7d', label: '7 d' }, { value: '14d', label: '14 d' }, { value: '30d', label: '30 d' }]} />
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <Switch size="sm" checked={!!f.scripts} onCheckedChange={(v) => set({ scripts: v || undefined })} /> Has script
        </label>
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <Switch size="sm" checked={!!f.evals} onCheckedChange={(v) => set({ evals: v || undefined })} /> Eval traffic
        </label>
        <span className="flex-1" />
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <Switch size="sm" checked={!!f.live} onCheckedChange={(v) => set({ live: v || undefined })} />
          {f.live ? <CircleIcon aria-hidden="true" className="size-2 animate-pulse fill-success text-success" /> : null} Live
        </label>
      </Toolbar>
      <DataTable
        label="Tasks"
        columns={columns}
        rows={rows}
        loading={query.isPending}
        error={query.error}
        onRetry={() => void query.refetch()}
        getRowId={(t) => t.id}
        onRowClick={(t) => void navigate({ to: '/tasks/$taskId', params: { taskId: t.id } })}
        empty={
          filtered ? (
            <EmptyState icon={ListTreeIcon} title="No tasks match" action={<Button variant="outline" onClick={() => void navigate({ search: {} })}>Clear filters</Button>} />
          ) : (
            <EmptyState icon={ListTreeIcon} title="No tasks yet" description="Connect a client to start sending traffic." action={<Link to="/connect" className="font-medium text-primary hover:underline">Connect a client</Link>} />
          )
        }
      />
      <CursorPager page={cursors.page} hasPrev={cursors.hasPrev} hasNext={!!query.data?.nextCursor} onPrev={cursors.prev} onNext={() => query.data?.nextCursor && cursors.next(query.data.nextCursor)} />
    </>
  );
}
