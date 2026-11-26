import type { Kysely, Selectable } from 'kysely';
import type { Role } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { Config } from '../../kernel/config/load.js';
import type { MainDB, UsersTable } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';

export type UserRowDb = Selectable<UsersTable>;

export const LOCAL_ADMIN_EMAIL = 'admin@localhost';

/** Users (roles admin | viewer, A28; ADAPT Hub identity/users.service.ts). */
export class UsersService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
    private readonly config: Config,
  ) {}

  bootstrapEmail(): string {
    return (this.config.env.BOOTSTRAP_ADMIN_EMAIL ?? LOCAL_ADMIN_EMAIL).toLowerCase();
  }

  /** First admin (§13.1): BOOTSTRAP_ADMIN_EMAIL, else `admin@localhost` for the local sign-in link. */
  async ensureBootstrapAdmin(): Promise<UserRowDb> {
    const email = this.bootstrapEmail();
    const existing = await this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    if (existing) {
      if (existing.role !== 'admin') await this.db.updateTable('users').set({ role: 'admin', role_source: 'bootstrap', updated_at: this.clock.now() }).where('id', '=', existing.id).execute();
      return (await this.db.selectFrom('users').selectAll().where('id', '=', existing.id).executeTakeFirst())!;
    }
    const now = this.clock.now();
    const id = newId();
    await this.db.insertInto('users').values({ id, email, name: email === LOCAL_ADMIN_EMAIL ? 'Local admin' : email.split('@')[0]!, role: 'admin', role_source: 'bootstrap', created_at: now, updated_at: now }).execute();
    return (await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst())!;
  }

  async get(id: string): Promise<UserRowDb> {
    const u = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!u) throw AppError.notFound('User');
    return u;
  }

  async upsertOidc(p: { email: string; name: string; issuer: string; subject: string; role: Role }): Promise<UserRowDb> {
    const now = this.clock.now();
    const email = p.email.toLowerCase();
    const existing = await this.db.selectFrom('users').selectAll().where((eb) => eb.or([eb('email', '=', email), eb.and([eb('oidc_issuer', '=', p.issuer), eb('oidc_subject', '=', p.subject)])])).executeTakeFirst();
    const role: Role = email === this.bootstrapEmail() ? 'admin' : p.role;
    if (existing) {
      const keepLocal = existing.role_source === 'local' || existing.role_source === 'bootstrap';
      await this.db.updateTable('users').set({ name: p.name || existing.name, oidc_issuer: p.issuer, oidc_subject: p.subject, last_login_at: now, updated_at: now, ...(keepLocal ? {} : { role, role_source: 'oidc' }) }).where('id', '=', existing.id).execute();
      return this.get(existing.id);
    }
    const id = newId();
    await this.db.insertInto('users').values({ id, email, name: p.name, oidc_issuer: p.issuer, oidc_subject: p.subject, role, role_source: email === this.bootstrapEmail() ? 'bootstrap' : 'oidc', last_login_at: now, created_at: now, updated_at: now }).execute();
    return this.get(id);
  }

  async list(): Promise<UserRowDb[]> {
    return this.db.selectFrom('users').selectAll().orderBy('email').execute();
  }

  async update(id: string, patch: { role?: Role; status?: 'active' | 'disabled' }, by: string | null): Promise<UserRowDb> {
    const u = await this.get(id);
    if ((patch.role === 'viewer' || patch.status === 'disabled') && u.role === 'admin') {
      const admins = await this.db.selectFrom('users').select((eb) => eb.fn.countAll<number>().as('n')).where('role', '=', 'admin').where('status', '=', 'active').executeTakeFirst();
      if (Number(admins?.n ?? 0) <= 1) throw AppError.conflict('Cannot remove the last admin');
    }
    await this.db.updateTable('users').set({ ...(patch.role ? { role: patch.role, role_source: 'local' as const } : {}), ...(patch.status ? { status: patch.status } : {}), updated_at: this.clock.now() }).where('id', '=', id).execute();
    this.audit.admin({ actorUserId: by, action: 'user.update', targetType: 'user', targetId: id, before: { role: u.role, status: u.status }, after: patch });
    return this.get(id);
  }
}
