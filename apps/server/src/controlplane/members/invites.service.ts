import type { Kysely } from 'kysely';
import { INVITE_TTL_MS, type InviteRole, type InviteStatus, type Role } from '@neurouter/shared';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Clock } from '../../kernel/lib/clock.js';
import { hmacSha256, randomToken } from '../../kernel/lib/crypto.js';
import { AppError } from '../../kernel/lib/errors.js';
import { newId } from '../../kernel/lib/ids.js';
import type { TenantRef, TenantResolver } from '../../kernel/tenancy/types.js';
import type { UsersService } from '../users/users.service.js';

export interface InviteRowDb {
  id: string;
  email: string;
  role: InviteRole;
  status: InviteStatus;
  invitedBy: { id: string; email: string } | null;
  createdAt: number;
  expiresAt: number;
  acceptedAt: number | null;
}

export interface InvitesDeps {
  db: Kysely<MainDB>;
  clock: Clock;
  audit: AuditRecorder;
  users: UsersService;
  tenancy: Pick<TenantResolver, 'byId' | 'roleOf'>;
  pepper: string;
  publicUrl: string;
}

const statusOf = (r: { accepted_at: number | null; revoked_at: number | null; expires_at: number }, now: number): InviteStatus =>
  r.accepted_at !== null ? 'accepted' : r.revoked_at !== null ? 'revoked' : Number(r.expires_at) <= now ? 'expired' : 'pending';

const invalid = () => AppError.notFound('Invite');

/**
 * Invites (multi-tenancy spec §2.4): a pending membership for an email address, single use, 7-day
 * TTL. The link `PUBLIC_URL/invite#t=<token>` is returned once; only HMAC(HASH_PEPPER, token) is
 * stored. Accepting requires a verified identity email equal to the invite's (403
 * `invite_email_mismatch`). v1 sends no email (decision D6).
 */
export class InvitesService {
  constructor(private readonly d: InvitesDeps) {}

  private hash(token: string): Buffer {
    return hmacSha256(this.d.pepper, token);
  }

  async list(tenantId: string): Promise<InviteRowDb[]> {
    const now = this.d.clock.now();
    const rows = await this.d.db
      .selectFrom('invites as i')
      .leftJoin('users as u', 'u.id', 'i.invited_by')
      .select(['i.id', 'i.email', 'i.role', 'i.created_at', 'i.expires_at', 'i.accepted_at', 'i.revoked_at', 'i.invited_by', 'u.email as inviter_email'])
      .where('i.tenant_id', '=', tenantId)
      .orderBy('i.created_at', 'desc')
      .limit(200)
      .execute();
    const out = rows.map((r) => ({
      id: r.id,
      email: r.email,
      role: r.role,
      status: statusOf(r, now),
      invitedBy: r.invited_by ? { id: r.invited_by, email: r.inviter_email ?? '' } : null,
      createdAt: Number(r.created_at),
      expiresAt: Number(r.expires_at),
      acceptedAt: r.accepted_at === null ? null : Number(r.accepted_at),
    }));
    // pending first, then newest first
    return out.sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || b.createdAt - a.createdAt);
  }

  /** Creates an invite (an older pending invite for the same email is revoked) and returns its link once. */
  async create(tenantId: string, p: { email: string; role: InviteRole }, by: string): Promise<{ invite: InviteRowDb; url: string }> {
    const email = p.email.trim().toLowerCase();
    const member = await this.d.db
      .selectFrom('memberships as m')
      .innerJoin('users as u', 'u.id', 'm.user_id')
      .select('m.status')
      .where('m.tenant_id', '=', tenantId)
      .where('u.email', '=', email)
      .executeTakeFirst();
    if (member?.status === 'active') throw AppError.conflict(`${email} is already a member of this organization`);
    const now = this.d.clock.now();
    await this.d.db.updateTable('invites').set({ revoked_at: now }).where('tenant_id', '=', tenantId).where('email', '=', email).where('accepted_at', 'is', null).where('revoked_at', 'is', null).execute();
    const token = randomToken(32);
    const id = newId();
    await this.d.db.insertInto('invites').values({ id, tenant_id: tenantId, email, role: p.role, token_hash: this.hash(token), invited_by: by, created_at: now, expires_at: now + INVITE_TTL_MS, accepted_at: null, accepted_by: null, revoked_at: null }).execute();
    this.d.audit.auth({ tenantId, userId: by, action: 'auth.invite.create', reason: `${p.role}:${email}` });
    const invite = (await this.list(tenantId)).find((i) => i.id === id)!;
    return { invite, url: `${this.d.publicUrl}/invite#t=${token}` };
  }

  async revoke(tenantId: string, id: string, by: string): Promise<void> {
    const res = await this.d.db.updateTable('invites').set({ revoked_at: this.d.clock.now() }).where('tenant_id', '=', tenantId).where('id', '=', id).where('accepted_at', 'is', null).where('revoked_at', 'is', null).executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw AppError.notFound('Invite');
    this.d.audit.auth({ tenantId, userId: by, action: 'auth.invite.revoke', reason: id });
  }

  /** A pending invite by token, with its (live) tenant; null when unknown, used, revoked or expired. */
  private async pending(token: string): Promise<{ id: string; tenant: TenantRef; email: string; role: InviteRole; expiresAt: number; invitedBy: string | null } | null> {
    // tenant-scope: by-secret-hash (the invite's tenant is taken from the row)
    const r = await this.d.db.selectFrom('invites').selectAll().where('token_hash', '=', this.hash(token)).executeTakeFirst();
    if (!r || statusOf(r, this.d.clock.now()) !== 'pending') return null;
    const tenant = await this.d.tenancy.byId(r.tenant_id);
    if (!tenant || tenant.status !== 'active') return null;
    return { id: r.id, tenant, email: r.email, role: r.role, expiresAt: Number(r.expires_at), invitedBy: r.invited_by };
  }

  async preview(token: string, userId: string): Promise<{ tenant: TenantRef; email: string; role: InviteRole; expiresAt: number; emailMatches: boolean; alreadyMember: boolean }> {
    const inv = await this.pending(token);
    if (!inv) throw invalid();
    const emails = await this.d.users.verifiedEmails(userId);
    return { tenant: inv.tenant, email: inv.email, role: inv.role, expiresAt: inv.expiresAt, emailMatches: emails.includes(inv.email), alreadyMember: (await this.d.tenancy.roleOf(inv.tenant.id, userId)) !== null };
  }

  /**
   * Accepts an invite: the membership is created (or raised to the invite's role, never lowered, and
   * re-activated) and the invite is marked used, once. Every outcome is audited (`auth_event`).
   */
  async accept(token: string, user: { id: string; anonymous: boolean }, meta: { ip?: string | null; userAgent?: string | null } = {}): Promise<{ tenant: TenantRef; role: Role }> {
    const inv = await this.pending(token);
    if (!inv || user.anonymous) {
      this.d.audit.auth({ tenantId: inv?.tenant.id ?? null, userId: user.id, action: 'auth.invite.accept', status: 'blocked', reason: inv ? 'anonymous' : 'invalid_or_used', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
      throw invalid();
    }
    const emails = await this.d.users.verifiedEmails(user.id);
    if (!emails.includes(inv.email)) {
      this.d.audit.auth({ tenantId: inv.tenant.id, userId: user.id, action: 'auth.invite.accept', status: 'blocked', reason: 'invite_email_mismatch', ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
      throw new AppError('forbidden', `This invite was sent to ${inv.email}. Sign in with that account to accept it.`, { extensions: { reason: 'invite_email_mismatch', inviteEmail: inv.email } });
    }
    const now = this.d.clock.now();
    // single use: only one accept can flip the row
    const res = await this.d.db
      .updateTable('invites')
      .set({ accepted_at: now, accepted_by: user.id })
      .where('id', '=', inv.id)
      .where('tenant_id', '=', inv.tenant.id)
      .where('accepted_at', 'is', null)
      .where('revoked_at', 'is', null)
      .where('expires_at', '>', now)
      .executeTakeFirst();
    if (Number(res.numUpdatedRows) !== 1) throw invalid();
    await this.d.users.upsertMembership(inv.tenant.id, user.id, inv.role, 'invite', { invitedBy: inv.invitedBy, keepHigher: true, reactivate: true });
    const role = (await this.d.tenancy.roleOf(inv.tenant.id, user.id)) ?? inv.role;
    this.d.audit.auth({ tenantId: inv.tenant.id, userId: user.id, action: 'auth.invite.accept', reason: role, ip: meta.ip ?? null, userAgent: meta.userAgent ?? null });
    return { tenant: inv.tenant, role };
  }

  /** True when an email has a pending invite somewhere (lets an invited user past the OIDC email-domain allow-list). */
  async hasPendingFor(email: string): Promise<boolean> {
    // tenant-scope: user-scope (invites addressed to the signing-in user's verified email)
    const r = await this.d.db.selectFrom('invites').select('id').where('email', '=', email.toLowerCase()).where('accepted_at', 'is', null).where('revoked_at', 'is', null).where('expires_at', '>', this.d.clock.now()).limit(1).executeTakeFirst();
    return Boolean(r);
  }
}
