import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { KeyRoundIcon, PlusIcon } from 'lucide-react';
import type { ApiKeyRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { ButtonTabs } from '@/components/app/link-tabs';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { EnvBadge, KeyStatusBadge, Pill } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { keysQuery, oauthClientsQuery, oauthGrantsQuery, useRevokeKey } from '@/features/keys/queries';
import { useGate } from '@/components/app/gated';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const search = z.object({ create: z.coerce.string().optional().catch(undefined), tab: z.enum(['keys', 'oauth']).optional().catch(undefined), server: z.string().optional().catch(undefined), env: z.string().optional().catch(undefined) });

import { CreateKeyDialog } from '@/features/keys/create-key-dialog';

export const Route = createFileRoute('/_app/keys')({
  validateSearch: search,
  beforeLoad: guard(['keys:read']),
  staticData: { crumbs: ['API keys'] },
  component: KeysPage,
});

/** API keys (spec §9.16): one server + one environment per key; the secret is shown once. */
function KeysPage() {
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tab = f.tab ?? 'keys';
  const keys = useQuery(keysQuery());
  const revoke = useRevokeKey();
  const gate = useGate('keys:manage');
  const [revoking, setRevoking] = useState<ApiKeyRow | null>(null);
  const columns: ColumnSpec<ApiKeyRow>[] = [
    { id: 'name', header: 'Name', priority: 1, cell: (k) => <span className="font-mono text-[13px] font-medium">{k.name}</span> },
    { id: 'prefix', header: 'Prefix', cell: (k) => <span className="font-mono text-xs text-muted-foreground">{k.displayPrefix}</span> },
    { id: 'server', header: 'Server', priority: 2, cell: (k) => k.server.name },
    { id: 'env', header: 'Environment', priority: 1, cell: (k) => <EnvBadge slug={k.environment.slug} kind={k.environment.kind} /> },
    { id: 'scopes', header: 'Access', cell: (k) => <span className="flex flex-wrap gap-1">{k.scopes.map((s) => <Pill key={s} tone={s === 'tools:write' ? 'warn' : 'muted'}>{s === 'tools:read' ? 'read' : s === 'tools:write' ? 'write (per env switches)' : 'code mode'}</Pill>)}</span> },
    { id: 'owner', header: 'Created', cell: (k) => <span className="text-[13px] text-muted-foreground">{k.owner.name} · {formatDate(k.createdAt)}</span> },
    { id: 'used', header: 'Last used', cell: (k) => <span className="text-[13px] text-muted-foreground">{formatRelative(k.lastUsedAt)}</span> },
    { id: 'expires', header: 'Expires', cell: (k) => <span className="text-[13px] text-muted-foreground">{k.expiresAt ? formatDate(k.expiresAt) : <span className="text-warning">never</span>}</span> },
    { id: 'status', header: 'Status', priority: 2, cell: (k) => <KeyStatusBadge status={k.status} /> },
    { id: 'actions', header: <span className="sr-only">Actions</span>, cell: (k) => (k.status === 'active' && !gate.disabled ? <Button variant="ghost" size="xs" onClick={() => setRevoking(k)} aria-label={`Revoke ${k.name}`}>Revoke</Button> : null) },
  ];
  return (
    <>
      <PageHeader
        title="API keys"
        description="Each key is bound to one server and one environment. Writes follow that environment's write switches."
        actions={
          <GatedButton cap="keys:manage" onClick={() => void navigate({ search: (p) => ({ ...p, create: '1' }) })}>
            <PlusIcon /> Create API key
          </GatedButton>
        }
      />
      <ButtonTabs label="Credentials" value={tab} onChange={(v) => void navigate({ search: (p) => ({ ...p, tab: v }) })} tabs={[{ value: 'keys', label: 'API keys' }, { value: 'oauth', label: 'OAuth clients and grants' }]} />
      {tab === 'keys' ? (
        <DataTable label="API keys" columns={columns} rows={keys.data?.items} loading={keys.isPending} error={keys.error} onRetry={() => void keys.refetch()} getRowId={(k) => k.id} empty={<EmptyState icon={KeyRoundIcon} title="No API keys" description="Create a key to connect an agent." />} />
      ) : (
        <OAuthTab />
      )}
      {f.create ? <CreateKeyDialog defaults={{ server: f.server, env: f.env }} onClose={() => void navigate({ search: (p) => ({ ...p, create: undefined }) })} /> : null}
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke ${revoking?.name}?`}
        description="Agents using this key lose access immediately."
        confirmLabel="Revoke key"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(revoking!.id, { onSuccess: () => (notifySuccess(`${revoking!.name} revoked`), setRevoking(null)), onError: (e) => notifyError(e) })}
      />
    </>
  );
}

function OAuthTab() {
  const clients = useQuery(oauthClientsQuery());
  const grants = useQuery(oauthGrantsQuery());
  return (
    <div className="flex flex-col gap-4">
      <section className="overflow-hidden rounded-xl border bg-card">
        <h2 className="px-4 py-3 text-base font-semibold">OAuth clients</h2>
        <ul className="divide-y">
          {clients.data?.items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13.5px]">
              <span className="font-medium">{c.name}</span>
              <Pill tone="muted">{c.registrationType}</Pill>
              <span className="font-mono text-xs text-muted-foreground">{c.clientId}</span>
              <span className="flex-1" />
              {c.environments.map((e) => (
                <EnvBadge key={e.id} slug={`${e.serverSlug}/${e.slug}`} kind={e.kind} />
              ))}
              <span className="text-xs text-muted-foreground">{formatRelative(c.lastUsedAt)}</span>
              <Pill tone={c.status === 'active' ? 'ok' : 'err'}>{c.status}</Pill>
            </li>
          ))}
        </ul>
      </section>
      <section className="overflow-hidden rounded-xl border bg-card">
        <h2 className="px-4 py-3 text-base font-semibold">User grants</h2>
        <ul className="divide-y">
          {grants.data?.items.map((g) => (
            <li key={g.id} className="flex flex-wrap items-center gap-2 px-4 py-2.5 text-[13.5px]">
              <span>{g.user.name}</span>
              <span className="text-muted-foreground">via {g.client.name}</span>
              <EnvBadge slug={`${g.environment.serverSlug}/${g.environment.slug}`} kind={g.environment.kind} />
              <span className="font-mono text-xs text-muted-foreground">{g.scopes.join(' ')}</span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

