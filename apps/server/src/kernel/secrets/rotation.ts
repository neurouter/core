import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { BuiltinSecretProvider } from './builtin.provider.js';
import type { EnvelopeService } from './envelope.service.js';

export interface RotationResult {
  type: 'dek' | 'rewrap';
  rewrapped: number;
  reencrypted: number;
  /** KEK ids that still wrap at least one DEK (a KEK can be removed when absent here). */
  kekIdsInUse: string[];
  deletedDeks: number;
}

/**
 * Key rotation (backend §8).
 * - `rewrap`: rewrap every DEK under the active KEK (after adding a new KEK and restarting).
 * - `dek`: per tenant with keys (multi-tenancy spec §4.4): a new active DEK, the tenant's secrets
 *   re-encrypted under it (with the tenant-bound AAD), then retired DEKs nothing references are deleted.
 * Upstream OAuth tokens (step 10) re-encrypt through `extraReencrypt`.
 */
export async function rotateKeys(
  deps: { db: Kysely<MainDB>; envelope: EnvelopeService; secrets: BuiltinSecretProvider; extraReencrypt?: (tenantId: string, activeDekId: string) => Promise<number> },
  type: 'dek' | 'rewrap',
): Promise<RotationResult> {
  let rewrapped = 0;
  let reencrypted = 0;
  let deletedDeks = 0;
  if (type === 'rewrap') {
    rewrapped = await deps.envelope.rewrapAll();
  } else {
    for (const tenantId of await deps.envelope.tenantsWithKeys()) {
      const dek = await deps.envelope.createDek(tenantId);
      reencrypted += await deps.secrets.reencryptAll(tenantId, dek.id);
      if (deps.extraReencrypt) reencrypted += await deps.extraReencrypt(tenantId, dek.id);
    }
    // tenant-scope: system-job (DEK rotation across tenants)
    const retired = await deps.db.selectFrom('encryption_keys').select('id').where('status', '=', 'retired').execute();
    for (const { id } of retired) {
      // tenant-scope: system-job (DEK rotation across tenants)
      const s = await deps.db.selectFrom('secrets').select('id').where('dek_id', '=', id).limit(1).executeTakeFirst();
      // tenant-scope: system-job (DEK rotation across tenants)
      const t = await deps.db.selectFrom('upstream_tokens').select('id').where('dek_id', '=', id).limit(1).executeTakeFirst();
      if (!s && !t) {
        // tenant-scope: system-job (DEK rotation across tenants)
        await deps.db.deleteFrom('encryption_keys').where('id', '=', id).execute();
        deletedDeks++;
      }
    }
  }
  // tenant-scope: system-job (KEK ids in use across tenants)
  const keks = await deps.db.selectFrom('encryption_keys').select('kek_id').distinct().execute();
  return { type, rewrapped, reencrypted, kekIdsInUse: keks.map((k) => k.kek_id).sort(), deletedDeks };
}
