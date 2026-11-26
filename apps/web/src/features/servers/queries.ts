import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type ServerPatch } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export const serverKeys = {
  all: ['servers'] as const,
  list: (f: { q?: string; kind?: string }) => ['servers', 'list', f] as const,
  detail: (id: string) => ['servers', 'detail', id] as const,
  readiness: (id: string) => ['servers', 'detail', id, 'readiness'] as const,
  connect: (id: string, env?: string) => ['servers', 'detail', id, 'connect', env ?? null] as const,
  opsTools: (id: string) => ['servers', 'detail', id, 'ops-tools'] as const,
  specs: (id: string) => ['servers', 'detail', id, 'specs'] as const,
  spec: (specId: string) => ['specs', specId] as const,
  builds: (id: string) => ['servers', 'detail', id, 'builds'] as const,
  build: (buildId: string) => ['builds', buildId] as const,
};

export const serversQuery = (f: { q?: string; kind?: 'openapi' | 'graphql' } = {}) =>
  queryOptions({ queryKey: serverKeys.list(f), queryFn: ({ signal }) => apiFetch(api.servers.list, { query: { ...f, limit: 100 }, signal }), placeholderData: keepPreviousData });

export const serverQuery = (id: string) => queryOptions({ queryKey: serverKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.servers.get, { params: { id }, signal }) });

export const readinessQuery = (id: string) => queryOptions({ queryKey: serverKeys.readiness(id), queryFn: ({ signal }) => apiFetch(api.readiness.get, { params: { id }, signal }) });

export const connectQuery = (id: string, environmentId?: string) =>
  queryOptions({ queryKey: serverKeys.connect(id, environmentId), queryFn: ({ signal }) => apiFetch(api.servers.connect, { params: { id }, query: { environmentId }, signal }) });

export const opsToolsQuery = (id: string) => queryOptions({ queryKey: serverKeys.opsTools(id), queryFn: ({ signal }) => apiFetch(api.opsTools.list, { params: { id }, signal }) });

export const specsQuery = (id: string) => queryOptions({ queryKey: serverKeys.specs(id), queryFn: ({ signal }) => apiFetch(api.specs.list, { params: { id }, query: { limit: 50 }, signal }) });
export const specQuery = (specId: string) => queryOptions({ queryKey: serverKeys.spec(specId), queryFn: ({ signal }) => apiFetch(api.specs.get, { params: { id: specId }, signal }) });
export const buildsQuery = (id: string) => queryOptions({ queryKey: serverKeys.builds(id), queryFn: ({ signal }) => apiFetch(api.builds.list, { params: { id }, query: { limit: 50 }, signal }) });
export const buildQuery = (buildId: string) => queryOptions({ queryKey: serverKeys.build(buildId), queryFn: ({ signal }) => apiFetch(api.builds.get, { params: { id: buildId }, signal }) });

export function useUpdateServer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ServerPatch) => apiFetch(api.servers.update, { params: { id }, body }),
    onSuccess: (data) => {
      qc.setQueryData(serverKeys.detail(id), data);
      void qc.invalidateQueries({ queryKey: serverKeys.all });
    },
  });
}

export function useSetOpsTools(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Record<string, boolean>) => apiFetch(api.opsTools.set, { params: { id }, body }),
    onSuccess: (data) => qc.setQueryData(serverKeys.opsTools(id), data),
  });
}

export function useDeleteServer(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (confirm: string) => apiFetch(api.servers.delete, { params: { id }, query: { confirm } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: serverKeys.all }),
  });
}

export function useReimport(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { previewId?: string; source?: { url: string } | { content: string; filename?: string } }) => apiFetch(api.specs.reimport, { params: { id }, body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: serverKeys.detail(id) }),
  });
}
