import * as z from 'zod';

/* ------------------------------------------------------------------ primitives */

/** ISO-8601 UTC timestamp in responses (e.g. `2026-11-24T10:00:00.000Z`). */
export const IsoDateTime = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** ISO-8601 timestamp accepted in requests/query strings (offsets allowed, server normalizes to UTC). */
export const IsoDateTimeInput = z.iso.datetime({ offset: true });

/** Opaque id (UUIDv7 string). Kept loose so fixtures and legacy ids still parse; the server generates UUIDv7. */
export const Id = z.string().min(1).max(128);
export type Id = z.infer<typeof Id>;

export const Ref = z.object({ id: Id, name: z.string() });

/** Reference with a slug (servers, environments). */
export const SlugRef = z.object({ id: Id, slug: z.string(), name: z.string() });
export type SlugRef = z.infer<typeof SlugRef>;
export type Ref = z.infer<typeof Ref>;

export const ServerRef = SlugRef;
export type ServerRef = z.infer<typeof ServerRef>;

export const UserRefWithEmail = Ref.extend({ email: z.string() });
export type UserRefWithEmail = z.infer<typeof UserRefWithEmail>;

export const IdParams = z.object({ id: Id });

export const Slug = z.string().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/, 'lowercase letters, digits and dashes (3–40 chars)');
export const EnvSlug = z.string().regex(/^[a-z][a-z0-9-]{0,30}$/, 'lowercase letters, digits and dashes (1–31 chars)');
export type IdParams = z.infer<typeof IdParams>;

export const SortOrder = z.enum(['asc', 'desc']);
export type SortOrder = z.infer<typeof SortOrder>;

export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** `{ "$redacted": "<rule-name>" }` marker the audit redactor leaves in place of a value. */
export const RedactedMarker = z.object({ $redacted: z.string() });
export type RedactedMarker = z.infer<typeof RedactedMarker>;
export function isRedactedMarker(v: unknown): v is RedactedMarker {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 1 && typeof (v as Record<string, unknown>).$redacted === 'string';
}

/* ------------------------------------------------------------------ query helpers */

/** A repeated query key (`a=1&a=2`) arrives as string | string[]; normalize to an array. */
export function queryArray<T extends z.ZodType>(item: T) {
  return z.preprocess((v) => (v === undefined || v === '' ? undefined : Array.isArray(v) ? v : [v]), z.array(item).optional());
}

/** `true` / `false` (also `1` / `0`) in a query string. */
export const QueryBool = z.preprocess((v) => {
  if (v === 'true' || v === '1' || v === true) return true;
  if (v === 'false' || v === '0' || v === false) return false;
  return v;
}, z.boolean());

/** Drops empty strings (the API ignores empty query values). */
export function queryOptional<T extends z.ZodType>(schema: T) {
  return z.preprocess((v) => (v === '' ? undefined : v), schema.optional());
}

/* ------------------------------------------------------------------ pagination */

export const PAGE_LIMIT_DEFAULT = 50;
export const PAGE_LIMIT_MAX = 200;

export const CursorQuery = z.object({
  cursor: queryOptional(z.string().max(2048)),
  limit: z.preprocess((v) => (v === '' ? undefined : v), z.coerce.number().int().min(1).max(PAGE_LIMIT_MAX).optional()),
});
export type CursorQuery = z.infer<typeof CursorQuery>;

/** `Page<T> = { items, nextCursor, totalEstimate? }` (backend §14.1). */
export function Page<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
    totalEstimate: z.number().int().nonnegative().optional(),
  });
}
export type Page<T> = { items: T[]; nextCursor: string | null; totalEstimate?: number };

export function Items<T extends z.ZodType>(item: T) {
  return z.object({ items: z.array(item) });
}

/** Sort param from a per-endpoint allowlist. */
export function sortParam<const F extends readonly [string, ...string[]]>(fields: F) {
  return queryOptional(z.enum(fields));
}

/* ------------------------------------------------------------------ errors (RFC 9457) */

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
export const PROBLEM_TYPE_BASE = 'https://neurouter.dev/problems/';

/** Error codes, statuses and titles (backend §14.1; Hub codes + Neurouter codes). `type` URIs are stable per code. */
export const PROBLEM_CODES = {
  bad_request: { status: 400, title: 'Bad request' },
  unauthenticated: { status: 401, title: 'Authentication required' },
  forbidden: { status: 403, title: 'Forbidden' },
  not_found: { status: 404, title: 'Not found' },
  method_not_allowed: { status: 405, title: 'Method not allowed' },
  conflict: { status: 409, title: 'Conflict' },
  gone: { status: 410, title: 'Gone' },
  precondition_failed: { status: 412, title: 'Precondition failed' },
  payload_too_large: { status: 413, title: 'Payload too large' },
  unsupported_media_type: { status: 415, title: 'Unsupported media type' },
  validation_failed: { status: 422, title: 'Validation failed' },
  rate_limited: { status: 429, title: 'Too many requests' },
  internal: { status: 500, title: 'Internal server error' },
  upstream_unavailable: { status: 502, title: 'Upstream unavailable' },
  service_unavailable: { status: 503, title: 'Service unavailable' },
  // Neurouter codes (backend §14.1)
  config_managed: { status: 409, title: 'Managed by neurouter.yaml' },
  spec_invalid: { status: 422, title: 'Invalid spec' },
  spec_unsupported: { status: 422, title: 'Unsupported spec' },
  spec_fetch_failed: { status: 502, title: 'Could not fetch the spec' },
  overlay_invalid: { status: 422, title: 'Invalid overlay' },
  build_failed: { status: 422, title: 'Build failed' },
  draft_conflict: { status: 409, title: 'Draft changed' },
  llm_key_missing: { status: 412, title: 'Model provider key missing' },
  executor_unavailable: { status: 503, title: 'Code-mode executor unavailable' },
  job_running: { status: 409, title: 'A job is already running' },
} as const satisfies Record<string, { status: number; title: string }>;

export type ProblemCode = keyof typeof PROBLEM_CODES;
export const ProblemCodeSchema = z.enum(Object.keys(PROBLEM_CODES) as [ProblemCode, ...ProblemCode[]]);

export function problemType(code: string): string {
  return PROBLEM_TYPE_BASE + code.replaceAll('_', '-');
}

export const ProblemFieldError = z.object({
  path: z.array(z.string()),
  message: z.string(),
  code: z.string(),
});
export type ProblemFieldError = z.infer<typeof ProblemFieldError>;

/** RFC 9457 problem details + Neurouter extensions (`code`, `requestId`, `errors`). `code` is open for forward compat. */
export const Problem = z.looseObject({
  type: z.string(),
  title: z.string(),
  status: z.number().int().min(400).max(599),
  detail: z.string().optional(),
  instance: z.string().optional(),
  code: z.string(),
  requestId: z.string(),
  errors: z.array(ProblemFieldError).optional(),
});
export type Problem = z.infer<typeof Problem>;

/** Converts a zod error path to the problem `errors[].path` form (strings only). */
export function toProblemPath(path: readonly PropertyKey[]): string[] {
  return path.map((p) => String(p));
}

/* ------------------------------------------------------------------ misc shapes */

export const ClientInfo = z.object({ name: z.string().nullable(), version: z.string().nullable() });

/** The principal behind an MCP call (API key, OAuth user or external-AS subject). */
export const PrincipalView = z.object({ type: z.enum(['user', 'api_key', 'external']), id: z.string(), name: z.string() });
export type PrincipalView = z.infer<typeof PrincipalView>;

/** `ceil(utf8Bytes / 4)` token estimate (A43). */
export const TokenEstimate = z.number().int().nonnegative();
export type ClientInfo = z.infer<typeof ClientInfo>;

/** `403 forbidden` reasons (problem extension `reason`). */
export const ForbiddenReason = z.enum(['csrf', 'demo_read_only', 'capability', 'no_tenant', 'instance_setting', 'invite_email_mismatch', 'tenant_suspended']);
export type ForbiddenReason = z.infer<typeof ForbiddenReason>;

/** `spec_fetch_failed` reasons (problem extension `reason`). */
export const SpecFetchFailReason = z.enum(['unreachable', 'too_large', 'not_a_spec', 'blocked_host']);
export type SpecFetchFailReason = z.infer<typeof SpecFetchFailReason>;

/** Extensions of `config_managed` problems. */
export const ConfigManagedExtension = z.object({ configPath: z.string(), configLine: z.number().int().nullable() });

/** Where a file-managed resource is defined (`FileManagedNote`). */
export const ConfigLocation = z.object({ path: z.string(), line: z.number().int().nullable() });
export type ConfigLocation = z.infer<typeof ConfigLocation>;

export const JobAccepted = z.object({ jobId: Id, status: z.enum(['queued', 'running', 'succeeded', 'failed']) });
export type JobAccepted = z.infer<typeof JobAccepted>;

export const TimeRangeQuery = z.object({
  from: queryOptional(IsoDateTimeInput),
  to: queryOptional(IsoDateTimeInput),
});

/** Time-ranged lists default to the last 24 h and allow at most 90 days (backend §14.1). */
export const DEFAULT_TIME_RANGE_MS = 24 * 3_600_000;
export const MAX_TIME_RANGE_DAYS = 90;
export const DEFAULT_AUDIT_MAX_RANGE_DAYS = MAX_TIME_RANGE_DAYS;

export function timeRangeIssue(from: string, to: string, maxDays = DEFAULT_AUDIT_MAX_RANGE_DAYS): string | null {
  const f = Date.parse(from);
  const t = Date.parse(to);
  if (Number.isNaN(f) || Number.isNaN(t)) return 'from and to must be ISO-8601 timestamps';
  if (t <= f) return '`to` must be after `from`';
  if (t - f > maxDays * 86_400_000) return `time range must not exceed ${maxDays} days`;
  return null;
}
