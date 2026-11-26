import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { FileUpIcon, ServerIcon } from 'lucide-react';
import type { ServerRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { SearchInput } from '@/components/filters/search-input';
import { Segmented } from '@/components/filters/segmented';
import { Toolbar } from '@/components/layout/section';
import { PageHeader } from '@/components/layout/page-header';
import { EnvBadge, HealthDot, SpecKindBadge } from '@/components/status/status';
import { ScoreBadge } from '@/features/readiness/score-ring';
import { serversQuery } from '@/features/servers/queries';
import { formatRelative } from '@/lib/format';

const search = z.object({ q: z.string().optional().catch(undefined), kind: z.enum(['openapi', 'graphql']).optional().catch(undefined) });

export const Route = createFileRoute('/_app/servers/')({
  validateSearch: search,
  beforeLoad: guard(['servers:read']),
  staticData: { crumbs: ['Servers'] },
  component: ServersPage,
});

function ServersPage() {
  const { q, kind } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const servers = useQuery(serversQuery({ ...(q ? { q } : {}), ...(kind ? { kind } : {}) }));
  const columns: ColumnSpec<ServerRow>[] = [
    {
      id: 'name',
      header: 'Server',
      priority: 1,
      cell: (s) => (
        <div className="flex flex-col gap-1">
          <Link to="/servers/$serverId" params={{ serverId: s.id }} className="font-medium hover:underline">
            {s.name}
          </Link>
          {s.specFormat ? <SpecKindBadge format={s.specFormat} /> : null}
        </div>
      ),
    },
    { id: 'readiness', header: 'Readiness', priority: 1, cell: (s) => <ScoreBadge score={s.readiness?.score} preliminary={s.readiness?.confidence === 'preliminary'} /> },
    { id: 'tools', header: 'Tools', priority: 2, align: 'right', cell: (s) => <span className="tabular-nums">{s.visibleToolCount} / {s.toolCount}</span> },
    { id: 'writes', header: 'Write tools', align: 'right', cell: (s) => <span className="tabular-nums">{s.writeToolCount}</span> },
    {
      id: 'envs',
      header: 'Environments',
      priority: 2,
      cell: (s) => (
        <div className="flex flex-wrap gap-1.5">
          {s.environments.map((e) => (
            <span key={e.id} className="inline-flex items-center gap-1" title={`${e.slug}: ${e.health}`}>
              <HealthDot status={e.health} />
              <EnvBadge slug={e.slug} kind={e.isMock ? 'mock' : e.kind} />
            </span>
          ))}
        </div>
      ),
    },
    { id: 'mode', header: 'Mode', cell: (s) => <span className="text-[13px] text-muted-foreground">{s.readiness?.recommendedMode ? `${s.readiness.recommendedMode} recommended` : '—'}</span> },
    { id: 'updated', header: 'Updated', cell: (s) => <span className="text-[13px] text-muted-foreground">{formatRelative(s.updatedAt)}</span> },
  ];
  const filtered = !!(q || kind);
  return (
    <>
      <PageHeader
        title="Servers"
        description="Each server is one API compiled into MCP tools, with its own environments and overlay."
        actions={
          <GatedButton cap="servers:write" demoOp="specs.preview" render={<Link to="/servers/new" />} nativeButton={false}>
            <FileUpIcon /> Import a spec
          </GatedButton>
        }
      />
      <Toolbar>
        <SearchInput label="Search servers" placeholder="Search servers" value={q} onChange={(v) => void navigate({ search: (p) => ({ ...p, q: v }) })} className="w-64" />
        <Segmented
          label="Spec kind"
          size="sm"
          value={kind ?? 'all'}
          onChange={(v) => void navigate({ search: (p) => ({ ...p, kind: v === 'all' ? undefined : v }) })}
          options={[
            { value: 'all', label: 'All' },
            { value: 'openapi', label: 'OpenAPI' },
            { value: 'graphql', label: 'GraphQL' },
          ]}
        />
      </Toolbar>
      <DataTable
        label="Servers"
        columns={columns}
        rows={servers.data?.items}
        loading={servers.isPending}
        error={servers.error}
        onRetry={() => void servers.refetch()}
        getRowId={(s) => s.id}
        empty={
          filtered ? (
            <EmptyState icon={ServerIcon} title="No servers match" description="Clear the search or the kind filter." />
          ) : (
            <EmptyState icon={ServerIcon} title="Import your first API" description="Point Neurouter at an OpenAPI 3.x or GraphQL spec." action={<Link to="/servers/new" className="font-medium text-primary hover:underline">Import a spec</Link>} />
          )
        }
      />
    </>
  );
}
