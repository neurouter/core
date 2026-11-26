import type { Kysely } from 'kysely';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { randomToken, sha256 } from '../../kernel/lib/crypto.js';
import type { UsersService } from '../users/users.service.js';

export const LOCAL_LINK_TTL_MS = 15 * 60_000;

/**
 * Jupyter-style one-time console sign-in link (§13.1, NEW): a single-use 15-minute token for the
 * bootstrap admin, printed as `PUBLIC_URL/auth/link#t=<token>`. Only someone with database access
 * (the CLI `console-link`, or the server log on first start) can mint one.
 */
export class LocalLinkService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly users: UsersService,
    private readonly audit: AuditRecorder,
    private readonly publicUrl: string,
  ) {}

  async create(): Promise<{ url: string; token: string; expiresAt: number; userId: string }> {
    const user = await this.users.ensureBootstrapAdmin();
    const token = randomToken(32);
    const now = this.clock.now();
    const expiresAt = now + LOCAL_LINK_TTL_MS;
    await this.db.insertInto('local_links').values({ token_hash: sha256(token), user_id: user.id, expires_at: expiresAt, used_at: null, created_at: now }).execute();
    this.audit.auth({ tenantId: user.tenant_id, userId: user.id, action: 'auth.local_link.create' });
    return { url: `${this.publicUrl}/auth/link#t=${token}`, token, expiresAt, userId: user.id };
  }

  /** Consumes a token: the user id when valid (unused, unexpired), else null. */
  async consume(token: string): Promise<string | null> {
    const hash = sha256(token);
    const now = this.clock.now();
    const res = await this.db.updateTable('local_links').set({ used_at: now }).where('token_hash', '=', hash).where('used_at', 'is', null).where('expires_at', '>', now).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) return null;
    const row = await this.db.selectFrom('local_links').select('user_id').where('token_hash', '=', hash).executeTakeFirst();
    return row?.user_id ?? null;
  }
}
