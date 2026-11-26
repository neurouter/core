import type { Kysely } from 'kysely';
import type { MainDB } from '../db/schema.js';
import type { Clock } from '../lib/clock.js';
import type { BuiltinSecretProvider } from './builtin.provider.js';

export type SecretOwner = 'environment' | 'settings' | 'oauth_client';

/**
 * Named secrets (`secret:NAME` references, §6.2 / §13.5) stored encrypted through Hub's envelope
 * provider, keyed by (owner_type, owner_id, name). Values are never returned by the API.
 */
export class NamedSecrets {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly provider: BuiltinSecretProvider,
    private readonly clock: Clock,
  ) {}

  private row(tenantId: string, owner: SecretOwner, ownerId: string, name: string) {
    return this.db.selectFrom('secrets').select(['id', 'updated_at']).where('tenant_id', '=', tenantId).where('owner_type', '=', owner).where('owner_id', '=', ownerId).where('name', '=', name).executeTakeFirst();
  }

  async set(tenantId: string, owner: SecretOwner, ownerId: string, name: string, value: string, updatedBy: string | null): Promise<{ updatedAt: number }> {
    const existing = await this.row(tenantId, owner, ownerId, name);
    const ref = await this.provider.put({ purpose: `${owner}:${name}`, value: Buffer.from(value, 'utf8'), ...(existing ? { id: existing.id } : {}) });
    const now = this.clock.now();
    await this.db.updateTable('secrets').set({ tenant_id: tenantId, owner_type: owner, owner_id: ownerId, name, updated_by: updatedBy, updated_at: now }).where('id', '=', ref.id).execute();
    return { updatedAt: now };
  }

  async get(tenantId: string, owner: SecretOwner, ownerId: string, name: string): Promise<string | null> {
    const r = await this.row(tenantId, owner, ownerId, name);
    if (!r) return null;
    try {
      return (await this.provider.get({ id: r.id })).toString('utf8');
    } catch {
      return null;
    }
  }

  async meta(tenantId: string, owner: SecretOwner, ownerId: string, name: string): Promise<{ updatedAt: number } | null> {
    const r = await this.row(tenantId, owner, ownerId, name);
    return r ? { updatedAt: Number(r.updated_at) } : null;
  }

  async delete(tenantId: string, owner: SecretOwner, ownerId: string, name: string): Promise<boolean> {
    const r = await this.row(tenantId, owner, ownerId, name);
    if (!r) return false;
    await this.provider.delete({ id: r.id });
    return true;
  }

  async list(tenantId: string, owner: SecretOwner, ownerId: string): Promise<Array<{ name: string; updatedAt: number }>> {
    const rows = await this.db.selectFrom('secrets').select(['name', 'updated_at']).where('tenant_id', '=', tenantId).where('owner_type', '=', owner).where('owner_id', '=', ownerId).execute();
    return rows.map((r) => ({ name: r.name ?? '', updatedAt: Number(r.updated_at) }));
  }

  /** `env:NAME` → process env at call time; `secret:NAME` → the environment's stored secret. */
  resolver(tenantId: string, env: NodeJS.ProcessEnv = process.env) {
    return async (ref: string, scope: { environmentId: string }): Promise<string | null> => {
      if (ref.startsWith('env:')) {
        const v = env[ref.slice(4)];
        return v === undefined || v === '' ? null : v;
      }
      if (ref.startsWith('secret:')) return this.get(tenantId, 'environment', scope.environmentId, ref.slice(7));
      return null;
    };
  }
}
