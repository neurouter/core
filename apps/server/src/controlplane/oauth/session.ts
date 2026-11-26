import type { FastifyRequest } from 'fastify';
import type { Kysely } from 'kysely';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { sha256 } from '../../kernel/lib/crypto.js';

export interface ConsoleSessionUser {
  id: string;
  email: string;
  role: 'admin' | 'viewer';
  /** Session CSRF token (the consent form must echo it). */
  csrfToken: string;
}

/**
 * How the OAuth AS finds the signed-in console user (§13.3: authorization requires a console session).
 * The console's SessionService satisfies this; `DbSessionLookup` is the standalone adapter.
 */
export interface ConsoleSessionLookup {
  userFromRequest(req: FastifyRequest): Promise<ConsoleSessionUser | null>;
  /** Where to send a browser without a session; it returns to `returnTo` after sign-in. */
  loginUrl(returnTo: string): string;
}

/**
 * Reads `web_sessions` by sha256(cookie token), exactly as the console session service stores it
 * (COPY Hub auth/web/sessions.ts). Anonymous demo sessions and disabled users never authorize.
 */
export class DbSessionLookup implements ConsoleSessionLookup {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly cfg: { cookieName: string; idleMs: number },
  ) {}

  async userFromRequest(req: FastifyRequest): Promise<ConsoleSessionUser | null> {
    const token = (req.cookies as Record<string, string | undefined> | undefined)?.[this.cfg.cookieName];
    if (!token || token.length < 20 || token.length > 100) return null;
    const row = await this.db
      .selectFrom('web_sessions as w')
      .innerJoin('users as u', 'u.id', 'w.user_id')
      .select(['w.expires_at', 'w.last_seen_at', 'w.anonymous', 'w.csrf_token', 'u.id', 'u.email', 'u.role', 'u.status'])
      .where('w.id_hash', '=', sha256(token))
      .executeTakeFirst();
    if (!row) return null;
    const now = this.clock.now();
    if (row.expires_at <= now || row.last_seen_at + this.cfg.idleMs <= now) return null;
    if (row.anonymous === 1 || row.status !== 'active') return null;
    return { id: row.id, email: row.email, role: row.role, csrfToken: row.csrf_token };
  }

  loginUrl(returnTo: string): string {
    return `/auth/login?returnTo=${encodeURIComponent(returnTo)}`;
  }
}
