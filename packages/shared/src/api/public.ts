import * as z from 'zod';
import { CallMode, EvalConfidence, ReadinessBand } from '../domain/enums.js';
import { IsoDateTime } from './common.js';
import { endpoint } from './endpoint.js';

/* ------------------------------------------------------------------ public (§14.14; no /api prefix, no session) */

export const PublicReport = z.object({
  server: z.object({ name: z.string(), slug: z.string(), description: z.string() }),
  score: z.number().int().min(0).max(100),
  band: ReadinessBand,
  confidence: EvalConfidence,
  recommendedMode: CallMode.nullable(),
  modeScores: z.object({ tool: z.number().int().optional(), code: z.number().int().optional() }),
  models: z.array(z.object({ model: z.string(), toolScore: z.number().int().nullable(), codeScore: z.number().int().nullable() })),
  measuredAt: IsoDateTime,
  specTitle: z.string(),
  toolCount: z.number().int(),
});
export type PublicReport = z.infer<typeof PublicReport>;

const SlugParams = z.object({ slug: z.string().min(1).max(40) });

export const publicEndpoints = {
  report: endpoint({
    method: 'GET', path: '/public/servers/:slug/report', kind: 'json', access: ['public'],
    summary: 'Public readiness report (404 unless publicReport and a measured run exist; cache 300 s)', params: SlugParams, response: PublicReport,
  }),
  badge: endpoint({
    method: 'GET', path: '/public/servers/:slug/badge.svg', kind: 'binary', access: ['public'],
    summary: 'SVG badge "agent-ready | 87" with band colour', params: SlugParams,
  }),
} as const;
