import { queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export const inboxKeys = {
  summary: (serverId?: string) => ['inbox', 'summary', serverId ?? null] as const,
  needs: (f: object) => ['inbox', 'needs', f] as const,
  need: (id: string) => ['inbox', 'need', id] as const,
  issues: (f: object) => ['inbox', 'issues', f] as const,
  issue: (id: string) => ['inbox', 'issue', id] as const,
  byTool: (serverId: string, tool: string) => ['inbox', 'by-tool', serverId, tool] as const,
};

export const inboxSummaryQuery = (serverId?: string) => queryOptions({ queryKey: inboxKeys.summary(serverId), queryFn: ({ signal }) => apiFetch(api.inbox.summary, { query: { serverId }, signal }) });
export const needGroupsQuery = (f: { serverId?: string; status?: 'open' | 'planned' | 'done' | 'dismissed'; sort?: 'count' | 'recent'; q?: string } = {}) =>
  queryOptions({ queryKey: inboxKeys.needs(f), queryFn: ({ signal }) => apiFetch(api.inbox.needGroups, { query: { ...f, limit: 100 }, signal }) });
export const needGroupQuery = (id: string) => queryOptions({ queryKey: inboxKeys.need(id), queryFn: ({ signal }) => apiFetch(api.inbox.needGroup, { params: { groupId: id }, query: {}, signal }) });
export const issuesQuery = (f: { serverId?: string; status?: 'open' | 'acknowledged' | 'fixed' | 'dismissed'; tool?: string } = {}) =>
  queryOptions({ queryKey: inboxKeys.issues(f), queryFn: ({ signal }) => apiFetch(api.inbox.issues, { query: { ...f, limit: 100 }, signal }) });
export const issueQuery = (id: string) => queryOptions({ queryKey: inboxKeys.issue(id), queryFn: ({ signal }) => apiFetch(api.inbox.issue, { params: { id }, signal }) });
export const inboxByToolQuery = (serverId: string, toolName: string) => queryOptions({ queryKey: inboxKeys.byTool(serverId, toolName), queryFn: ({ signal }) => apiFetch(api.inbox.list, { query: { serverId, toolName }, signal }) });

export function useTriageNeed(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { status?: 'open' | 'planned' | 'done' | 'dismissed'; note?: string | null }) => apiFetch(api.inbox.triageNeedGroup, { params: { groupId: id }, body }), onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }) });
}
export function useMergeNeed(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (intoGroupId: string) => apiFetch(api.inbox.mergeNeedGroups, { params: { groupId: id }, body: { intoGroupId } }), onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }) });
}
export function useTriageIssue(id: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (body: { status?: 'open' | 'acknowledged' | 'fixed' | 'dismissed'; note?: string }) => apiFetch(api.inbox.triageIssue, { params: { id }, body }), onSuccess: () => qc.invalidateQueries({ queryKey: ['inbox'] }) });
}
export const fetchNeedMarkdown = (id: string) => apiFetch(api.inbox.exportNeedMarkdown, { params: { groupId: id } }).then((r) => r.markdown);
export const fetchIssueMarkdown = (id: string) => apiFetch(api.inbox.exportIssueMarkdown, { params: { id } }).then((r) => r.markdown);
