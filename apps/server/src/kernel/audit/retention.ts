import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { sql, type Kysely } from 'kysely';
import type { AuditDB } from '../db/schema.js';
import type { Dialect } from '../db/url.js';
import type { ArchiveStore } from './archive/store.js';
import { toCheckpoint, writeCheckpoint, type MacSigner } from './checkpoints.js';
import { legacyChainEnd } from './writer.js';
import { ndjsonLine } from './export.js';
import { DAY_MS, dayStart, droppable, listPartitions } from './partitions.js';
import type { AuditCheckpoint, AuditRow, RetentionOutcome } from './types.js';

export interface RetentionDeps {
  db: Kysely<AuditDB>;
  dialect: Dialect;
  signer: MacSigner;
  now: () => number;
  archive: ArchiveStore | null;
  log: { info(o: object, m: string): void; error(o: object, m: string): void };
  deleteBatch?: number;
}

export interface ArchiveManifest {
  format: 'ndjson+gzip';
  day: string;
  rows: number;
  firstSeq: number;
  lastSeq: number;
  sha256: string;
  bytes: number;
  object: string;
  checkpoint: { seq: number; hash: string; kind: 'retention_cut'; keyId: string; mac: string };
  createdAt: string;
}

const dayKey = (ms: number) => new Date(dayStart(ms)).toISOString().slice(0, 10);

/**
 * Archives every row with `seq ≤ cutSeq` per UTC day as gzip NDJSON plus a manifest carrying
 * the retention_cut checkpoint (approved addendum 3). Throws on the first failed upload.
 */
export async function archiveUpTo(db: Kysely<AuditDB>, archive: ArchiveStore, cutSeq: number, cp: AuditCheckpoint, now: number, pageSize = 5000): Promise<{ days: number; rows: number }> {
  let cursor = 0;
  let current: { day: string; lines: string[]; first: number; last: number } | null = null;
  let days = 0;
  let total = 0;
  const flush = async (c: NonNullable<typeof current>) => {
    const body = gzipSync(Buffer.from(c.lines.join(''), 'utf8'));
    const [y, m, d] = c.day.split('-');
    const base = `audit/${y}/${m}/${d}/audit-${c.day}-${c.first}-${c.last}`;
    const object = `${base}.ndjson.gz`;
    await archive.put(object, body, 'application/gzip');
    const manifest: ArchiveManifest = {
      format: 'ndjson+gzip',
      day: c.day,
      rows: c.lines.length,
      firstSeq: c.first,
      lastSeq: c.last,
      sha256: createHash('sha256').update(body).digest('hex'),
      bytes: body.length,
      object,
      checkpoint: { seq: cp.seq, hash: cp.hash, kind: 'retention_cut', keyId: cp.keyId, mac: cp.mac },
      createdAt: new Date(now).toISOString(),
    };
    await archive.put(`${base}.manifest.json`, Buffer.from(JSON.stringify(manifest, null, 2)), 'application/json');
    days++;
    total += c.lines.length;
  };
  for (;;) {
    // tenant-scope: system-job (retention archives the instance-wide chain)
    const rows = (await db.selectFrom('audit_log').selectAll().where('seq', '>', cursor).where('seq', '<=', cutSeq).orderBy('seq', 'asc').limit(pageSize).execute()) as AuditRow[];
    if (!rows.length) break;
    for (const r of rows) {
      const day = dayKey(Number(r.ts));
      const seq = Number(r.seq);
      if (current && current.day !== day) {
        await flush(current);
        current = null;
      }
      current ??= { day, lines: [], first: seq, last: seq };
      current.lines.push(ndjsonLine(r));
      current.last = seq;
    }
    cursor = Number(rows[rows.length - 1]!.seq);
  }
  if (current) await flush(current);
  return { days, rows: total };
}

/**
 * One `retention_cut` checkpoint per chain that loses rows (multi-tenancy spec §4.5): for each tenant,
 * its last row at or before `cutSeq` (the first retained row links to it); for the legacy chain, its
 * last row at or before `cutSeq`. Idempotent (a re-run after a failed archive reuses them). Returns
 * the checkpoint of the newest cut row (the archive manifest's anchor).
 */
async function cutCheckpoints(d: RetentionDeps, cutSeq: number): Promise<AuditCheckpoint> {
  const legacy = await legacyChainEnd(d.db);
  const targets: Array<{ tenantId: string | null; seq: number; hash: string }> = [];
  if (legacy.seq > 0) {
    // tenant-scope: system-job (the legacy chain spans the rows of a single-tenant install)
    const l = await d.db.selectFrom('audit_log').select(['seq', 'hash']).where('seq', '<=', Math.min(cutSeq, legacy.seq)).orderBy('seq', 'desc').limit(1).executeTakeFirst();
    if (l) targets.push({ tenantId: null, seq: Number(l.seq), hash: l.hash });
  }
  // tenant-scope: system-job (retention cuts every tenant's chain)
  const lasts = await d.db.selectFrom('audit_log').select((eb) => ['tenant_id', eb.fn.max('seq').as('seq')]).where('seq', '>', legacy.seq).where('seq', '<=', cutSeq).groupBy('tenant_id').execute();
  for (const l of lasts) {
    const r = await d.db.selectFrom('audit_log').select(['seq', 'hash']).where('tenant_id', '=', l.tenant_id).where('seq', '=', Number(l.seq)).executeTakeFirstOrThrow();
    targets.push({ tenantId: l.tenant_id, seq: Number(r.seq), hash: r.hash });
  }
  let newest: AuditCheckpoint | null = null;
  for (const t of targets) {
    let q = d.db.selectFrom('audit_checkpoints').selectAll().where('seq', '=', t.seq).where('kind', '=', 'retention_cut');
    q = t.tenantId === null ? q.where('tenant_id', 'is', null) : q.where('tenant_id', '=', t.tenantId);
    const existing = await q.executeTakeFirst();
    const cp = existing ? toCheckpoint(existing) : (await writeCheckpoint(d.db, 'retention_cut', d.signer, d.now(), { seq: t.seq, hash: t.hash }, t.tenantId))!;
    if (!newest || cp.seq > newest.seq) newest = cp;
  }
  return newest!;
}

/**
 * Retention (§9.6 + addendum 3): retention_cut checkpoints for the last row before the cutoff (one per chain) →
 * archive (when configured; a failure skips the delete and logs an alert) → delete (SQLite:
 * batches of 10k plus FTS deletes; PG: drop whole daily partitions, then delete the remainder)
 * → prune sessions.
 */
export async function applyRetention(d: RetentionDeps, cutoff: number): Promise<RetentionOutcome> {
  const out: RetentionOutcome = { cutoff, cutSeq: null, deleted: 0, archived: false, skipped: false, partitionsDropped: 0 };
  // tenant-scope: system-job (retention cuts every chain at the same global seq)
  const cut = await d.db.selectFrom('audit_log').select(['seq', 'hash']).where('ts', '<', cutoff).orderBy('seq', 'desc').limit(1).executeTakeFirst();
  if (cut) {
    const cutSeq = Number(cut.seq);
    out.cutSeq = cutSeq;
    const cp = await cutCheckpoints(d, cutSeq);
    if (d.archive) {
      try {
        const res = await archiveUpTo(d.db, d.archive, cutSeq, cp, d.now());
        out.archived = true;
        d.log.info({ archive: d.archive.location, days: res.days, rows: res.rows }, 'audit archive written');
      } catch (err) {
        out.skipped = true;
        d.log.error({ err, archive: d.archive.location, alert: 'audit_archive_failed' }, 'ALERT: audit archive failed; retention delete skipped');
        return out;
      }
    }
    if (d.dialect === 'postgres') {
      const drop = droppable(await listPartitions(d.db), cutoff);
      for (const name of drop) {
        // tenant-scope: system-job (retention drops whole monthly partitions)
        const n = await d.db.selectFrom(sql.table(name).as('p') as never).select(sql<number>`count(*)`.as('n')).executeTakeFirst();
        await sql.raw(`drop table if exists ${name}`).execute(d.db);
        out.deleted += Number((n as { n?: number } | undefined)?.n ?? 0);
        out.partitionsDropped++;
      }
      // tenant-scope: system-job (retention archives the instance-wide chain)
      const res = await d.db.deleteFrom('audit_log').where('seq', '<=', cutSeq).executeTakeFirst();
      out.deleted += Number(res.numDeletedRows);
    } else {
      const batch = d.deleteBatch ?? 10_000;
      for (;;) {
        // tenant-scope: system-job (retention archives the instance-wide chain)
        const ids = await d.db.selectFrom('audit_log').select('seq').where('seq', '<=', cutSeq).orderBy('seq', 'asc').limit(batch).execute();
        if (!ids.length) break;
        const hi = Number(ids[ids.length - 1]!.seq);
        await d.db.transaction().execute(async (trx) => {
          await sql`insert into audit_fts(audit_fts, rowid, params_text, tool_name, error_message, decision_reason) select 'delete', seq, params_text, tool_name, error_message, decision_reason from audit_log where seq <= ${hi}`.execute(trx);
          // tenant-scope: system-job (retention archives the instance-wide chain)
          const res = await trx.deleteFrom('audit_log').where('seq', '<=', hi).executeTakeFirst();
          out.deleted += Number(res.numDeletedRows);
        });
        if (ids.length < batch) break;
      }
    }
  }
  return out;
}

export { DAY_MS };
