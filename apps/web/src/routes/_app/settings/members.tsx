import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { MailIcon, UserPlusIcon, UsersIcon } from 'lucide-react';
import { Role, type InviteRow, type MemberRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton, useGate } from '@/components/app/gated';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Pill, type Tone } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { InviteDialog } from '@/features/members/invite-dialog';
import { invitesQuery, membersQuery, useRemoveMember, useRevokeInvite, useUpdateMember } from '@/features/members/queries';
import { useMe } from '@/hooks/use-me';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { ROLE_LABEL, can } from '@/lib/permissions';

const search = z.object({ invite: z.coerce.string().optional().catch(undefined) });

export const Route = createFileRoute('/_app/settings/members')({
  validateSearch: search,
  beforeLoad: guard(['members:read']),
  staticData: { crumbs: ['Settings', 'Members'] },
  component: MembersPage,
});

const INVITE_TONE: Record<InviteRow['status'], Tone> = { pending: 'info', accepted: 'ok', revoked: 'muted', expired: 'muted' };

/** Members of the organization (multi-tenancy spec §2.1, §2.4): roles, status and invite links. */
function MembersPage() {
  const me = useMe();
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const canInvite = can(me, 'members:invite');
  const orgName = me.tenant?.name ?? me.instance.name;
  return (
    <>
      <PageHeader
        title="Members"
        description={`People in ${orgName}. Owners manage members; admins run the gateway and invite people; viewers see everything read-only.`}
        actions={
          canInvite ? (
            <GatedButton cap="members:invite" onClick={() => void navigate({ search: { invite: '1' } })}>
              <UserPlusIcon /> Invite member
            </GatedButton>
          ) : null
        }
      />
      <MembersTable />
      {canInvite ? <InvitesTable /> : null}
      {canInvite && f.invite ? <InviteDialog orgName={orgName} onClose={() => void navigate({ search: {} })} /> : null}
    </>
  );
}

function MembersTable() {
  const me = useMe();
  const members = useQuery(membersQuery());
  const update = useUpdateMember();
  const remove = useRemoveMember();
  const gate = useGate('members:manage');
  const [removing, setRemoving] = useState<MemberRow | null>(null);
  const columns: ColumnSpec<MemberRow>[] = [
    {
      id: 'member',
      header: 'Member',
      priority: 1,
      cell: (m) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-medium">
            {m.name || m.email} {m.id === me.user.id ? <span className="text-xs font-normal text-muted-foreground">(you)</span> : null}
          </span>
          <span className="truncate text-xs text-muted-foreground">{m.email}</span>
        </span>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      priority: 2,
      cell: (m) =>
        gate.disabled ? (
          <span className="text-[13px]">{ROLE_LABEL[m.role]}</span>
        ) : (
          <select
            aria-label={`Role of ${m.name || m.email}`}
            className="h-8 rounded-lg border bg-background px-2 text-[13px]"
            value={m.role}
            disabled={update.isPending}
            onChange={(e) => update.mutate({ id: m.id, role: e.target.value as Role }, { onSuccess: () => notifySuccess(`${m.name || m.email} is now ${ROLE_LABEL[e.target.value as Role].toLowerCase()}`), onError: (err) => notifyError(err, 'Could not change the role') })}
          >
            {Role.options.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </select>
        ),
    },
    { id: 'status', header: 'Status', priority: 2, cell: (m) => <Pill tone={m.status === 'active' ? 'ok' : 'muted'}>{m.status === 'active' ? 'Active' : 'Disabled'}</Pill> },
    { id: 'joined', header: 'Joined', cell: (m) => <span className="text-[13px] text-muted-foreground">{formatDate(m.createdAt)}</span> },
    { id: 'login', header: 'Last sign-in', cell: (m) => <span className="text-[13px] text-muted-foreground">{formatRelative(m.lastLoginAt)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (m) =>
        gate.disabled ? null : (
          <span className="inline-flex gap-1">
            <Button
              variant="ghost"
              size="xs"
              aria-label={`${m.status === 'active' ? 'Disable' : 'Enable'} ${m.name || m.email}`}
              onClick={() => update.mutate({ id: m.id, status: m.status === 'active' ? 'disabled' : 'active' }, { onSuccess: (r) => notifySuccess(`${r.name || r.email} ${r.status === 'active' ? 'enabled' : 'disabled'}`), onError: (err) => notifyError(err, 'Could not change the status') })}
            >
              {m.status === 'active' ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="ghost" size="xs" className="text-destructive" aria-label={`Remove ${m.name || m.email}`} onClick={() => setRemoving(m)}>
              Remove
            </Button>
          </span>
        ),
    },
  ];
  return (
    <section className="flex flex-col gap-2" aria-labelledby="members-title">
      <h2 id="members-title" className="text-base font-semibold">
        Members {members.data ? <span className="font-normal text-muted-foreground">· {members.data.items.length}</span> : null}
      </h2>
      <DataTable
        label="Members"
        columns={columns}
        rows={members.data?.items}
        loading={members.isPending}
        error={members.error}
        onRetry={() => void members.refetch()}
        getRowId={(m) => m.id}
        empty={<EmptyState icon={UsersIcon} title="No members" />}
      />
      <ConfirmDialog
        open={!!removing}
        onOpenChange={(o) => !o && setRemoving(null)}
        title={`Remove ${removing?.name || removing?.email}?`}
        description="They lose access to this organization at once. Their audit history stays."
        confirmLabel="Remove member"
        pending={remove.isPending}
        onConfirm={() =>
          remove.mutate(removing!.id, {
            onSuccess: () => (notifySuccess(`${removing!.name || removing!.email} removed`), setRemoving(null)),
            onError: (err) => (notifyError(err, 'Could not remove the member'), setRemoving(null)),
          })
        }
      />
    </section>
  );
}

function InvitesTable() {
  const invites = useQuery(invitesQuery());
  const revoke = useRevokeInvite();
  const gate = useGate('members:invite');
  const [revoking, setRevoking] = useState<InviteRow | null>(null);
  const columns: ColumnSpec<InviteRow>[] = [
    { id: 'email', header: 'Email', priority: 1, cell: (i) => <span className="font-medium">{i.email}</span> },
    { id: 'role', header: 'Role', priority: 2, cell: (i) => <span className="text-[13px]">{ROLE_LABEL[i.role]}</span> },
    { id: 'status', header: 'Status', priority: 2, cell: (i) => <Pill tone={INVITE_TONE[i.status]}>{i.status[0]!.toUpperCase() + i.status.slice(1)}</Pill> },
    { id: 'by', header: 'Invited by', cell: (i) => <span className="text-[13px] text-muted-foreground">{i.invitedBy?.email ?? '—'}</span> },
    { id: 'created', header: 'Created', cell: (i) => <span className="text-[13px] text-muted-foreground">{formatRelative(i.createdAt)}</span> },
    { id: 'expires', header: 'Expires', cell: (i) => <span className="text-[13px] text-muted-foreground">{i.status === 'accepted' ? `accepted ${formatRelative(i.acceptedAt)}` : formatDate(i.expiresAt)}</span> },
    {
      id: 'actions',
      header: <span className="sr-only">Actions</span>,
      align: 'right',
      cell: (i) =>
        i.status === 'pending' && !gate.disabled ? (
          <Button variant="ghost" size="xs" aria-label={`Revoke the invite for ${i.email}`} onClick={() => setRevoking(i)}>
            Revoke
          </Button>
        ) : null,
    },
  ];
  return (
    <section className="flex flex-col gap-2" aria-labelledby="invites-title">
      <h2 id="invites-title" className="text-base font-semibold">
        Invites
      </h2>
      <DataTable
        label="Invites"
        columns={columns}
        rows={invites.data?.items}
        loading={invites.isPending}
        error={invites.error}
        onRetry={() => void invites.refetch()}
        getRowId={(i) => i.id}
        empty={<EmptyState icon={MailIcon} title="No invites" description="Invite links you create show up here until they are accepted, revoked or expire." />}
      />
      <ConfirmDialog
        open={!!revoking}
        onOpenChange={(o) => !o && setRevoking(null)}
        title={`Revoke the invite for ${revoking?.email}?`}
        description="The link stops working at once."
        confirmLabel="Revoke invite"
        pending={revoke.isPending}
        onConfirm={() => revoke.mutate(revoking!.id, { onSuccess: () => (notifySuccess('Invite revoked'), setRevoking(null)), onError: (err) => notifyError(err) })}
      />
    </section>
  );
}
