import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { CircleIcon, SearchIcon, WrenchIcon } from 'lucide-react';
import type { ToolRow } from '@/contract';
import { useGate } from '@/components/app/gated';
import { keyName } from '@/components/app/labels';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { Toolbar } from '@/components/layout/section';
import { EnvBadge, Pill, WriteBadge } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { environmentsQuery } from '@/features/environments/queries';
import { OverlayDraftBar } from '@/features/overlays/draft-bar';
import { serverQuery } from '@/features/servers/queries';
import { toolSearchQuery, toolsQuery, usePatchDraft } from '@/features/tools/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { formatNumber, formatPercent } from '@/lib/format';
import { notifyError } from '@/lib/notify';

const search = z.object({
  q: z.string().optional().catch(undefined),
  visibility: z.enum(['visible', 'hidden', 'all']).optional().catch(undefined),
  kind: z.enum(['read', 'write']).optional().catch(undefined),
  pinned: z.boolean().optional().catch(undefined),
  modified: z.boolean().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/servers/$serverId/tools/')({
  validateSearch: search,
  component: ToolsPage,
});

function ToolsPage() {
  const { serverId } = Route.useParams();
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tools = useQuery(toolsQuery(serverId, { visibility: f.visibility ?? 'all', ...(f.q ? { q: f.q } : {}), ...(f.kind ? { kind: f.kind } : {}), ...(f.pinned ? { pinned: true } : {}), ...(f.modified ? { modified: true } : {}) }));
  const server = useQuery(serverQuery(serverId));
  const envs = useQuery(environmentsQuery(serverId));
  const patch = usePatchDraft(serverId);
  const gate = useGate('overlays:write', 'overlays.updateDraft');
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }) });
  const realEnvs = envs.data?.items.filter((e) => !e.isMock) ?? [];
  const pinnedOp = server.data?.exposure.pinned.length ?? 0;
  const columns: ColumnSpec<ToolRow>[] = [
    {
      id: 'name',
      header: 'Tool',
      priority: 1,
      cell: (t) => (
        <div className="flex flex-col">
          <Link to="/servers/$serverId/tools/$toolId" params={{ serverId, toolId: t.id }} className="font-mono text-[13px] font-medium hover:underline">
            {t.name}
          </Link>
          {keyName(t.key) !== t.name ? <span className="font-mono text-xs text-muted-foreground">{keyName(t.key)}</span> : null}
        </div>
      ),
    },
    { id: 'source', header: 'Source', cell: (t) => <span className="font-mono text-[12.5px] whitespace-nowrap text-muted-foreground">{t.method ? `${t.method} ${t.path}` : keyName(t.key)}</span> },
    { id: 'kind', header: 'Kind', priority: 1, cell: (t) => <WriteBadge write={t.write} /> },
    { id: 'visible', header: 'Visible', priority: 2, cell: (t) => (t.hidden ? <Pill tone="muted">hidden</Pill> : <span className="text-[13px]">visible</span>) },
    {
      id: 'pinned',
      header: 'Pinned',
      cell: (t) => (
        <Switch
          size="sm"
          checked={t.pinned}
          disabled={gate.disabled || t.hidden}
          aria-label={`Pin ${t.name}`}
          onCheckedChange={(v) => patch.mutate([{ op: 'set', selector: t.key, field: 'pinned', value: v }], { onError: (e) => notifyError(e, 'Could not change the pin') })}
        />
      ),
    },
    {
      id: 'writes',
      header: 'Writes on in',
      cell: (t) =>
        t.write ? (
          <div className="flex gap-1">
            {realEnvs.filter((e) => t.writeEnabledIn.includes(e.slug)).map((e) => <EnvBadge key={e.id} slug={e.slug} kind={e.kind} />)}
            {!realEnvs.some((e) => t.writeEnabledIn.includes(e.slug)) ? <span className="text-xs text-muted-foreground">none</span> : null}
          </div>
        ) : (
          <span className="text-xs text-muted-foreground">—</span>
        ),
    },
    { id: 'calls', header: 'Calls 7 d', align: 'right', priority: 2, cell: (t) => <span className="tabular-nums">{formatNumber(t.calls7d)}</span> },
    { id: 'errors', header: 'Errors', align: 'right', cell: (t) => <span className="text-muted-foreground tabular-nums">{t.calls7d ? formatPercent(t.errorRate7d, 1) : '—'}</span> },
    {
      id: 'modified',
      header: <span className="sr-only">Overlay</span>,
      cell: (t) =>
        t.overlayModified ? (
          <span title="Changed by the overlay" className="inline-flex items-center gap-1 text-xs text-primary">
            <CircleIcon aria-hidden="true" className="size-2 fill-current" />
            <span className="sr-only">Changed by the overlay</span>
          </span>
        ) : null,
    },
  ];
  return (
    <div className="flex flex-1 flex-col gap-4">
      <Toolbar>
        <SearchInput label="Search tools" placeholder="Search tools" value={f.q} onChange={(q) => set({ q })} className="w-56" />
        <Segmented label="Visibility" size="sm" value={f.visibility ?? 'all'} onChange={(v) => set({ visibility: v === 'all' ? undefined : v })} options={[{ value: 'all', label: 'All' }, { value: 'visible', label: 'Visible' }, { value: 'hidden', label: 'Hidden' }]} />
        <Segmented label="Kind" size="sm" value={f.kind ?? 'any'} onChange={(v) => set({ kind: v === 'any' ? undefined : v })} options={[{ value: 'any', label: 'Read + write' }, { value: 'read', label: 'Read' }, { value: 'write', label: 'Write' }]} />
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <Switch size="sm" checked={!!f.pinned} onCheckedChange={(v) => set({ pinned: v || undefined })} /> Pinned
        </label>
        <label className="inline-flex items-center gap-1.5 text-[13px]">
          <Switch size="sm" checked={!!f.modified} onCheckedChange={(v) => set({ modified: v || undefined })} /> Modified by overlay
        </label>
        <span className="flex-1" />
        <SearchPreview serverId={serverId} />
      </Toolbar>
      <p className="text-[12.5px] text-muted-foreground">
        Pinned set = {pinnedOp} operator-pinned + top 5 by usage (refreshed daily). Everything else is found through <code className="font-mono">search_tools</code>.
      </p>
      <DataTable
        label="Tools"
        columns={columns}
        rows={tools.data?.items}
        loading={tools.isPending}
        error={tools.error}
        onRetry={() => void tools.refetch()}
        getRowId={(t) => t.id}
        rowClassName={(t) => (t.hidden ? 'text-muted-foreground' : undefined)}
        empty={<EmptyState icon={WrenchIcon} title="No tools match" description="Clear the filters to see every tool." />}
      />
      <OverlayDraftBar serverId={serverId} />
    </div>
  );
}

/** "Try search_tools": what an agent would get for a query (`tools.search`). */
function SearchPreview({ serverId }: { serverId: string }) {
  const [q, setQ] = useState('');
  const debounced = useDebouncedValue(q.trim(), 300);
  const res = useQuery(toolSearchQuery(serverId, debounced));
  return (
    <Popover>
      <PopoverTrigger render={<Button variant="outline" size="sm" />}>
        <SearchIcon /> Try search_tools
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px]">
        <div className="flex flex-col gap-2">
          <label htmlFor="st-q" className="text-[13px] font-medium">
            What an agent asks
          </label>
          <Input id="st-q" autoFocus placeholder="refund an order" value={q} onChange={(e) => setQ(e.target.value)} />
          <ol aria-live="polite" className="flex flex-col gap-1">
            {res.data?.tools.map((t, i) => (
              <li key={t.name} className="flex items-center gap-2 text-[13px]">
                <span className="w-4 text-right text-xs text-muted-foreground tabular-nums">{i + 1}</span>
                <span className="font-mono">{t.name}</span>
                {t.write ? <WriteBadge write /> : null}
                <span className="ml-auto text-xs text-muted-foreground tabular-nums">{t.score.toFixed(2)}</span>
              </li>
            ))}
            {res.data && !res.data.tools.length ? <li className="text-[13px] text-muted-foreground">No tool matches. Agents would report an unmet need.</li> : null}
          </ol>
          {res.data ? <span className="text-xs text-muted-foreground">{res.data.totalVisible} visible tools searched</span> : null}
        </div>
      </PopoverContent>
    </Popover>
  );
}
