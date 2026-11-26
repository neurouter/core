import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabases } from '../../test/fakes/test-db.js';
import type { Databases } from './index.js';
import { isTenantTable, scoped } from './tenant-scope.js';

let dbs: Databases;
beforeEach(async () => {
  dbs = await createTestDatabases();
});
afterEach(async () => dbs.close());

describe('scoped() query helper (multi-tenancy spec §4.2)', () => {
  it('filters select/update/delete by tenant; inserts set tenant_id', async () => {
    const now = Date.now();
    const row = (tenant: string, id: string) => ({ tenant_id: tenant, scope: 'global' as const, target: '*', kind: id as 'all', reason: id, created_by: null, created_at: now });
    await dbs.main.db.insertInto('kill_switches').values([row('a', 'all'), row('b', 'writes')]).execute();
    const a = scoped(dbs.main.db, 'a');
    expect((await a.selectFrom('kill_switches').select('reason').execute()).map((r) => r.reason)).toEqual(['all']);
    await a.updateTable('kill_switches').set({ reason: 'changed' }).execute();
    await a.deleteFrom('kill_switches').where('kind', '=', 'writes').execute();
    const all = await dbs.main.db.selectFrom('kill_switches').select(['tenant_id', 'reason']).orderBy('tenant_id').execute();
    expect(all).toEqual([{ tenant_id: 'a', reason: 'changed' }, { tenant_id: 'b', reason: 'writes' }]);
    await a.deleteFrom('kill_switches').execute();
    expect((await dbs.main.db.selectFrom('kill_switches').select('tenant_id').execute()).map((r) => r.tenant_id)).toEqual(['b']);
  });

  it('classifies tables', () => {
    expect(isTenantTable('servers')).toBe(true);
    expect(isTenantTable('mock_items')).toBe(true);
    expect(isTenantTable('tenants')).toBe(false);
    expect(isTenantTable('oauth_clients')).toBe(false);
  });
});
