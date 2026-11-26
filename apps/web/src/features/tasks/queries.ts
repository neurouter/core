import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { api } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export type TaskFilters = { serverId?: string; environmentId?: string; outcome?: string[]; principal?: string; client?: string; q?: string; hasScripts?: boolean; hasErrors?: boolean; origin?: 'agent' | 'eval' | 'all'; from?: string; to?: string; tool?: string; cursor?: string; limit?: number };

export const taskKeys = {
  list: (f: TaskFilters) => ['tasks', 'list', f] as const,
  detail: (id: string) => ['tasks', 'detail', id] as const,
  call: (id: string) => ['calls', id] as const,
  script: (id: string) => ['scripts', id] as const,
};

export const tasksQuery = (f: TaskFilters, live = false) =>
  queryOptions({ queryKey: taskKeys.list(f), queryFn: ({ signal }) => apiFetch(api.tasks.list, { query: { limit: 50, ...f }, signal }), placeholderData: keepPreviousData, refetchInterval: live ? 5000 : false });

/** Task detail, polled every 5 s while the task is in progress (spec §9.12). */
export const taskQuery = (id: string) =>
  queryOptions({ queryKey: taskKeys.detail(id), queryFn: ({ signal }) => apiFetch(api.tasks.get, { params: { id }, signal }), refetchInterval: (q) => (q.state.data?.status === 'open' ? 5000 : false) });

export const callQuery = (id: string) => queryOptions({ queryKey: taskKeys.call(id), queryFn: ({ signal }) => apiFetch(api.calls.get, { params: { auditId: id }, signal }), staleTime: Infinity });
export const scriptQuery = (id: string) => queryOptions({ queryKey: taskKeys.script(id), queryFn: ({ signal }) => apiFetch(api.scripts.get, { params: { id }, signal }), staleTime: 60_000 });
