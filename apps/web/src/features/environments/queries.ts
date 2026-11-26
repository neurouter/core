import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type EnvironmentCreate, type EnvironmentDetail } from '@/contract';
import { apiFetch } from '@/lib/api-client';
import { serverKeys } from '@/features/servers/queries';

export const envKeys = {
  list: (serverId: string) => ['environments', serverId] as const,
  matrix: (serverId: string) => ['environments', serverId, 'write-switches'] as const,
};

export const environmentsQuery = (serverId: string) => queryOptions({ queryKey: envKeys.list(serverId), queryFn: ({ signal }) => apiFetch(api.environments.list, { params: { id: serverId }, signal }) });
export const writeSwitchesQuery = (serverId: string) => queryOptions({ queryKey: envKeys.matrix(serverId), queryFn: ({ signal }) => apiFetch(api.writeSwitches.get, { params: { id: serverId }, signal }) });

function useInvalidate(serverId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: ['environments', serverId] });
    void qc.invalidateQueries({ queryKey: serverKeys.detail(serverId) });
    void qc.invalidateQueries({ queryKey: ['tools', serverId] });
  };
}

export function useCreateEnvironment(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({ mutationFn: (body: EnvironmentCreate) => apiFetch(api.environments.create, { params: { id: serverId }, body }), onSuccess: inv });
}

export function useUpdateEnvironment(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({ mutationFn: ({ id, body }: { id: string; body: Partial<EnvironmentCreate> }) => apiFetch(api.environments.update, { params: { id }, body }), onSuccess: inv });
}

export function useDeleteEnvironment(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({ mutationFn: (env: EnvironmentDetail) => apiFetch(api.environments.delete, { params: { id: env.id }, query: { confirm: env.slug } }), onSuccess: inv });
}

export function useTestEnvironment() {
  return useMutation({ mutationFn: (id: string) => apiFetch(api.environments.test, { params: { id }, body: {} }) });
}

export function useSetSecret(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({ mutationFn: ({ id, name, value }: { id: string; name: string; value: string }) => apiFetch(api.environments.setSecret, { params: { id, name }, body: { value } }), onSuccess: inv });
}

/** One write-switch cell. A prod cell carries the typed confirmation (G4). */
export function useSetToolWrite(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({
    mutationFn: ({ env, toolName, enabled, confirmSlug }: { env: { id: string; kind: string }; toolName: string; enabled: boolean; confirmSlug?: string }) =>
      apiFetch(api.environments.setToolWrite, { params: { id: env.id, toolName }, body: { enabled, ...(env.kind === 'prod' && enabled ? { confirm: 'elicit' as const, confirmEnvironmentSlug: confirmSlug } : {}) } }),
    onSuccess: inv,
  });
}

/** Bulk "Enable all writes in dev" (never offered for prod). */
export function useSetWrites(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({ mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) => apiFetch(api.environments.setWrites, { params: { id }, body: { enabled, tools: null, confirm: 'none' } }), onSuccess: inv });
}

export function usePinBuild(serverId: string) {
  const inv = useInvalidate(serverId);
  return useMutation({ mutationFn: ({ id, buildId }: { id: string; buildId: string }) => apiFetch(api.environments.pinBuild, { params: { id }, body: { buildId } }), onSuccess: inv });
}

/** Prod write rule (spec §9.8): enabling a write in a prod environment needs the typed slug. */
export function needsProdConfirm(env: { kind: string }, enabling: boolean): boolean {
  return env.kind === 'prod' && enabling;
}
