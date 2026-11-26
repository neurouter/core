import { keepPreviousData, queryOptions, useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type OverlayDraft, type OverlayPatchOp } from '@/contract';
import { ApiError, apiFetch } from '@/lib/api-client';
import { serverKeys } from '@/features/servers/queries';

export type ToolFilters = { q?: string; visibility?: 'visible' | 'hidden' | 'all'; kind?: 'read' | 'write'; pinned?: boolean; modified?: boolean };

export const toolKeys = {
  list: (serverId: string, f: ToolFilters) => ['tools', serverId, 'list', f] as const,
  detail: (toolId: string) => ['tools', 'detail', toolId] as const,
  usage: (toolId: string) => ['tools', 'detail', toolId, 'usage'] as const,
  search: (serverId: string, q: string, env?: string) => ['tools', serverId, 'search', q, env ?? null] as const,
  searchAll: (q: string) => ['tools', 'search-all', q] as const,
  draft: (serverId: string) => ['overlay', serverId, 'draft'] as const,
  versions: (serverId: string) => ['overlay', serverId, 'versions'] as const,
  version: (id: string) => ['overlay', 'version', id] as const,
  diff: (serverId: string, from: string, to: string) => ['overlay', serverId, 'diff', from, to] as const,
  preview: (serverId: string, tool: string, ops: unknown) => ['overlay', serverId, 'preview', tool, ops] as const,
};

export const toolsQuery = (serverId: string, f: ToolFilters = {}) =>
  queryOptions({ queryKey: toolKeys.list(serverId, f), queryFn: ({ signal }) => apiFetch(api.tools.list, { params: { id: serverId }, query: { ...f, limit: 200 }, signal }), placeholderData: keepPreviousData });

export const toolQuery = (toolId: string) => queryOptions({ queryKey: toolKeys.detail(toolId), queryFn: ({ signal }) => apiFetch(api.tools.get, { params: { id: toolId }, signal }) });
export const toolUsageQuery = (toolId: string) => queryOptions({ queryKey: toolKeys.usage(toolId), queryFn: ({ signal }) => apiFetch(api.metrics.toolUsage, { params: { id: toolId }, signal }) });

export const toolSearchQuery = (serverId: string, q: string, environmentId?: string) =>
  queryOptions({ queryKey: toolKeys.search(serverId, q, environmentId), queryFn: ({ signal }) => apiFetch(api.tools.search, { params: { id: serverId }, query: { q, environmentId }, signal }), enabled: q.trim().length > 1 });

export const toolSearchAllQuery = (q: string) => queryOptions({ queryKey: toolKeys.searchAll(q), queryFn: ({ signal }) => apiFetch(api.tools.searchAll, { query: { q, limit: 8 }, signal }), enabled: q.trim().length > 1 });

export const draftQuery = (serverId: string) => queryOptions({ queryKey: toolKeys.draft(serverId), queryFn: ({ signal }) => apiFetch(api.overlays.getDraft, { params: { id: serverId }, signal }) });
export const versionsQuery = (serverId: string) => queryOptions({ queryKey: toolKeys.versions(serverId), queryFn: ({ signal }) => apiFetch(api.overlays.versions, { params: { id: serverId }, query: { limit: 50 }, signal }) });
export const versionQuery = (id: string) => queryOptions({ queryKey: toolKeys.version(id), queryFn: ({ signal }) => apiFetch(api.overlays.getVersion, { params: { id }, signal }) });
export const overlayDiffQuery = (serverId: string, from: string, to: string) =>
  queryOptions({ queryKey: toolKeys.diff(serverId, from, to), queryFn: ({ signal }) => apiFetch(api.overlays.diff, { params: { id: serverId }, query: { from, to }, signal }) });

export const overlayPreviewQuery = (serverId: string, toolName: string, ops: OverlayPatchOp[] = []) =>
  queryOptions({
    queryKey: toolKeys.preview(serverId, toolName, ops),
    queryFn: ({ signal }) => apiFetch(api.overlays.preview, { params: { id: serverId }, body: { toolName, ops }, signal }),
    placeholderData: keepPreviousData,
  });

function invalidateOverlay(qc: ReturnType<typeof useQueryClient>, serverId: string) {
  void qc.invalidateQueries({ queryKey: ['overlay', serverId] });
  void qc.invalidateQueries({ queryKey: ['tools'] });
  void qc.invalidateQueries({ queryKey: serverKeys.detail(serverId) });
}

/**
 * Patches the overlay draft with `If-Match`. On 409 `draft_conflict` it refetches the draft and
 * re-applies the pending ops once (frontend spec §17.2), then gives up with the error.
 */
export function usePatchDraft(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (ops: OverlayPatchOp[]) => {
      const send = (etag?: string) => apiFetch(api.overlays.updateDraft, { params: { id: serverId }, body: { ops }, headers: etag ? { 'if-match': etag } : {} });
      const cached = qc.getQueryData<OverlayDraft>(toolKeys.draft(serverId));
      try {
        return await send(cached?.etag);
      } catch (err) {
        if (!(err instanceof ApiError && err.code === 'draft_conflict')) throw err;
        const fresh = await qc.fetchQuery({ ...draftQuery(serverId), staleTime: 0 });
        return send(fresh.etag);
      }
    },
    onSuccess: (draft) => {
      qc.setQueryData(toolKeys.draft(serverId), draft);
      invalidateOverlay(qc, serverId);
    },
  });
}

export function useDiscardDraft(serverId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: () => apiFetch(api.overlays.discardDraft, { params: { id: serverId } }), onSuccess: () => invalidateOverlay(qc, serverId) });
}

export function usePublish(serverId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { message: string; pinTo?: string[] }) => {
      const etag = qc.getQueryData<OverlayDraft>(toolKeys.draft(serverId))?.etag;
      return apiFetch(api.overlays.publish, { params: { id: serverId }, body, headers: etag ? { 'if-match': etag } : {} });
    },
    onSuccess: () => {
      invalidateOverlay(qc, serverId);
      void qc.invalidateQueries({ queryKey: ['environments', serverId] });
    },
  });
}

export function useRevert(serverId: string) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (toRev: number) => apiFetch(api.overlays.revert, { params: { id: serverId }, body: { toRev, message: `Revert to v${toRev}` } }), onSuccess: () => invalidateOverlay(qc, serverId) });
}
