import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';

/**
 * Per-tenant OAuth client blocks (multi-tenancy spec §3.4, G14). Client registrations are global (an
 * MCP client such as Claude is not owned by a tenant); blocking one is a decision of one tenant and
 * revokes that tenant's tokens only. The global `oauth_clients.status = 'blocked'` remains a
 * platform-level block.
 */
export async function isClientBlocked(db: Kysely<MainDB>, tenantId: string, clientRowId: string): Promise<boolean> {
  const r = await db.selectFrom('oauth_client_blocks').select('client_id').where('tenant_id', '=', tenantId).where('client_id', '=', clientRowId).executeTakeFirst();
  return Boolean(r);
}

export async function blockClient(db: Kysely<MainDB>, tenantId: string, clientRowId: string, by: string | null, now: number): Promise<void> {
  await db.insertInto('oauth_client_blocks').values({ tenant_id: tenantId, client_id: clientRowId, created_by: by, created_at: now }).onConflict((oc) => oc.columns(['tenant_id', 'client_id']).doNothing()).execute();
  await db.updateTable('oauth_tokens').set({ revoked_at: now }).where('tenant_id', '=', tenantId).where('client_id', '=', clientRowId).where('revoked_at', 'is', null).execute();
}

export async function unblockClient(db: Kysely<MainDB>, tenantId: string, clientRowId: string): Promise<void> {
  await db.deleteFrom('oauth_client_blocks').where('tenant_id', '=', tenantId).where('client_id', '=', clientRowId).execute();
}
