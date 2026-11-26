import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type EvalRunCreate } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export const evalKeys = {
  runs: (f: object) => ['evals', 'runs', f] as const,
  run: (id: string) => ['evals', 'run', id] as const,
  suggestions: (runId: string) => ['evals', 'run', runId, 'suggestions'] as const,
  search: (f: object) => ['evals', 'suggestions', f] as const,
  compare: (base: string, head: string) => ['evals', 'compare', base, head] as const,
  suites: (serverId: string) => ['evals', 'suites', serverId] as const,
  taskRun: (runId: string, taskRunId: string) => ['evals', 'run', runId, 'task-run', taskRunId] as const,
};

export const runsQuery = (f: { serverId?: string } = {}) =>
  queryOptions({
    queryKey: evalKeys.runs(f),
    queryFn: ({ signal }) => apiFetch(api.evals.runs, { query: { ...f, limit: 50 }, signal }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'running' || r.status === 'queued') ? 2000 : false),
  });

/** Run detail, polled every 2 s while running (spec §8). */
export const runQuery = (id: string) =>
  queryOptions({ queryKey: evalKeys.run(id), queryFn: ({ signal }) => apiFetch(api.evals.run, { params: { id }, signal }), refetchInterval: (q) => (q.state.data && (q.state.data.status === 'running' || q.state.data.status === 'queued') ? 2000 : false) });

export const suggestionsQuery = (runId: string) =>
  queryOptions({ queryKey: evalKeys.suggestions(runId), queryFn: ({ signal }) => apiFetch(api.suggestions.list, { params: { id: runId }, signal }), refetchInterval: (q) => (q.state.data?.items.some((s) => s.status === 'verifying') ? 1000 : false) });

export const suggestionSearchQuery = (f: { serverId?: string; toolName?: string; status?: 'proposed' | 'verifying' | 'verified' | 'applied' | 'dismissed' }) =>
  queryOptions({ queryKey: evalKeys.search(f), queryFn: ({ signal }) => apiFetch(api.suggestions.search, { query: { ...f, limit: 20 }, signal }) });

export const compareQuery = (base: string, head: string) => queryOptions({ queryKey: evalKeys.compare(base, head), queryFn: ({ signal }) => apiFetch(api.evals.compare, { query: { base, head }, signal }) });
export const suitesQuery = (serverId: string) => queryOptions({ queryKey: evalKeys.suites(serverId), queryFn: ({ signal }) => apiFetch(api.evals.suites, { params: { id: serverId }, signal }) });
export const taskRunQuery = (runId: string, taskRunId: string) => queryOptions({ queryKey: evalKeys.taskRun(runId, taskRunId), queryFn: ({ signal }) => apiFetch(api.evals.taskRun, { params: { id: runId, taskRunId }, signal }) });

export function useCreateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: EvalRunCreate) => apiFetch(api.evals.createRun, { body }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['evals'] });
      void qc.invalidateQueries({ queryKey: ['me', 'badges'] });
    },
  });
}

export function useCancelRun() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiFetch(api.evals.cancelRun, { params: { id } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['evals'] }) });
}

export function useVerifySuggestion() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiFetch(api.suggestions.verify, { params: { id } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['evals'] }) });
}

/** Apply as overlay: patches the server's overlay draft (mode draft) and invalidates it. */
export function useApplySuggestion(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, mode = 'draft' }: { id: string; mode?: 'draft' | 'publish' }) => apiFetch(api.suggestions.apply, { params: { id }, body: { mode } }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['evals'] });
      void qc.invalidateQueries({ queryKey: ['overlay', serverId] });
      void qc.invalidateQueries({ queryKey: ['tools'] });
      void qc.invalidateQueries({ queryKey: ['servers'] });
    },
  });
}

export function useDismissSuggestion() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => apiFetch(api.suggestions.dismiss, { params: { id } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['evals'] }) });
}
