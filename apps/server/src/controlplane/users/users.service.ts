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
const GOOGLE_ISSUER = 'https://accounts.google.com';

/** A member of one tenant: the global user row plus the membership (multi-tenancy spec §2.2). */
export interface MemberRowDb {
  id: string;
  email: string;
  name: string;
  role: Role;
  role_source: 'local' | 'oidc' | 'bootstrap' | 'invite';
  status: 'active' | 'disabled';
  last_login_at: number | null;
  created_at: number;
}

/** `users.role` keeps the home role for a rollback to 0.3.x (which only knows admin | viewer). */
const legacyRole = (r: Role): 'admin' | 'viewer' => (r === 'viewer' ? 'viewer' : 'admin');

/**
 * Users and memberships (ADAPT Hub identity/users.service.ts). A user is a global identity; their
 * access to a tenant is a membership with a role (owner | admin | viewer). The deprecated
 * `users.tenant_id` / `users.role` / `users.role_source` columns are still written as the home
 * tenant and home role, so a 0.3.x binary keeps working after a rollback.
 */
export class UsersService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly clock: Clock,
    private readonly audit: AuditRecorder,
    private readonly config: Config,
    /** The tenant instance-level sign-ins join (OSS: the only tenant); null on a deployment without one. */
    private readonly homeTenant: () => Promise<string | null>,
    /**
     * Single-tenant deployments add a first-time OIDC user to the home tenant (today's behaviour);
     * multi-tenant ones don't (users join through invites or create their own organization).
     */
    private readonly autoJoin: boolean = true,
  ) {}

  private async home(): Promise<string> {
    const t = await this.homeTenant();
    if (!t) throw new Error('this deployment has no default tenant for new users');
    return t;
  }

  bootstrapEmail(): string {
    return (this.config.env.BOOTSTRAP_ADMIN_EMAIL ?? LOCAL_ADMIN_EMAIL).toLowerCase();
  }

  /** Creates or updates a membership (`role_source` records why the user has it). */
  async upsertMembership(tenantId: string, userId: string, role: Role, source: MemberRowDb['role_source'], opts: { invitedBy?: string | null; keepHigher?: boolean; reactivate?: boolean } = {}): Promise<void> {
    const now = this.clock.now();
    const existing = await this.db.selectFrom('memberships').select(['role', 'status']).where('tenant_id', '=', tenantId).where('user_id', '=', userId).executeTakeFirst();
    if (!existing) {
      await this.db.insertInto('memberships').values({ tenant_id: tenantId, user_id: userId, role, role_source: source, status: 'active', invited_by: opts.invitedBy ?? null, created_at: now, updated_at: now }).execute();
      return;
    }
    const rank = { viewer: 0, admin: 1, owner: 2 } as const;
    const nextRole = opts.keepHigher && rank[existing.role] >= rank[role] ? existing.role : role;
    await this.db
      .updateTable('memberships')
      .set({ role: nextRole, ...(nextRole !== existing.role ? { role_source: source } : {}), ...(opts.reactivate ? { status: 'active' as const } : {}), updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', userId)
      .execute();
  }

  /**
   * Boot-time first admin. With BOOTSTRAP_ADMIN_EMAIL: that user is the home tenant's owner (as
   * `ensureBootstrapAdmin`). Without it, the local `admin@localhost` is created only on a database
   * whose home tenant has no active owner yet (a fresh install, so the local sign-in link has someone
   * to sign in as): never next to real owners, e.g. when the CLI boots against a deployment's database.
   */
  async ensureBootstrapAdminOnBoot(): Promise<void> {
    if (!this.config.env.BOOTSTRAP_ADMIN_EMAIL) {
      const owner = await this.db.selectFrom('memberships').select('user_id').where('tenant_id', '=', await this.home()).where('role', '=', 'owner').where('status', '=', 'active').executeTakeFirst();
      if (owner) return;
    }
    await this.ensureBootstrapAdmin();
  }

  /**
   * The user an operator-created API key belongs to (`neurouter keys create`): `email` when it is an
   * active owner or admin of the tenant, else its oldest active owner, else its oldest active admin.
   * Never creates a user.
   */
  async keyOwner(tenantId: string, email?: string): Promise<UserRowDb | null> {
    let q = this.db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id as id', 'm.role as memberRole'])
      .where('m.tenant_id', '=', tenantId)
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .where('m.role', 'in', ['owner', 'admin']);
    if (email) q = q.where('u.email', '=', email.toLowerCase());
    const rows = await q.orderBy('m.created_at').orderBy('u.id').execute();
    const pick = rows.find((r) => r.memberRole === 'owner') ?? rows[0];
    return pick ? this.get(pick.id) : null;
  }

  /** First admin (§13.1): BOOTSTRAP_ADMIN_EMAIL, else `admin@localhost` for the local sign-in link. Owner of the home tenant. */
  async ensureBootstrapAdmin(): Promise<UserRowDb> {
    const email = this.bootstrapEmail();
    const home = await this.home();
    const existing = await this.db.selectFrom('users').selectAll().where('email', '=', email).executeTakeFirst();
    let id: string;
    if (existing) {
      id = existing.id;
      if (existing.role !== 'admin') await this.db.updateTable('users').set({ role: 'admin', role_source: 'bootstrap', updated_at: this.clock.now() }).where('id', '=', existing.id).execute();
    } else {
      const now = this.clock.now();
      id = newId();
      await this.db.insertInto('users').values({ id, tenant_id: home, email, name: email === LOCAL_ADMIN_EMAIL ? 'Local admin' : email.split('@')[0]!, role: 'admin', role_source: 'bootstrap', created_at: now, updated_at: now }).execute();
    }
    await this.upsertMembership(home, id, 'owner', 'bootstrap', { reactivate: true });
    return (await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst())!;
  }

  async get(id: string): Promise<UserRowDb> {
    const u = await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
    if (!u) throw AppError.notFound('User');
    return u;
  }

  /**
   * OIDC sign-in (§13.1): the user is found by identity `(provider, subject)`, else by email, and the
   * identity is recorded (verified email). A first-time user of a single-tenant deployment joins the
   * home tenant with the role from claims; the bootstrap email is the home tenant's owner. Existing
   * OIDC-sourced memberships follow the claims; local, bootstrap and invite roles are kept.
   */
  async upsertOidc(p: { email: string; name: string; issuer: string; subject: string; role: Role }): Promise<UserRowDb> {
    const now = this.clock.now();
    const email = p.email.toLowerCase();
    const homeTenant = await this.homeTenant();
    const provider = p.issuer === GOOGLE_ISSUER ? 'google' : `oidc:${homeTenant ?? 'instance'}`;
    const ident = await this.db.selectFrom('user_identities').select('user_id').where('provider', '=', provider).where('subject', '=', p.subject).executeTakeFirst();
    const existing = ident
      ? await this.db.selectFrom('users').selectAll().where('id', '=', ident.user_id).executeTakeFirst()
      : await this.db.selectFrom('users').selectAll().where((eb) => eb.or([eb('email', '=', email), eb.and([eb('oidc_issuer', '=', p.issuer), eb('oidc_subject', '=', p.subject)])])).executeTakeFirst();
    const bootstrap = email === this.bootstrapEmail();
    let id: string;
    if (existing) {
      id = existing.id;
      const keepLocal = existing.role_source === 'local' || existing.role_source === 'bootstrap';
      const homeRole = bootstrap ? 'admin' : legacyRole(p.role);
      await this.db
        .updateTable('users')
        .set({ name: p.name || existing.name, oidc_issuer: p.issuer, oidc_subject: p.subject, last_login_at: now, updated_at: now, ...(keepLocal ? {} : { role: homeRole, role_source: 'oidc' as const }) })
        .where('id', '=', existing.id)
        .execute();
      // claims keep driving OIDC-sourced memberships of the home tenant (owners stay owners)
      if (homeTenant) {
        const m = await this.db.selectFrom('memberships').select(['role', 'role_source']).where('tenant_id', '=', homeTenant).where('user_id', '=', id).executeTakeFirst();
        if (bootstrap) await this.upsertMembership(homeTenant, id, 'owner', 'bootstrap', { reactivate: false });
        else if (m && m.role_source === 'oidc' && m.role !== 'owner' && m.role !== p.role) await this.upsertMembership(homeTenant, id, p.role, 'oidc');
      }
    } else {
      id = newId();
      const tenantCol = homeTenant ?? (await this.home());
      await this.db
        .insertInto('users')
        .values({ id, tenant_id: tenantCol, email, name: p.name, oidc_issuer: p.issuer, oidc_subject: p.subject, role: bootstrap ? 'admin' : legacyRole(p.role), role_source: bootstrap ? 'bootstrap' : 'oidc', last_login_at: now, created_at: now, updated_at: now })
        .execute();
      if (homeTenant && (this.autoJoin || bootstrap)) await this.upsertMembership(homeTenant, id, bootstrap ? 'owner' : p.role, bootstrap ? 'bootstrap' : 'oidc');
    }
    await this.db
      .insertInto('user_identities')
      .values({ id: newId(), user_id: id, provider, subject: p.subject, email, email_verified: 1, created_at: now, last_login_at: now })
      .onConflict((oc) => oc.columns(['provider', 'subject']).doUpdateSet({ email, email_verified: 1, last_login_at: now }))
      .execute();
    return this.get(id);
  }

  /** Verified emails of a user (identities); invites are accepted against these (spec §2.4). */
  async verifiedEmails(userId: string): Promise<string[]> {
    const rows = await this.db.selectFrom('user_identities').select('email').where('user_id', '=', userId).where('email_verified', '=', 1).execute();
    return [...new Set(rows.map((r) => r.email.toLowerCase()))];
  }

  private members(tenantId: string) {
    return this.db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select(['u.id', 'u.email', 'u.name', 'm.role', 'm.role_source', 'u.last_login_at', 'm.created_at'])
      .select((eb) => eb.case().when('u.status', '=', 'disabled').then('disabled').else(eb.ref('m.status')).end().as('status'))
      .where('m.tenant_id', '=', tenantId);
  }

  /** Members of one tenant (spec §4.9 G7: never every tenant's users), by email. */
  async list(tenantId: string, opts: { q?: string; afterEmail?: string; limit?: number } = {}): Promise<MemberRowDb[]> {
    let qb = this.members(tenantId).where('u.email', '!=', 'anonymous@demo.invalid');
    if (opts.q) qb = qb.where((eb) => eb.or([eb('u.email', 'like', `%${opts.q}%`), eb('u.name', 'like', `%${opts.q}%`)]));
    if (opts.afterEmail) qb = qb.where('u.email', '>', opts.afterEmail);
    const rows = await qb.orderBy('u.email').limit(opts.limit ?? 1000).execute();
    return rows.map((r) => ({ ...r, status: r.status as MemberRowDb['status'], last_login_at: r.last_login_at === null ? null : Number(r.last_login_at), created_at: Number(r.created_at) }));
  }

  /** A member of `tenantId` (another tenant's user id reads as not found). */
  async getIn(tenantId: string, id: string): Promise<MemberRowDb> {
    const r = await this.members(tenantId).where('u.id', '=', id).executeTakeFirst();
    if (!r) throw AppError.notFound('Member');
    return { ...r, status: r.status as MemberRowDb['status'], last_login_at: r.last_login_at === null ? null : Number(r.last_login_at), created_at: Number(r.created_at) };
  }

  private async activeOwners(tenantId: string): Promise<number> {
    const r = await this.db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .where('m.tenant_id', '=', tenantId)
      .where('m.role', '=', 'owner')
      .where('m.status', '=', 'active')
      .where('u.status', '=', 'active')
      .executeTakeFirst();
    return Number(r?.n ?? 0);
  }

  /** Every tenant keeps at least one active owner (spec §2.1). */
  private async guardLastOwner(tenantId: string, m: MemberRowDb, next: { role?: Role; status?: 'active' | 'disabled'; removed?: boolean }): Promise<void> {
    if (m.role !== 'owner' || m.status !== 'active') return;
    const losesOwner = next.removed || (next.role !== undefined && next.role !== 'owner') || next.status === 'disabled';
    if (losesOwner && (await this.activeOwners(tenantId)) <= 1) throw AppError.conflict('Cannot remove the last owner of the organization');
  }

  async update(tenantId: string, id: string, patch: { role?: Role; status?: 'active' | 'disabled' }, by: string | null): Promise<MemberRowDb> {
    const m = await this.getIn(tenantId, id);
    await this.guardLastOwner(tenantId, m, patch);
    const now = this.clock.now();
    await this.db
      .updateTable('memberships')
      .set({ ...(patch.role ? { role: patch.role, role_source: 'local' as const } : {}), ...(patch.status ? { status: patch.status } : {}), updated_at: now })
      .where('tenant_id', '=', tenantId)
      .where('user_id', '=', id)
      .execute();
    // home tenant: mirror into the deprecated columns (a 0.3.x binary reads users.role / users.status)
    const u = await this.get(id);
    if (u.tenant_id === tenantId && this.autoJoin) {
      await this.db
        .updateTable('users')
        .set({ ...(patch.role ? { role: legacyRole(patch.role), role_source: 'local' as const } : {}), ...(patch.status ? { status: patch.status } : {}), updated_at: now })
        .where('id', '=', id)
        .where('tenant_id', '=', tenantId)
        .execute();
    }
    this.audit.admin({ tenantId, actorUserId: by, action: 'member.update', targetType: 'user', targetId: id, before: { role: m.role, status: m.status }, after: patch });
    return this.getIn(tenantId, id);
  }

  /** Removes the membership (the global user row stays; on a single-tenant deployment the user can't sign in again until invited). */
  async remove(tenantId: string, id: string, by: string | null): Promise<void> {
    const m = await this.getIn(tenantId, id);
    await this.guardLastOwner(tenantId, m, { removed: true });
    await this.db.deleteFrom('memberships').where('tenant_id', '=', tenantId).where('user_id', '=', id).execute();
    this.audit.admin({ tenantId, actorUserId: by, action: 'member.remove', targetType: 'user', targetId: id, before: { role: m.role, status: m.status }, after: null });
  }
}
