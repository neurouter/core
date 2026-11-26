import { gunzipSync, gzipSync } from 'node:zlib';
import type { Kysely } from 'kysely';
import type { MainDB } from '../../kernel/db/schema.js';
import { base62 } from '../pipeline/errors.js';

export const RESULT_PAGE_TTL_MS = 3_600_000;

/** Full shaped results behind a handle (`rh_` + 22 base62, 1 h, bound to the credential; §9.9). */
export class ResultPages {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly now: () => number,
  ) {}

  async store(tenantId: string, credentialKey: string, value: unknown): Promise<string> {
    const handle = `rh_${base62(32, 22)}`;
    const json = Buffer.from(JSON.stringify(value), 'utf8');
    const t = this.now();
    await this.db.insertInto('result_pages').values({ handle, tenant_id: tenantId, credential_key: credentialKey, content: gzipSync(json), bytes: json.length, created_at: t, expires_at: t + RESULT_PAGE_TTL_MS }).execute();
    return handle;
  }

  /** The whole stored value (contract-2 `r` cursors page through it), or null when unknown, expired or another credential's. */
  async load(tenantId: string, credentialKey: string, handle: string): Promise<unknown> {
    const r = await this.db.selectFrom('result_pages').selectAll().where('handle', '=', handle).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!r || r.credential_key !== credentialKey || r.expires_at <= this.now()) return null;
    return JSON.parse(gunzipSync(r.content).toString('utf8')) as unknown;
  }

  /** Reads a page: arrays are paged by item; anything else is paged by characters of its JSON. */
  async read(tenantId: string, credentialKey: string, handle: string, offset: number, limit: number): Promise<{ items?: unknown[]; text?: string; offset: number; total: number; next_offset: number | null } | null> {
    const r = await this.db.selectFrom('result_pages').selectAll().where('handle', '=', handle).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!r || r.credential_key !== credentialKey || r.expires_at <= this.now()) return null;
    const value = JSON.parse(gunzipSync(r.content).toString('utf8')) as unknown;
    const list = Array.isArray(value) ? value : value && typeof value === 'object' ? Object.values(value as Record<string, unknown>).find(Array.isArray) : undefined;
    if (Array.isArray(list)) {
      const items = list.slice(offset, offset + limit);
      const next = offset + items.length < list.length ? offset + items.length : null;
      return { items, offset, total: list.length, next_offset: next };
    }
    const text = JSON.stringify(value);
    const chunk = limit * 200;
    const part = text.slice(offset, offset + chunk);
    return { text: part, offset, total: text.length, next_offset: offset + part.length < text.length ? offset + part.length : null };
  }
}
