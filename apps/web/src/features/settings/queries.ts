import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type SettingsPatch } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export const settingsKeys = { settings: ['settings'] as const, system: ['settings', 'system'] as const, config: ['settings', 'config'] as const, kills: ['settings', 'kill-switches'] as const };

export const settingsQuery = () => queryOptions({ queryKey: settingsKeys.settings, queryFn: ({ signal }) => apiFetch(api.settings.get, { signal }) });
export const systemInfoQuery = () => queryOptions({ queryKey: settingsKeys.system, queryFn: ({ signal }) => apiFetch(api.system.info, { signal }) });
export const configStatusQuery = () => queryOptions({ queryKey: settingsKeys.config, queryFn: ({ signal }) => apiFetch(api.config.status, { signal }) });
export const killSwitchesQuery = () => queryOptions({ queryKey: settingsKeys.kills, queryFn: ({ signal }) => apiFetch(api.killSwitches.list, { signal }) });

export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SettingsPatch) => apiFetch(api.settings.update, { body }),
    onSuccess: (data) => {
      qc.setQueryData(settingsKeys.settings, data);
      void qc.invalidateQueries({ queryKey: ['me'] });
    },
  });
}
export const useTestModel = () => useMutation({ mutationFn: () => apiFetch(api.settings.testModel) });
/** Tests one provider (`<kind>-env` | `<kind>-stored`). */
export const useTestProvider = () => useMutation({ mutationFn: (id: string) => apiFetch(api.modelProviders.test, { params: { id } }) });
export const useTestTelemetry = () => useMutation({ mutationFn: () => apiFetch(api.telemetry.test) });
export function useReloadConfig() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiFetch(api.config.reload), onSuccess: (d) => qc.setQueryData(settingsKeys.config, d) });
}
export function useSetKillSwitch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { scope: 'global' | 'server' | 'environment' | 'tool'; target: string | null; kind: 'all' | 'writes' | 'code_mode'; reason: string }) => apiFetch(api.killSwitches.set, { body }), onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.kills }) });
}
export function useClearKillSwitch() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (q: { scope: 'global' | 'server' | 'environment' | 'tool'; target?: string; kind: 'all' | 'writes' | 'code_mode' }) => apiFetch(api.killSwitches.clear, { query: q }), onSuccess: () => qc.invalidateQueries({ queryKey: settingsKeys.kills }) });
}
