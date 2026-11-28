import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type InviteCreate, type MemberPatch } from '@/contract';
import { apiFetch } from '@/lib/api-client';

/** Members of the tab's organization (the tenant header scopes every call). */
export const memberKeys = {
  all: ['members'] as const,
  list: ['members', 'list'] as const,
  invites: ['members', 'invites'] as const,
};

export const membersQuery = () => queryOptions({ queryKey: memberKeys.list, queryFn: ({ signal }) => apiFetch(api.members.list, { query: { limit: 200 }, signal }) });
export const invitesQuery = () => queryOptions({ queryKey: memberKeys.invites, queryFn: ({ signal }) => apiFetch(api.members.invites, { signal }) });

export function useUpdateMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: MemberPatch & { id: string }) => apiFetch(api.members.update, { params: { id }, body }),
    onSuccess: () => Promise.all([qc.invalidateQueries({ queryKey: memberKeys.list }), qc.invalidateQueries({ queryKey: ['me'], exact: true })]),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiFetch(api.members.remove, { params: { id } }), onSuccess: () => qc.invalidateQueries({ queryKey: memberKeys.list }) });
}

export function useCreateInvite() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: InviteCreate) => apiFetch(api.members.invite, { body }), onSuccess: () => qc.invalidateQueries({ queryKey: memberKeys.invites }) });
}

export function useRevokeInvite() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiFetch(api.members.revokeInvite, { params: { id } }), onSuccess: () => qc.invalidateQueries({ queryKey: memberKeys.invites }) });
}
