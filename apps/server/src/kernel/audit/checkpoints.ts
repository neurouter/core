import type { Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import { newId } from '../lib/ids.js';
import { checkpointMac, LEGACY_CHAIN_ID, type CheckpointKind } from './chain.js';
import type { AuditCheckpoint } from './types.js';

export interface MacSigner {
  keyId: string;
  key: Buffer;
}

export const CHECKPOINT_EVERY_ROWS = 10_000;
export const CHECKPOINT_EVERY_MS = 5 * 60_000;

/**
 * Writes a checkpoint of one chain (multi-tenancy spec §4.5): a tenant's chain at `at`, or at its
 * current head; `tenantId: null` anchors the legacy instance-wide chain (`at` required). Null when
 * the chain has no rows yet.
 */
export async function writeCheckpoint(db: Kysely<AuditDB>, kind: CheckpointKind, signer: MacSigner, now: number, at: { seq: number; hash: string } | undefined, tenantId: string | null): Promise<AuditCheckpoint | null> {
  let target = at;
  if (!target) {
    if (tenantId === null) return null;
    const head = await db.selectFrom('audit_chain_heads').select(['seq', 'hash']).where('tenant_id', '=', tenantId).executeTakeFirst();
    if (!head) return null;
    target = { seq: Number(head.seq), hash: head.hash };
  }
  const cp: AuditCheckpoint = { id: newId(), seq: target.seq, hash: target.hash, kind, mac: checkpointMac(signer.key, target.seq, target.hash, kind, tenantId), keyId: signer.keyId, createdAt: now, tenantId };
  await db.insertInto('audit_checkpoints').values({ id: cp.id, seq: cp.seq, hash: cp.hash, kind, mac: cp.mac, key_id: cp.keyId, created_at: now, tenant_id: tenantId }).execute();
  return cp;
}

/** Checkpoints every tenant chain at its head (`audit.checkpoint` manual run, key rotation). */
export async function checkpointAll(db: Kysely<AuditDB>, kind: CheckpointKind, signer: MacSigner, now: number): Promise<AuditCheckpoint[]> {
  const heads = await db.selectFrom('audit_chain_heads').select(['tenant_id', 'seq', 'hash']).where('tenant_id', '!=', LEGACY_CHAIN_ID).orderBy('seq', 'asc').execute();
  const out: AuditCheckpoint[] = [];
  for (const h of heads) out.push((await writeCheckpoint(db, kind, signer, now, { seq: Number(h.seq), hash: h.hash }, h.tenant_id))!);
  return out;
}

/** Periodic checkpoints (leader job): per tenant chain, every 10,000 entries or 5 minutes, when its head moved. */
export async function maybePeriodicCheckpoint(db: Kysely<AuditDB>, signer: MacSigner, now: number, opts = { everyRows: CHECKPOINT_EVERY_ROWS, everyMs: CHECKPOINT_EVERY_MS }): Promise<AuditCheckpoint[]> {
  const heads = await db.selectFrom('audit_chain_heads').select(['tenant_id', 'seq', 'hash']).where('tenant_id', '!=', LEGACY_CHAIN_ID).execute();
  const lasts = await db
    .selectFrom('audit_checkpoints')
    .select((eb) => ['tenant_id', eb.fn.max('seq').as('seq'), eb.fn.max('created_at').as('created_at')])
    .where('tenant_id', 'is not', null)
    .groupBy('tenant_id')
    .execute();
  const last = new Map(lasts.map((l) => [l.tenant_id!, { seq: Number(l.seq), createdAt: Number(l.created_at) }]));
  const out: AuditCheckpoint[] = [];
  for (const h of heads) {
    const headSeq = Number(h.seq);
    const l = last.get(h.tenant_id);
    if (l && l.seq >= headSeq) continue;
    // "rows since" is counted in global seq (an upper bound of the tenant's own rows; cheap, no count query)
    const due = !l || headSeq - l.seq >= opts.everyRows || now - l.createdAt >= opts.everyMs;
    if (due) out.push((await writeCheckpoint(db, 'periodic', signer, now, { seq: headSeq, hash: h.hash }, h.tenant_id))!);
  }
  return out;
}

export function toCheckpoint(r: { id: string; seq: number; hash: string; kind: CheckpointKind; mac: string; key_id: string; created_at: number; tenant_id?: string | null }): AuditCheckpoint {
  return { id: r.id, seq: Number(r.seq), hash: r.hash, kind: r.kind, mac: r.mac, keyId: r.key_id, createdAt: Number(r.created_at), tenantId: r.tenant_id ?? null };
}
