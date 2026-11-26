import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ApiKeyCreate } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export const keyKeys = { list: (f: object) => ['keys', f] as const, oauth: ['keys', 'oauth'] as const };

export const keysQuery = (f: { serverId?: string; status?: 'active' | 'revoked' | 'expired' } = {}) => queryOptions({ queryKey: keyKeys.list(f), queryFn: ({ signal }) => apiFetch(api.keys.list, { query: { ...f, limit: 200 }, signal }) });
export const oauthClientsQuery = () => queryOptions({ queryKey: [...keyKeys.oauth, 'clients'], queryFn: ({ signal }) => apiFetch(api.oauthClients.list, { query: {}, signal }) });
export const oauthGrantsQuery = () => queryOptions({ queryKey: [...keyKeys.oauth, 'grants'], queryFn: ({ signal }) => apiFetch(api.oauthGrants.list, { query: {}, signal }) });

export function useCreateKey() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: ApiKeyCreate) => apiFetch(api.keys.create, { body }), onSuccess: () => qc.invalidateQueries({ queryKey: ['keys'] }) });
}

export function useRevokeKey() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiFetch(api.keys.revoke, { params: { id } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['keys'] }) });
}
