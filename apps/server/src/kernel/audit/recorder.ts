import type { Logger } from 'pino';
import type { AuditDecision, AuditStatus } from '@neurouter/shared';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { INSTANCE_SCOPE_ID } from '../tenancy/index.js';
import type { AuditEventInput, AuditStore } from './store.js';

export interface AdminAuditInput {
  /** Owning tenant (spec §4.5, G15). Null only for platform events (filed under INSTANCE_SCOPE_ID). */
  tenantId: string | null;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  /** Server the change belongs to (owner-scoped audit). Derived for server/tool/grant targets when omitted. */
  serverId?: string | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AuthAuditInput {
  /** Owning tenant (spec §4.5, G15). Null only for platform events (filed under INSTANCE_SCOPE_ID). */
  tenantId: string | null;
  userId: string | null;
  action: string;
  decision?: AuditDecision;
  status?: AuditStatus;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Producer-side facade over AuditStore (non-blocking). `record()` returns false when the store
 * refused the event (queue full with `auditFailClosed`); the gateway checks `canAccept()` before
 * a tool call and fails closed (backend §9.1).
 */
export class AuditRecorder {
  constructor(
    private readonly store: AuditStore,
    private readonly clock: Clock,
    private readonly log: Pick<Logger, 'debug' | 'warn'>,
  ) {}

  /** Returns false when the store refused the event (queue full, fail-closed). */
  record(event: Omit<AuditEventInput, 'id' | 'ts'> & { id?: string; ts?: number }): boolean {
    const full: AuditEventInput = { ...event, id: event.id ?? newId(), ts: event.ts ?? this.clock.now() };
    try {
      return this.store.record(full);
    } catch (err) {
      this.log.warn({ err }, 'audit record failed');
      return false;
    }
  }

  /** False when tool calls must fail closed because audit can't be persisted. */
  canAccept(): boolean {
    return this.store.canAccept();
  }

  admin(e: AdminAuditInput): void {
    this.record({
      kind: 'admin_action',
      tenantId: e.tenantId ?? INSTANCE_SCOPE_ID,
      userId: e.actorUserId,
      action: e.action,
      targetType: e.targetType,
      targetId: e.targetId,
      serverId: e.serverId ?? (e.targetType === 'server' ? e.targetId : null),
      decision: 'allowed',
      status: 'ok',
      changes: e.before === undefined && e.after === undefined ? null : { before: e.before ?? null, after: e.after ?? null },
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
    });
  }

  auth(e: AuthAuditInput): void {
    this.record({
      kind: 'auth_event',
      tenantId: e.tenantId ?? INSTANCE_SCOPE_ID,
      userId: e.userId,
      action: e.action,
      decision: e.decision ?? 'allowed',
      status: e.status ?? 'ok',
      decisionReason: e.reason ?? null,
      ip: e.ip ?? null,
      userAgent: e.userAgent ?? null,
    });
  }

  /** `tenantId` null = platform event (INSTANCE_SCOPE_ID). */
  system(tenantId: string | null, action: string, details: { targetType?: string; targetId?: string; reason?: string; changes?: unknown; kind?: 'config_apply' | 'eval_run' | 'admin_action' } = {}): void {
    this.record({
      kind: details.kind ?? 'admin_action',
      tenantId: tenantId ?? INSTANCE_SCOPE_ID,
      action,
      targetType: details.targetType ?? null,
      targetId: details.targetId ?? null,
      decision: 'allowed',
      status: 'ok',
      decisionReason: details.reason ?? null,
      changes: details.changes === undefined ? null : { before: null, after: details.changes },
    });
  }
}
