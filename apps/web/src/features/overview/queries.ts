import { queryOptions } from '@tanstack/react-query';
import { api } from '@/contract';
import { apiFetch } from '@/lib/api-client';

export const metricsKeys = {
  overview: (f: object) => ['metrics', 'overview', f] as const,
  timeseries: (f: object) => ['metrics', 'timeseries', f] as const,
};

export const overviewQuery = (f: { serverId?: string; from?: string; to?: string }) => queryOptions({ queryKey: metricsKeys.overview(f), queryFn: ({ signal }) => apiFetch(api.metrics.overview, { query: f, signal }) });

/** Calls per day split by mode (tool vs script), last 14 days. */
export const callsByModeQuery = (serverId?: string) =>
  queryOptions({ queryKey: metricsKeys.timeseries({ serverId, metric: 'calls' }), queryFn: ({ signal }) => apiFetch(api.metrics.timeseries, { query: { serverId, metric: 'calls', bucket: 'day', groupBy: 'mode' }, signal }) });
