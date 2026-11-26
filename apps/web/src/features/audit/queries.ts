import { keepPreviousData, queryOptions, useMutation } from '@tanstack/react-query';
import { AuditVerifyResult, api } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export type AuditFilters = { serverId?: string; environmentId?: string; decision?: string[]; kind?: string[]; tool?: string; q?: string; via?: 'console' | 'direct' | 'script' | 'call_tool' | 'eval'; from?: string; to?: string; taskId?: string; cursor?: string };

export const auditKeys = { list: (f: AuditFilters) => ['audit', 'list', f] as const, detail: (id: string) => ['audit', 'detail', id] as const };
export const auditQuery = (f: AuditFilters) =>
  queryOptions({ queryKey: auditKeys.list(f), queryFn: ({ signal }) => apiFetch(api.audit.list, { query: { limit: 50, ...f } as never, signal }), placeholderData: keepPreviousData });
export const auditEventQuery = (id: string) => queryOptions({ queryKey: auditKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.audit.get, { params: { id }, signal }) });
/** Verify the hash chain: starts a job (202) and polls `jobs.get` for the `AuditVerifyResult`. */
export function useVerifyAudit() {
  return useMutation({
    mutationFn: async () => {
      const job = await apiFetch(api.audit.verify, { body: {} });
      for (let i = 0; i < 60; i++) {
        const j = await apiFetch(api.jobs.get, { params: { id: job.jobId } });
        if (j.status === 'succeeded') return AuditVerifyResult.parse(j.result);
        if (j.status === 'failed') throw new Error(j.error ?? 'Verification failed');
        await new Promise((r) => setTimeout(r, 1000));
      }
      throw new Error('Verification is still running');
    },
  });
}
