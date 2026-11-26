import { queryOptions } from '@tanstack/react-query';
import { api } from '@/contract';
import { apiFetch } from '@/lib/api-client';

/** Task results of a run (prompts for the compare page's flipped-task lists). */
export const runTasksQuery = (runId: string) => queryOptions({ queryKey: ['evals', 'run', runId, 'tasks'], queryFn: ({ signal }) => apiFetch(api.evals.runTasks, { params: { id: runId }, query: { limit: 200 }, signal }) });
