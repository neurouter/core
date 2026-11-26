import * as z from 'zod';
import { CallMode } from '../domain/enums.js';
import { Id, IdParams, IsoDateTime, TimeRangeQuery, queryOptional } from './common.js';
import { endpoint } from './endpoint.js';
import { ReadinessSummary } from './readiness.js';
import { TaskRow } from './tasks.js';

/* ------------------------------------------------------------------ metrics (§14.3) */

export const MetricsQuery = TimeRangeQuery.extend({ serverId: queryOptional(Id), environmentId: queryOptional(Id) });
export type MetricsQuery = z.infer<typeof MetricsQuery>;

export const OverviewKpis = z.object({
  tasks: z.number().int(),
  taskSuccessRate: z.number().min(0).max(1).nullable(),
  calls: z.number().int(),
  errorRate: z.number().min(0).max(1).nullable(),
  blockedCalls: z.number().int(),
  scriptRuns: z.number().int(),
  unmetNeedsOpen: z.number().int(),
  issuesOpen: z.number().int(),
});
export type OverviewKpis = z.infer<typeof OverviewKpis>;

export const Overview = z.object({
  kpis: OverviewKpis,
  /** Same KPIs for the previous period of equal length (deltas). */
  previous: OverviewKpis,
  readiness: z.array(ReadinessSummary.extend({ serverId: Id, serverSlug: z.string(), serverName: z.string() })),
  topTools: z.array(z.object({ tool: z.string(), serverId: Id, calls: z.number().int(), errorRate: z.number().min(0).max(1), p95Ms: z.number().nullable() })),
  topErrors: z.array(z.object({ code: z.string(), count: z.number().int() })),
  recentTasks: z.array(TaskRow),
  from: IsoDateTime,
  to: IsoDateTime,
});
export type Overview = z.infer<typeof Overview>;

export const TimeseriesMetric = z.enum(['calls', 'errors', 'tasks', 'latency_p95', 'task_success']);
export const TimeseriesBucket = z.enum(['minute', 'hour', 'day']);
export const TimeseriesQuery = MetricsQuery.extend({
  metric: TimeseriesMetric,
  bucket: queryOptional(TimeseriesBucket),
  groupBy: queryOptional(z.enum(['mode', 'environment', 'status'])),
});
export type TimeseriesQuery = z.infer<typeof TimeseriesQuery>;

export const Timeseries = z.object({
  metric: TimeseriesMetric,
  bucket: TimeseriesBucket,
  series: z.array(z.object({ key: z.string(), points: z.array(z.object({ t: IsoDateTime, v: z.number().nullable() })) })),
});
export type Timeseries = z.infer<typeof Timeseries>;

export const ToolUsage = z.object({
  calls: z.number().int(),
  errors: z.number().int(),
  p50Ms: z.number().nullable(),
  p95Ms: z.number().nullable(),
  byStatus: z.record(z.string(), z.number().int()),
  byEnvironment: z.record(z.string(), z.number().int()),
  byMode: z.partialRecord(CallMode, z.number().int()),
  recentErrors: z.array(z.object({ errorId: z.string(), code: z.string(), ts: IsoDateTime })),
});
export type ToolUsage = z.infer<typeof ToolUsage>;

export const metricsEndpoints = {
  overview: endpoint({
    method: 'GET', path: '/api/metrics/overview', kind: 'json', access: ['tasks:read'],
    summary: 'KPIs, readiness, top tools/errors, recent tasks', query: MetricsQuery, response: Overview,
  }),
  timeseries: endpoint({
    method: 'GET', path: '/api/metrics/timeseries', kind: 'json', access: ['tasks:read'],
    summary: 'Time series for one metric', query: TimeseriesQuery, response: Timeseries,
  }),
  toolUsage: endpoint({
    method: 'GET', path: '/api/tools/:id/usage', kind: 'json', access: ['tools:read'],
    summary: 'Usage of one tool', params: IdParams, query: MetricsQuery, response: ToolUsage,
  }),
} as const;
