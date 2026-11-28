import { randomBytes } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import { DecryptError, KEY_BYTES, open, seal, type Sealed } from './envelope.js';
import type { Keyring } from './keyring.js';

export interface SealedRecord extends Sealed {
  dekId: string;
}

/** The tenant binding every sealed value's AAD starts with (spec §4.4). */
export const tenantAad = (tenantId: string, aad: string) => `tenant:${tenantId}|${aad}`;

/**
 * DEK management + sealing (backend §8; multi-tenancy spec §4.4, G11): one active data-encryption
 * key **per tenant**, created lazily on the tenant's first `seal`, wrapped under the active KEK and
 * stored in `encryption_keys`. The AAD of every sealed value starts with `tenant:<id>|`, and `open`
 * refuses a DEK of another tenant, so a ciphertext copied into another tenant's row can't be opened.
 * Deleting a tenant's DEK rows crypto-shreds its secrets. Unwrapped DEKs are cached in memory.
 *
 * Instance-level values (OIDC login state, platform secrets) use `INSTANCE_SCOPE_ID` as their tenant.
 */
export class EnvelopeService {
  private readonly cache = new Map<string, { key: Buffer; tenantId: string }>();
  private readonly active = new Map<string, { id: string; key: Buffer }>();

  constructor(
    private readonly db: Kysely<MainDB>,
    readonly keyring: Keyring,
    private readonly clock: Clock,
  ) {}

  private remember(id: string, key: Buffer, tenantId: string): void {
    if (this.cache.size >= 1024) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(id, { key, tenantId });
  }

  async activeDek(tenantId: string): Promise<{ id: string; key: Buffer }> {
    const hit = this.active.get(tenantId);
    if (hit) return hit;
    const row = await this.db.selectFrom('encryption_keys').selectAll().where('tenant_id', '=', tenantId).where('status', '=', 'active').orderBy('created_at', 'desc').orderBy('id', 'desc').executeTakeFirst();
    if (row) {
      const key = this.keyring.unwrap(row.id, row.kek_id, row.wrapped_key);
      const dek = { id: row.id, key };
      if (this.active.size >= 1000) this.active.delete(this.active.keys().next().value!);
      this.active.set(tenantId, dek);
      this.remember(row.id, key, tenantId);
      return dek;
    }
    try {
      return await this.createDek(tenantId);
    } catch (err) {
      // another replica (or a concurrent seal) created the tenant's first DEK: use that one
      const again = await this.db.selectFrom('encryption_keys').select('id').where('tenant_id', '=', tenantId).where('status', '=', 'active').executeTakeFirst();
      if (!again) throw err;
      return this.activeDek(tenantId);
    }
  }

  /** Creates a new active DEK for the tenant; its older active DEK becomes `retired` (rotation re-encrypts its data). */
  async createDek(tenantId: string): Promise<{ id: string; key: Buffer }> {
    const id = newId();
    const key = randomBytes(KEY_BYTES);
    const { kekId, wrapped } = this.keyring.wrap(id, key);
    const now = this.clock.now();
    await this.db.transaction().execute(async (trx) => {
      await trx.updateTable('encryption_keys').set({ status: 'retired' }).where('tenant_id', '=', tenantId).where('status', '=', 'active').execute();
      await trx.insertInto('encryption_keys').values({ id, tenant_id: tenantId, kek_id: kekId, wrapped_key: wrapped, status: 'active', created_at: now }).execute();
    });
    const dek = { id, key };
    this.active.set(tenantId, dek);
    this.remember(id, key, tenantId);
    return dek;
  }

  /** The unwrapped DEK, only when it belongs to `tenantId`. */
  async dekKey(tenantId: string, dekId: string): Promise<Buffer> {
    let hit = this.cache.get(dekId);
    if (!hit) {
      const row = await this.db.selectFrom('encryption_keys').selectAll().where('id', '=', dekId).where('tenant_id', '=', tenantId).executeTakeFirst();
      if (!row) throw new DecryptError(`Unknown DEK ${dekId} for this tenant`);
      hit = { key: this.keyring.unwrap(row.id, row.kek_id, row.wrapped_key), tenantId: row.tenant_id };
      this.remember(dekId, hit.key, hit.tenantId);
    }
    if (hit.tenantId !== tenantId) throw new DecryptError(`DEK ${dekId} belongs to another tenant`);
    return hit.key;
  }

  async seal(tenantId: string, plaintext: Uint8Array, aad: string): Promise<SealedRecord> {
    const dek = await this.activeDek(tenantId);
    return { dekId: dek.id, ...seal(dek.key, plaintext, tenantAad(tenantId, aad)) };
  }

  /**
   * Opens a value sealed for `tenantId`. Values sealed before per-tenant DEKs (0.3.x) carry the bare
   * AAD; they open only under a DEK of the same tenant (the migrated single-tenant DEK), and DEK
   * rotation re-seals them with the tenant prefix.
   */
  async open(tenantId: string, rec: SealedRecord, aad: string): Promise<Buffer> {
    const key = await this.dekKey(tenantId, rec.dekId);
    try {
      return open(key, rec, tenantAad(tenantId, aad));
    } catch (err) {
      if (!(err instanceof DecryptError)) throw err;
      return open(key, rec, aad);
    }
  }

  /** Rewraps every DEK not under the active KEK (KEK rotation). Returns the number rewrapped. */
  async rewrapAll(): Promise<number> {
    // tenant-scope: system-job (KEK rotation rewraps every tenant's DEKs)
    const rows = await this.db.selectFrom('encryption_keys').selectAll().where('kek_id', '!=', this.keyring.activeKekId).execute();
    for (const row of rows) {
      const key = this.keyring.unwrap(row.id, row.kek_id, row.wrapped_key);
      const { kekId, wrapped } = this.keyring.wrap(row.id, key);
      await this.db.updateTable('encryption_keys').set({ kek_id: kekId, wrapped_key: wrapped }).where('id', '=', row.id).where('tenant_id', '=', row.tenant_id).execute();
    }
    return rows.length;
  }

  /** Tenants that have DEKs (rotation iterates them). */
  async tenantsWithKeys(): Promise<string[]> {
    // tenant-scope: system-job (DEK rotation loops over tenants)
    const rows = await this.db.selectFrom('encryption_keys').select('tenant_id').distinct().execute();
    return rows.map((r) => r.tenant_id);
  }

  /** Forget the cached active DEKs (another replica rotated). */
  invalidate(): void {
    this.active.clear();
  }
}
