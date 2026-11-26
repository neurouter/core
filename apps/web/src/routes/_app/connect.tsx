import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { KeyRoundIcon } from 'lucide-react';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { ErrorState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Skeleton } from '@/components/ui/skeleton';
import { AgentSummary } from '@/features/connect/agent-summary';
import { ClientSnippet } from '@/features/connect/client-snippet';
import { environmentsQuery } from '@/features/environments/queries';
import { keysQuery } from '@/features/keys/queries';
import { connectQuery, serversQuery } from '@/features/servers/queries';
import { CreateKeyDialog } from '@/features/keys/create-key-dialog';

const search = z.object({
  server: z.string().optional().catch(undefined),
  env: z.string().optional().catch(undefined),
  client: z.enum(['claude-code', 'cursor', 'vscode', 'http']).optional().catch(undefined),
  key: z.coerce.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/connect')({
  validateSearch: search,
  beforeLoad: guard(['keys:read']),
  staticData: { crumbs: ['Connect a client'] },
  component: ConnectPage,
});

/** Connect a client (spec §9.16): server · environment · client; snippets come from `servers.connect`. */
function ConnectPage() {
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const servers = useQuery(serversQuery());
  const sid = f.server ?? servers.data?.items[0]?.id ?? '';
  const envs = useQuery({ ...environmentsQuery(sid), enabled: !!sid });
  const eid = f.env ?? envs.data?.items.find((e) => e.kind === 'dev' && !e.isMock)?.id ?? envs.data?.items[0]?.id;
  const cfg = useQuery({ ...connectQuery(sid, eid), enabled: !!sid && !!eid });
  const keys = useQuery({ ...keysQuery({ serverId: sid, status: 'active' }), enabled: !!sid });
  const envKeys = keys.data?.items.filter((k) => k.environment.id === eid) ?? [];
  const set = (p: Partial<z.infer<typeof search>>) => void navigate({ search: (prev) => ({ ...prev, ...p }), replace: true });
  return (
    <>
      <PageHeader title="Connect a client" description="Add a Neurouter server to Claude Code, Cursor, VS Code or any MCP client." />
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="c-server" className="text-sm font-medium">
            Server
          </label>
          <select id="c-server" className="h-9 min-w-52 rounded-lg border bg-background px-2 text-sm" value={sid} onChange={(e) => set({ server: e.target.value, env: undefined })}>
            {servers.data?.items.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="c-env" className="text-sm font-medium">
            Environment
          </label>
          <select id="c-env" className="h-9 min-w-36 rounded-lg border bg-background px-2 text-sm" value={eid ?? ''} onChange={(e) => set({ env: e.target.value })}>
            {envs.data?.items.map((e) => (
              <option key={e.id} value={e.id}>
                {e.slug}
              </option>
            ))}
          </select>
        </div>
      </div>
      {cfg.isError ? <ErrorState error={cfg.error} onRetry={() => void cfg.refetch()} /> : null}
      {!cfg.data && !cfg.isError ? <Skeleton className="h-60 rounded-xl" /> : null}
      {cfg.data ? (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <section className="flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-5">
            <div className="flex flex-col gap-1">
              <span className="text-[12.5px] text-muted-foreground">MCP endpoint</span>
              <span className="font-mono text-[13px] break-all">{cfg.data.mcpUrl}</span>
            </div>
            <ClientSnippet key={`${sid}-${eid}`} config={cfg.data} initialClient={f.client} onClientChange={(c) => set({ client: c })} />
            <p className="text-[12.5px] text-muted-foreground">
              Auth: {cfg.data.auth.apiKey ? 'API key' : ''}
              {cfg.data.auth.apiKey && cfg.data.auth.oauth ? ' or ' : ''}
              {cfg.data.auth.oauth ? 'OAuth sign-in (the client opens a browser)' : ''}.
            </p>
            {!envKeys.length ? (
              <div className="flex flex-wrap items-center gap-3 rounded-lg bg-brand-muted px-3 py-2.5 text-[13.5px]">
                <KeyRoundIcon aria-hidden="true" className="size-4 text-primary" />
                <span className="flex-1">No API key for this environment yet.</span>
                <GatedButton cap="keys:manage" size="sm" onClick={() => set({ key: 'new' })}>
                  Create a key for this
                </GatedButton>
              </div>
            ) : (
              <p className="text-[13px] text-muted-foreground">
                Keys for {cfg.data.environment.slug}: {envKeys.map((k) => k.name).join(', ')}.{' '}
                <Link to="/keys" className="text-primary hover:underline">
                  Manage keys
                </Link>
              </p>
            )}
          </section>
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-5">
            <h2 className="text-base font-semibold">What agents will see</h2>
            <AgentSummary config={cfg.data} />
          </section>
        </div>
      ) : null}
      {f.key ? <CreateKeyDialog defaults={{ server: sid, env: eid }} onClose={() => set({ key: undefined })} /> : null}
    </>
  );
}
