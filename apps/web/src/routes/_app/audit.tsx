import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { DownloadIcon, FileTextIcon, ShieldCheckIcon } from 'lucide-react';
import type { AuditDecision, AuditRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { JsonViewer } from '@/components/code/json-viewer';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { CursorPager } from '@/components/data-table/cursor-pager';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { Toolbar } from '@/components/layout/section';
import { PageHeader } from '@/components/layout/page-header';
import { rememberedServer } from '@/components/layout/server-switcher';
import { AuditStatusText, DecisionBadge, EnvBadge, ModeBadge } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { auditEventQuery, auditQuery, useVerifyAudit } from '@/features/audit/queries';
import { environmentsQuery } from '@/features/environments/queries';
import { PolicyTrail } from '@/features/tasks/components';
import { useCursorStack } from '@/hooks/use-cursor-stack';
import { auditExportUrl } from '@/lib/download';
import { formatDateTime, formatDuration, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const DECISIONS = ['blocked', 'allowed', 'dry_run', 'confirmed'] as const;
const search = z.object({
  server: z.string().optional().catch(undefined),
  env: z.string().optional().catch(undefined),
  decision: z.enum(DECISIONS).optional().catch(undefined),
  source: z.enum(['agents', 'console']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  event: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/audit')({
  validateSearch: search,
  beforeLoad: guard(['audit:read']),
  staticData: { crumbs: ['Audit log'] },
  component: AuditPage,
});

const BLOCKED: AuditDecision[] = ['denied_acl', 'denied_policy', 'denied_rate_limit', 'denied_read_only', 'denied_disabled', 'denied_confirmation'];

/** Audit log (spec §9.15, adapted from Hub): every call and console action, with export and verify. */
function AuditPage() {
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const server = f.server ?? rememberedServer();
  const envs = useQuery({ ...environmentsQuery(server ?? ''), enabled: !!server });
  const decision = f.decision === 'blocked' ? BLOCKED : f.decision ? [f.decision] : undefined;
  const filters = { ...(server ? { serverId: server } : {}), ...(f.env ? { environmentId: f.env } : {}), ...(decision ? { decision } : {}), ...(f.source === 'console' ? { via: 'console' as const } : {}), ...(f.source === 'agents' ? { kind: ['tool_call', 'script_run', 'ops_call'] } : {}), ...(f.q ? { q: f.q } : {}) };
  const cursors = useCursorStack(JSON.stringify(filters));
  const list = useQuery(auditQuery({ ...filters, ...(cursors.cursor ? { cursor: cursors.cursor } : {}) }));
  const verify = useVerifyAudit();
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const columns: ColumnSpec<AuditRow>[] = [
    { id: 'ts', header: 'Time', priority: 2, cell: (r) => <span className="text-[13px] whitespace-nowrap text-muted-foreground" title={formatDateTime(r.ts)}>{formatRelative(r.ts)}</span> },
    { id: 'actor', header: 'Actor', priority: 1, cell: (r) => <span className="text-[13px] whitespace-nowrap"><span className="font-mono">{r.principal?.name ?? 'system'}</span>{r.client?.name ? <span className="text-muted-foreground"> · {r.client.name}</span> : null}</span> },
    { id: 'server', header: 'Server', cell: (r) => <span className="text-[13px]">{r.server?.name ?? '—'}</span> },
    { id: 'env', header: 'Env', cell: (r) => (r.environment ? <EnvBadge slug={r.environment.slug} kind={r.environment.kind} /> : null) },
    { id: 'tool', header: 'Tool or action', priority: 1, cell: (r) => <span className="font-mono text-[13px]">{r.tool ?? r.action ?? r.kind}</span> },
    { id: 'mode', header: 'Mode', cell: (r) => (r.mode ? <ModeBadge mode={r.mode} /> : r.via === 'console' ? <span className="text-xs text-muted-foreground">console</span> : null) },
    { id: 'decision', header: 'Decision', priority: 2, cell: (r) => <DecisionBadge decision={r.decision} /> },
    { id: 'status', header: 'Status', cell: (r) => <AuditStatusText status={r.status} /> },
    { id: 'latency', header: 'Latency', align: 'right', cell: (r) => <span className="text-muted-foreground tabular-nums">{formatDuration(r.latencyMs)}</span> },
    {
      id: 'task',
      header: 'Task',
      cell: (r) =>
        r.taskId ? (
          <Link to="/tasks/$taskId" params={{ taskId: r.taskId }} className="text-[13px] text-primary hover:underline" onClick={(e) => e.stopPropagation()}>
            task
          </Link>
        ) : null,
    },
  ];
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every tool call, script and console action, hash-chained."
        actions={
          <>
            <GatedButton cap="audit:read" demoOp="audit.verify" variant="outline" disabled={verify.isPending} onClick={() => verify.mutate(undefined, { onSuccess: (r) => (r.ok ? notifySuccess('Hash chain verified', `${r.checked.toLocaleString()} records, ${r.checkpointsVerified} checkpoints`) : notifyError(new Error(r.reason ?? `Broken at seq ${r.firstBrokenSeq}`), 'Chain broken')), onError: (e) => notifyError(e) })}>
              <ShieldCheckIcon /> Verify chain
            </GatedButton>
            <Button variant="outline" render={<a href={auditExportUrl(filters, 'csv')} download />} nativeButton={false}>
              <DownloadIcon /> CSV
            </Button>
            <Button variant="outline" render={<a href={auditExportUrl(filters, 'ndjson')} download />} nativeButton={false}>
              <DownloadIcon /> NDJSON
            </Button>
          </>
        }
      />
      <Toolbar>
        <SearchInput label="Search the audit log" placeholder="Search tools, actions, arguments" value={f.q} onChange={(q) => set({ q })} className="w-64" />
        <Segmented label="Decision" size="sm" value={f.decision ?? 'all'} onChange={(v) => set({ decision: v === 'all' ? undefined : v })} options={[{ value: 'all', label: 'All' }, { value: 'blocked', label: 'Blocked' }, { value: 'dry_run', label: 'Dry run' }, { value: 'confirmed', label: 'Confirmed' }]} />
        <Segmented label="Source" size="sm" value={f.source ?? 'all'} onChange={(v) => set({ source: v === 'all' ? undefined : v })} options={[{ value: 'all', label: 'All' }, { value: 'agents', label: 'Agents' }, { value: 'console', label: 'Console' }]} />
        {server && envs.data ? (
          <select aria-label="Environment" className="h-8 rounded-lg border bg-background px-2 text-[13px]" value={f.env ?? ''} onChange={(e) => set({ env: e.target.value || undefined })}>
            <option value="">All environments</option>
            {envs.data.items.map((e) => (
              <option key={e.id} value={e.id}>
                {e.slug}
              </option>
            ))}
          </select>
        ) : null}
      </Toolbar>
      <DataTable
        label="Audit events"
        columns={columns}
        rows={list.data?.items}
        loading={list.isPending}
        error={list.error}
        onRetry={() => void list.refetch()}
        getRowId={(r) => r.id}
        activeRowId={f.event ?? null}
        onRowClick={(r) => set({ event: r.id })}
        empty={<EmptyState icon={FileTextIcon} title="No events match" />}
      />
      <CursorPager page={cursors.page} hasPrev={cursors.hasPrev} hasNext={!!list.data?.nextCursor} onPrev={cursors.prev} onNext={() => list.data?.nextCursor && cursors.next(list.data.nextCursor)} />
      <EventDrawer id={f.event} onClose={() => set({ event: undefined })} />
    </>
  );
}

function EventDrawer({ id, onClose }: { id: string | undefined; onClose: () => void }) {
  const ev = useQuery({ ...auditEventQuery(id ?? ''), enabled: !!id });
  const [raw, setRaw] = useState(false);
  return (
    <Sheet open={!!id} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="font-mono">{ev.data?.tool ?? ev.data?.action ?? 'Audit event'}</SheetTitle>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          {ev.isError ? <ErrorState error={ev.error} /> : null}
          {!ev.data && !ev.isError ? <Skeleton className="h-64" /> : null}
          {ev.data ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <DecisionBadge decision={ev.data.decision} />
                <AuditStatusText status={ev.data.status} />
                {ev.data.environment ? <EnvBadge slug={ev.data.environment.slug} kind={ev.data.environment.kind} /> : null}
                <span className="text-xs text-muted-foreground">{formatDateTime(ev.data.ts)}</span>
              </div>
              <span className="text-[13px]">
                <span className="text-muted-foreground">Actor:</span> {ev.data.principal?.name ?? 'system'} ({ev.data.principal?.type ?? '—'})
              </span>
              {ev.data.decisionReason ? <p className="text-[13px]">{ev.data.decisionReason}</p> : null}
              {ev.data.params != null ? (
                <>
                  <span className="text-[12.5px] text-muted-foreground">Arguments</span>
                  <JsonViewer value={ev.data.params} label="Arguments" />
                </>
              ) : null}
              {ev.data.outputPreview != null ? (
                <>
                  <span className="text-[12.5px] text-muted-foreground">Result</span>
                  <JsonViewer value={ev.data.outputPreview} label="Result" collapseAfter={20} />
                </>
              ) : null}
              {ev.data.changes ? (
                <>
                  <span className="text-[12.5px] text-muted-foreground">Change</span>
                  <JsonViewer value={ev.data.changes} label="Change" />
                </>
              ) : null}
              {ev.data.policyTrail.length ? (
                <>
                  <span className="text-[12.5px] text-muted-foreground">Policy trail</span>
                  <PolicyTrail steps={ev.data.policyTrail} />
                </>
              ) : null}
              <span className="text-xs text-muted-foreground">
                seq {ev.data.chain.seq} · hash <span className="font-mono">{ev.data.chain.hash.slice(0, 12)}…</span>
              </span>
              <button type="button" className="self-start text-xs text-primary hover:underline" onClick={() => setRaw(!raw)} aria-expanded={raw}>
                {raw ? 'Hide' : 'Show'} the raw record
              </button>
              {raw ? <JsonViewer value={ev.data} label="Raw audit record" /> : null}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
