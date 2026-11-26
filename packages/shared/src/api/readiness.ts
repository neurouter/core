import * as z from 'zod';
import { CallMode, EvalConfidence, ReadinessBand, ReadinessComponentKey } from '../domain/enums.js';
import { Id, IsoDateTime } from './common.js';

/** One component of the agent-readiness score (frontend `ScoreBreakdown`, backend §15.6). */
export const ReadinessComponent = z.object({
  key: ReadinessComponentKey,
  label: z.string(),
  weight: z.number().min(0).max(1),
  /** 0..1 */
  score: z.number().min(0).max(1),
  detail: z.string(),
  /** Number of open fix suggestions that target this component. */
  fixCount: z.number().int().nonnegative(),
});
export type ReadinessComponent = z.infer<typeof ReadinessComponent>;

/** Latest readiness of a server; `preliminary` = lint-only when no measured run exists. */
export const ReadinessSummary = z.object({
  score: z.number().int().min(0).max(100),
  band: ReadinessBand,
  confidence: EvalConfidence,
  runId: Id.nullable(),
  measuredAt: IsoDateTime.nullable(),
  recommendedMode: CallMode.nullable(),
  /** Generated recommendation text (frontend `ModeRecommendation`), null when preliminary. */
  recommendation: z.string().nullable(),
  modeScores: z.object({ tool: z.number().int().optional(), code: z.number().int().optional() }),
  breakdown: z.array(ReadinessComponent),
});
export type ReadinessSummary = z.infer<typeof ReadinessSummary>;

/** Full score of an eval run: per model × mode cell plus the headline (backend §15.6). */
export const ReadinessScore = z.object({
  headline: z.number().int().min(0).max(100),
  band: ReadinessBand,
  confidence: EvalConfidence,
  recommendedMode: CallMode.nullable(),
  recommendation: z.string().nullable(),
  primaryModel: z.string(),
  modeScores: z.object({ tool: z.number().int().optional(), code: z.number().int().optional() }),
  breakdown: z.array(ReadinessComponent),
  cells: z.array(z.object({ model: z.string(), mode: CallMode, score: z.number().int(), components: z.array(ReadinessComponent) })),
});
export type ReadinessScore = z.infer<typeof ReadinessScore>;
