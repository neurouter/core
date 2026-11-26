import { Link, Outlet, createFileRoute, useNavigate, useRouterState } from '@tanstack/react-router';
import * as z from 'zod';
import { useQuery } from '@tanstack/react-query';
import { GaugeIcon, PlugIcon, RefreshCwIcon } from 'lucide-react';
import { AreaError, guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { LinkTabs } from '@/components/app/link-tabs';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { PageHeader } from '@/components/layout/page-header';
import { FileManagedNote, specFormatLabel } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { connectQuery, serverQuery } from '@/features/servers/queries';
import { toolQuery } from '@/features/tools/queries';
import { environmentsQuery } from '@/features/environments/queries';
import { ClientSnippet } from '@/features/connect/client-snippet';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';

export const Route = createFileRoute('/_app/servers/$serverId')({
  validateSearch: z.object({ connect: z.coerce.string().optional().catch(undefined) }),
  beforeLoad: guard(['servers:read']),
  loader: ({ context, params }) => context.queryClient.ensureQueryData(serverQuery(params.serverId)),
  errorComponent: AreaError,
  component: ServerLayout,
});

const TAB_LABEL: Record<string, string> = { tools: 'Tools', overlay: 'Overlay', environments: 'Environments', spec: 'Spec', settings: 'Settings' };

/** Server header (name, spec kind, versions, actions) and the tab bar (spec §5.1). */
function ServerLayout() {
  const { serverId } = Route.useParams();
  const server = useQuery(serverQuery(serverId));
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const base = `/servers/${serverId}`;
  const tab = pathname.slice(base.length).split('/')[1] ?? '';
  const toolCrumb = tab === 'tools' && pathname.split('/').length > 4 ? decodeURIComponent(pathname.split('/')[4]!) : null;
  const toolData = useQuery({ ...toolQuery(toolCrumb ?? ''), enabled: !!toolCrumb });
  useSetCrumbs(
    server.data
      ? [
          { label: 'Servers', to: '/servers' },
          ...(tab ? [{ label: server.data.name, to: base }, { label: TAB_LABEL[tab] ?? tab, ...(toolCrumb ? { to: `${base}/tools` } : {}) }] : [{ label: server.data.name }]),
          ...(toolCrumb ? [{ label: toolData.data?.name ?? '…' }] : []),
        ]
      : null,
  );
  if (server.isPending) return <PageSkeleton />;
  if (server.isError) return <ErrorState error={server.error} onRetry={() => void server.refetch()} />;
  const s = server.data;
  const facts = [specFormatLabel(s.specFormat), s.currentSpec ? `spec v${s.currentSpec.rev}` : null, s.publishedOverlay ? `overlay v${s.publishedOverlay.rev}` : 'no overlay yet', `${s.visibleToolCount} tools (${s.writeToolCount} write)`].filter(Boolean).join(' · ');
  const toolDetail = !!toolCrumb;
  return (
    <>
      {!toolDetail ? (
        <PageHeader
          title={s.name}
          description={facts}
          actions={
            <>
              <Button variant="outline" size="lg" render={<Link to="/connect" search={{ server: s.id }} />} nativeButton={false}>
                <PlugIcon /> Connect
              </Button>
              <GatedButton cap="evals:run" variant="outline" size="lg" render={<Link to="/evals" search={{ server: s.id, new: '1' }} />} nativeButton={false}>
                <GaugeIcon /> Run eval
              </GatedButton>
              <GatedButton cap="servers:write" size="lg" render={<Link to="/servers/$serverId/spec" params={{ serverId: s.id }} search={{ reimport: '1' }} />} nativeButton={false}>
                <RefreshCwIcon /> Re-import spec
              </GatedButton>
            </>
          }
        />
      ) : null}
      {s.managedBy === 'file' && s.config && !toolDetail ? <FileManagedNote path={s.config.path} line={s.config.line} /> : null}
      {!toolDetail ? (
        <LinkTabs
          label="Server sections"
          tabs={[
            { label: 'Overview', to: base, exact: true },
            { label: 'Tools', to: `${base}/tools` },
            { label: 'Overlay', to: `${base}/overlay`, ...(s.draft ? { count: s.draft.changeCount } : {}) },
            { label: 'Environments', to: `${base}/environments` },
            { label: 'Spec', to: `${base}/spec` },
            { label: 'Settings', to: `${base}/settings` },
          ]}
        />
      ) : null}
      <Outlet />
      <ConnectSheet serverId={s.id} />
    </>
  );
}

/** "Connect a client" sheet, opened after the import wizard's Finish (`?connect=1`). */
function ConnectSheet({ serverId }: { serverId: string }) {
  const { connect } = Route.useSearch();
  const navigate = useNavigate();
  const envs = useQuery({ ...environmentsQuery(serverId), enabled: !!connect });
  const env = envs.data?.items.find((e) => !e.isMock) ?? envs.data?.items[0];
  const cfg = useQuery({ ...connectQuery(serverId, env?.id), enabled: !!connect && !!env });
  return (
    <Sheet open={!!connect} onOpenChange={(o) => !o && void navigate({ to: '.', search: (p: Record<string, unknown>) => ({ ...p, connect: undefined }) as never })}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>Connect a client</SheetTitle>
          <SheetDescription>The server is live{env ? ` on ${env.slug}` : ''}. Add it to your agent with a key for one environment.</SheetDescription>
        </SheetHeader>
        <div className="flex flex-col gap-3 px-4 pb-6">
          {cfg.data ? <ClientSnippet config={cfg.data} /> : <Skeleton className="h-40" />}
          <Link to="/connect" search={{ server: serverId }} className="text-[13.5px] text-primary hover:underline">
            More options and API keys
          </Link>
        </div>
      </SheetContent>
    </Sheet>
  );
}
