import type { Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import { genesisPrev, hashRow, verifyCheckpointMac, type CheckpointKind } from './chain.js';
import type { AuditVerifyOutcome, BrokenReason } from './types.js';
import { legacyChainEnd } from './writer.js';

export interface VerifyDeps {
  db: Kysely<AuditDB>;
  installId: string;
  /** MAC key for a checkpoint key id (null when that key is no longer configured). */
  macKeyFor: (keyId: string) => Buffer | null;
  pageSize?: number;
  onProgress?: (checked: number) => void | Promise<void>;
}

type Range = { fromSeq?: number; toSeq?: number };
const EMPTY: AuditVerifyOutcome = { ok: true, checked: 0, firstSeq: null, lastSeq: null, checkpointsVerified: 0, brokenAt: null };

/**
 * Verifies one tenant's audit trail (multi-tenancy spec §4.5): its own hash chain (rows written
 * since per-tenant chains, each linked to the tenant's previous row) and, with `includeLegacy`, the
 * legacy instance-wide chain the rows of a single-tenant install were written in before (0015).
 */
export async function verifyTenant(d: VerifyDeps, tenantId: string, range: Range = {}, opts: { includeLegacy?: boolean } = {}): Promise<AuditVerifyOutcome> {
  const legacy = await legacyChainEnd(d.db);
  const parts: AuditVerifyOutcome[] = [];
  if (opts.includeLegacy && legacy.seq > 0 && (range.fromSeq ?? 0) <= legacy.seq) {
    const out = await verifyLegacyChain(d, legacy, range);
    if (!out.ok) return out;
    parts.push(out);
  }
  parts.push(await verifyTenantChain(d, tenantId, legacy.seq, range, parts[0]?.checked ?? 0));
  return merge(parts);
}

function merge(parts: AuditVerifyOutcome[]): AuditVerifyOutcome {
  const seen = parts.filter((p) => p.firstSeq !== null);
  const bad = parts.find((p) => !p.ok);
  return {
    ok: !bad,
    checked: parts.reduce((n, p) => n + p.checked, 0),
    firstSeq: seen.length ? Math.min(...seen.map((p) => p.firstSeq!)) : null,
    lastSeq: seen.length ? Math.max(...seen.map((p) => p.lastSeq!)) : null,
    checkpointsVerified: parts.reduce((n, p) => n + p.checkpointsVerified, 0),
    brokenAt: bad?.brokenAt ?? null,
  };
}

/**
 * One tenant's chain: rows of the tenant after the legacy chain, streamed by `seq` in pages; each
 * row's `prev_hash` must be the previous tenant row's hash (the first retained row links to the
 * tenant's genesis or to its latest `retention_cut` checkpoint), every hash is recomputed, every
 * checkpoint of the tenant in range must have a valid MAC and match its row, and without an upper
 * bound the last row must be the chain head (tail deletion).
 */
export async function verifyTenantChain(d: VerifyDeps, tenantId: string, legacySeq: number, range: Range = {}, checkedBefore = 0): Promise<AuditVerifyOutcome> {
  const pageSize = d.pageSize ?? 5000;
  const rows = () => d.db.selectFrom('audit_log').where('tenant_id', '=', tenantId).where('seq', '>', legacySeq);
  const minRow = await rows().select('seq').orderBy('seq', 'asc').limit(1).executeTakeFirst();
  const maxRow = await rows().select('seq').orderBy('seq', 'desc').limit(1).executeTakeFirst();
  const head = await d.db.selectFrom('audit_chain_heads').select(['seq', 'hash']).where('tenant_id', '=', tenantId).executeTakeFirst();
  const cpBase = () => d.db.selectFrom('audit_checkpoints').selectAll().where('tenant_id', '=', tenantId);
  const fail = (seq: number, eventId: string | null, reason: BrokenReason, expected: string | null, actual: string | null, checked: number, n: number, from: number | null, to: number | null): AuditVerifyOutcome => ({
    ok: false, checked, firstSeq: from, lastSeq: to, checkpointsVerified: n, brokenAt: { seq, eventId, reason, expected, actual },
  });

  if (!minRow || !maxRow) {
    // nothing retained: the head (if any) must be anchored by a retention cut, else rows were deleted
    if (head && range.toSeq === undefined && range.fromSeq === undefined) {
      const cut = await d.db.selectFrom('audit_checkpoints').select('hash').where('tenant_id', '=', tenantId).where('kind', '=', 'retention_cut').where('seq', '=', Number(head.seq)).executeTakeFirst();
      if (!cut || cut.hash !== head.hash) return fail(Number(head.seq), null, 'gap', head.hash, null, 0, 0, null, null);
    }
    return EMPTY;
  }
  const earliest = Number(minRow.seq);
  const from = Math.max(range.fromSeq ?? earliest, earliest);
  const to = Math.min(range.toSeq ?? Number(maxRow.seq), Number(maxRow.seq));
  if (to < from) return EMPTY;

  // the expected prev_hash of the first row in range
  let expectedPrev: string | null;
  const first = await rows().select(['seq', 'id', 'prev_hash']).where('seq', '>=', from).orderBy('seq', 'asc').limit(1).executeTakeFirst();
  if (!first) return EMPTY;
  const before = await rows().select('hash').where('seq', '<', Number(first.seq)).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (before) expectedPrev = before.hash;
  else {
    const genesis = genesisPrev(d.installId, tenantId);
    if (first.prev_hash === genesis) expectedPrev = genesis;
    else {
      const cut = await d.db.selectFrom('audit_checkpoints').selectAll().where('tenant_id', '=', tenantId).where('kind', '=', 'retention_cut').where('seq', '<', Number(first.seq)).orderBy('seq', 'desc').limit(1).executeTakeFirst();
      if (!cut || cut.hash !== first.prev_hash) return fail(Number(first.seq), first.id, 'broken_link', cut?.hash ?? genesis, first.prev_hash, 0, 0, from, to);
      const key = d.macKeyFor(cut.key_id);
      if (!key || !verifyCheckpointMac(key, { seq: Number(cut.seq), hash: cut.hash, kind: cut.kind as CheckpointKind, mac: cut.mac, tenantId })) return fail(Number(first.seq), first.id, 'bad_checkpoint_mac', null, cut.mac, 0, 0, from, to);
      expectedPrev = cut.hash;
    }
  }

  const checkpoints = (await cpBase().where('seq', '>=', from).where('seq', '<=', to).orderBy('seq', 'asc').execute()).map((c) => ({ ...c, seq: Number(c.seq) }));
  let cpIdx = 0;
  let cpsVerified = 0;
  let checked = 0;
  let lastHash: string | null = null;
  let lastSeq = from - 1;
  let cursor = from - 1;
  for (;;) {
    const page = await rows().selectAll().where('seq', '>', cursor).where('seq', '<=', to).orderBy('seq', 'asc').limit(pageSize).execute();
    if (!page.length) break;
    for (const r of page) {
      const seq = Number(r.seq);
      // a checkpoint at a seq the tenant has no row for: that row was deleted
      if (cpIdx < checkpoints.length && checkpoints[cpIdx]!.seq < seq) return fail(checkpoints[cpIdx]!.seq, null, 'gap', checkpoints[cpIdx]!.hash, null, checked, cpsVerified, from, to);
      if (r.prev_hash !== expectedPrev) return fail(seq, r.id, 'broken_link', expectedPrev, r.prev_hash, checked, cpsVerified, from, to);
      const recomputed = hashRow(r.prev_hash, r as unknown as Record<string, unknown>);
      if (recomputed !== r.hash) return fail(seq, r.id, 'hash_mismatch', recomputed, r.hash, checked, cpsVerified, from, to);
      while (cpIdx < checkpoints.length && checkpoints[cpIdx]!.seq === seq) {
        const cp = checkpoints[cpIdx++]!;
        const key = d.macKeyFor(cp.key_id);
        if (!key || !verifyCheckpointMac(key, { seq: cp.seq, hash: cp.hash, kind: cp.kind as CheckpointKind, mac: cp.mac, tenantId })) return fail(seq, r.id, 'bad_checkpoint_mac', null, cp.mac, checked, cpsVerified, from, to);
        if (cp.hash !== r.hash) return fail(seq, r.id, 'checkpoint_mismatch', cp.hash, r.hash, checked, cpsVerified, from, to);
        cpsVerified++;
      }
      expectedPrev = r.hash;
      lastHash = r.hash;
      lastSeq = seq;
      checked++;
    }
    cursor = Number(page[page.length - 1]!.seq);
    await d.onProgress?.(checkedBefore + checked);
    if (page.length < pageSize) break;
  }
  if (cpIdx < checkpoints.length) return fail(checkpoints[cpIdx]!.seq, null, 'gap', checkpoints[cpIdx]!.hash, null, checked, cpsVerified, from, to);
  if (range.toSeq === undefined) {
    // tail deletion: the chain head (moved in every write transaction) or a later checkpoint names a row that is gone
    if (head && (Number(head.seq) !== lastSeq || head.hash !== lastHash)) return fail(lastSeq + 1, null, 'gap', head.hash, lastHash, checked, cpsVerified, from, to);
    const beyond = await cpBase().select(['seq']).where('seq', '>', to).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    if (beyond) return fail(to + 1, null, 'gap', String(Number(beyond.seq)), String(to), checked, cpsVerified, from, to);
  }
  return { ok: true, checked, firstSeq: from, lastSeq: to, checkpointsVerified: cpsVerified, brokenAt: null };
}

/**
 * The legacy instance-wide chain (backend §9.4; rows up to the seq recorded by migration 0015): rows
 * are streamed by `seq` and checked for contiguity, `prev_hash` linkage and recomputed hashes; every
 * legacy checkpoint in range must have a valid MAC and match the row hash at its seq; the earliest
 * retained row must link to genesis (seq 1) or to a `retention_cut` checkpoint.
 */
export async function verifyLegacyChain(d: VerifyDeps, legacy: { seq: number; hash: string }, range: Range = {}): Promise<AuditVerifyOutcome> {
  const pageSize = d.pageSize ?? 5000;
  // tenant-scope: system-job (the legacy chain spans the rows of a single-tenant install)
  const minRow = await d.db.selectFrom('audit_log').select('seq').where('seq', '<=', legacy.seq).orderBy('seq', 'asc').limit(1).executeTakeFirst();
  // tenant-scope: system-job (the legacy chain spans the rows of a single-tenant install)
  const maxRow = await d.db.selectFrom('audit_log').select(['seq', 'hash']).where('seq', '<=', legacy.seq).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (!minRow || !maxRow) return EMPTY;
  const earliest = Number(minRow.seq);
  const from = Math.max(range.fromSeq ?? earliest, earliest);
  const to = Math.min(range.toSeq ?? Number(maxRow.seq), Number(maxRow.seq));
  if (to < from) return EMPTY;

  const fail = (seq: number, eventId: string | null, reason: BrokenReason, expected: string | null, actual: string | null, checked: number, cps: number): AuditVerifyOutcome => ({
    ok: false, checked, firstSeq: from, lastSeq: to, checkpointsVerified: cps, brokenAt: { seq, eventId, reason, expected, actual },
  });
  const legacyCps = () => d.db.selectFrom('audit_checkpoints').where('tenant_id', 'is', null);

  let expectedPrev: string | null;
  if (from === earliest) {
    if (from === 1) expectedPrev = genesisPrev(d.installId);
    else {
      const cut = await legacyCps().select(['hash']).where('seq', '=', from - 1).where('kind', '=', 'retention_cut').orderBy('created_at', 'desc').executeTakeFirst();
      expectedPrev = cut?.hash ?? null;
      if (expectedPrev === null) {
        // tenant-scope: system-job (the legacy chain spans the rows of a single-tenant install)
        const first = await d.db.selectFrom('audit_log').select(['id', 'prev_hash']).where('seq', '=', from).executeTakeFirst();
        return fail(from, first?.id ?? null, 'broken_link', null, first?.prev_hash ?? null, 0, 0);
      }
    }
  } else {
    // tenant-scope: system-job (the legacy chain spans the rows of a single-tenant install)
    const before = await d.db.selectFrom('audit_log').select('hash').where('seq', '=', from - 1).executeTakeFirst();
    expectedPrev = before?.hash ?? null; // null → the row before is missing: reported as a gap below
  }

  const checkpoints = (await legacyCps().selectAll().where('seq', '>=', from).where('seq', '<=', to).orderBy('seq', 'asc').execute()).map((c) => ({ ...c, seq: Number(c.seq) }));
  let cpIdx = 0;
  let cpsVerified = 0;
  let checked = 0;
  let nextSeq = from;
  let cursor = from - 1;
  for (;;) {
    // tenant-scope: system-job (the legacy chain spans the rows of a single-tenant install)
    const rows = await d.db.selectFrom('audit_log').selectAll().where('seq', '>', cursor).where('seq', '<=', to).orderBy('seq', 'asc').limit(pageSize).execute();
    if (!rows.length) break;
    for (const r of rows) {
      const seq = Number(r.seq);
      if (seq !== nextSeq) return fail(nextSeq, null, 'gap', String(nextSeq), String(seq), checked, cpsVerified);
      if (expectedPrev === null) return fail(seq, r.id, 'gap', String(seq - 1), null, checked, cpsVerified);
      if (r.prev_hash !== expectedPrev) return fail(seq, r.id, 'broken_link', expectedPrev, r.prev_hash, checked, cpsVerified);
      const recomputed = hashRow(r.prev_hash, r as unknown as Record<string, unknown>);
      if (recomputed !== r.hash) return fail(seq, r.id, 'hash_mismatch', recomputed, r.hash, checked, cpsVerified);
      while (cpIdx < checkpoints.length && checkpoints[cpIdx]!.seq <= seq) {
        const cp = checkpoints[cpIdx]!;
        cpIdx++;
        if (cp.seq < seq) continue; // seq not present in range (handled as gap above)
        const key = d.macKeyFor(cp.key_id);
        if (!key || !verifyCheckpointMac(key, { seq: cp.seq, hash: cp.hash, kind: cp.kind as CheckpointKind, mac: cp.mac })) return fail(seq, r.id, 'bad_checkpoint_mac', null, cp.mac, checked, cpsVerified);
        if (cp.hash !== r.hash) return fail(seq, r.id, 'checkpoint_mismatch', cp.hash, r.hash, checked, cpsVerified);
        cpsVerified++;
      }
      expectedPrev = r.hash;
      nextSeq = seq + 1;
      checked++;
    }
    cursor = Number(rows[rows.length - 1]!.seq);
    await d.onProgress?.(checked);
    if (rows.length < pageSize) break;
  }
  if (nextSeq <= to) return fail(nextSeq, null, 'gap', String(nextSeq), null, checked, cpsVerified);
  // tail deletion: the legacy chain ends exactly at the head 0015 recorded
  if (range.toSeq === undefined && (Number(maxRow.seq) !== legacy.seq || maxRow.hash !== legacy.hash)) return fail(Number(maxRow.seq) + 1, null, 'gap', legacy.hash, maxRow.hash, checked, cpsVerified);
  return { ok: true, checked, firstSeq: from, lastSeq: to, checkpointsVerified: cpsVerified, brokenAt: null };
}
