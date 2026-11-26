import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import { ERROR_CATALOG, fillTemplate, META_ERROR_ID, META_NEXT_TOOLS, META_RETRY_AFTER_MS, type ErrorCode } from '@neurouter/shared';
import type { MainDB } from '../../kernel/db/schema.js';
import { toJsonColumn } from '../../kernel/lib/json.js';

const B62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

export function base62(bytes: number, len: number): string {
  let out = '';
  for (const b of randomBytes(bytes)) out += B62[b % 62];
  return out.slice(0, len);
}

export const newErrorId = (): string => `err_${base62(24, 16)}`;

export const ERROR_EVENT_TTL_MS = 7 * 86_400_000;

/** Hints at the moment of need (§11.3). */
export function hintsFor(code: ErrorCode): string[] {
  const out = ['neurouter_explain_error'];
  if (['not_permitted', 'writes_disabled', 'unknown_tool', 'upstream_auth'].includes(code)) out.push('neurouter_whoami');
  return out;
}

export interface ErrorEventInput {
  tenantId: string;
  taskId: string | null;
  auditId: string | null;
  toolName: string | null;
  code: ErrorCode;
  detail: Record<string, unknown>;
}

/** `error_events` rows (§7.2): what `neurouter_explain_error` explains. Detail must already be redacted. */
export class ErrorEvents {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly now: () => number,
  ) {}

  async record(e: ErrorEventInput): Promise<string> {
    const errorId = newErrorId();
    const t = this.now();
    await this.db
      .insertInto('error_events')
      .values({ error_id: errorId, tenant_id: e.tenantId, task_id: e.taskId, audit_id: e.auditId, tool_name: e.toolName, code: e.code, detail: toJsonColumn(e.detail), created_at: t, expires_at: t + ERROR_EVENT_TTL_MS })
      .execute();
    return errorId;
  }

  async get(tenantId: string, errorId: string): Promise<{ code: ErrorCode; detail: Record<string, unknown>; toolName: string | null; auditId: string | null; taskId: string | null } | null> {
    const r = await this.db.selectFrom('error_events').selectAll().where('error_id', '=', errorId).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!r || r.expires_at <= this.now()) return null;
    const detail = typeof r.detail === 'string' ? (JSON.parse(r.detail) as Record<string, unknown>) : (r.detail as unknown as Record<string, unknown>);
    return { code: r.code as ErrorCode, detail, toolName: r.tool_name, auditId: r.audit_id, taskId: r.task_id };
  }
}

/** Explanation for an error code with its placeholders filled. */
export function explain(code: ErrorCode, detail: Record<string, unknown>): { code: ErrorCode; title: string; explanation: string; how_to_fix: string } {
  const c = ERROR_CATALOG[code] ?? ERROR_CATALOG.upstream_error;
  return { code, title: c.title, explanation: fillTemplate(c.explanation, detail), how_to_fix: fillTemplate(c.howToFix, detail) };
}

export interface ToolErrorResult {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
  structuredContent?: Record<string, unknown>;
  _meta: Record<string, unknown>;
}

/** MCP error result (`isError: true`, not a JSON-RPC error) carrying error_id + next-tools (§9.6, §11.3). */
export function errorResult(message: string, errorId: string | null, code: ErrorCode, extra: { retryAfterMs?: number; nextTools?: string[]; meta?: Record<string, unknown> } = {}): ToolErrorResult {
  const next = [...new Set([...(extra.nextTools ?? []), ...hintsFor(code)])];
  const suffix = errorId ? ` (error_id=${errorId}; call neurouter_explain_error for how to fix)` : '';
  const meta: Record<string, unknown> = { [META_NEXT_TOOLS]: next, ...(extra.meta ?? {}) };
  if (errorId) meta[META_ERROR_ID] = errorId;
  if (extra.retryAfterMs !== undefined) meta[META_RETRY_AFTER_MS] = extra.retryAfterMs;
  return { content: [{ type: 'text', text: `${message}${suffix}` }], isError: true, structuredContent: { error: { code, message, ...(errorId ? { error_id: errorId } : {}) } }, _meta: meta };
}
