import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { HEADER_MOCK_STATE } from '@neurouter/shared';
import { newId } from '../../kernel/lib/ids.js';
import type { RunningServer } from '../../server.js';
import { consoleOn, type TestContext } from '../fakes/app-context.js';
import { bootServer, keyFor, mcpClient, resetPg } from '../fakes/server.js';

const PG = process.env.NEUROUTER_TEST_PG_URL;

const text = (r: Awaited<ReturnType<Client['callTool']>>) => JSON.stringify(r.structuredContent ?? r.content);
async function petExists(c: Client, id: number): Promise<boolean> {
  const r = await c.callTool({ name: 'get_pet_by_id', arguments: { pet_id: id } });
  if (!r.isError) return true;
  expect(text(r)).toMatch(/404|not.found/i);
  return false;
}

/**
 * P0b acceptance (multi-tenancy spec §7): two server instances on one database share the mock world
 * (writes and `environments.resetMock` on one are visible on the other), and the eval mock-state
 * header is bound to the request's tenant, environment, eval key and running run (G13).
 */
describe.each([['sqlite', ''], ...(PG ? [['postgres', PG]] : [])])('mock state shared by two instances (%s)', (_dialect, pgUrl) => {
  let dir: string | null = null;
  let a: RunningServer;
  let b: RunningServer;
  let cons: TestContext;
  let envId: string;
  let tenantId: string;
  let serverId: string;
  let ca: Client;
  let cb: Client;

  beforeAll(async () => {
    let url: string;
    if (pgUrl) url = await resetPg(pgUrl, 'nr_it_mock_multi');
    else {
      dir = mkdtempSync(join(tmpdir(), 'nr-mock-multi-'));
      url = `sqlite:${join(dir, 'neurouter.db')}`;
    }
    // same secrets on both instances, like replicas of one deployment
    const shared = { DATABASE_URL: url, NEUROUTER_MASTER_KEYS: `k1:${randomBytes(32).toString('base64')}`, HASH_PEPPER: randomBytes(32).toString('base64url'), NEUROUTER_EXECUTOR_MODE: 'off' };
    a = await bootServer(shared);
    b = await bootServer(shared);
    cons = await consoleOn(a);
    const srv = (await a.services.servers.bySlug(DEFAULT_TENANT_ID, 'petstore'))!;
    serverId = srv.id;
    const env = (await a.services.servers.environments(srv.id)).find((e) => e.slug === 'dev')!;
    envId = env.id;
    tenantId = env.tenant_id;
    const key = await keyFor(a, 'petstore', 'dev', ['tools:read', 'tools:write']);
    ca = await mcpClient(a, 'petstore', 'dev', key);
    cb = await mcpClient(b, 'petstore', 'dev', key);
  }, 90_000);
  afterAll(async () => {
    await ca?.close().catch(() => {});
    await cb?.close().catch(() => {});
    await cons?.close();
    await b?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('a write on one instance is read on the other', async () => {
    const add = await ca.callTool({ name: 'add_pet', arguments: { name: 'Shared', photoUrls: [] } });
    expect(add.isError, text(add)).toBeFalsy();
    const id = Number(/"id":(\d+)/.exec(text(add))![1]);
    expect(id).toBeGreaterThan(20);
    const got = await cb.callTool({ name: 'get_pet_by_id', arguments: { pet_id: id } });
    expect(got.isError, text(got)).toBeFalsy();
    expect(text(got)).toContain('Shared');
    // and the other way round, concurrently from both
    const both = await Promise.all([ca.callTool({ name: 'add_pet', arguments: { name: 'A', photoUrls: [] } }), cb.callTool({ name: 'add_pet', arguments: { name: 'B', photoUrls: [] } })]);
    const ids = both.map((r) => Number(/"id":(\d+)/.exec(text(r))![1]));
    expect(new Set(ids).size).toBe(2);
    expect(Math.min(...ids)).toBe(id + 1);
    expect(await petExists(ca, Math.max(...ids))).toBe(true);
    expect((await cb.callTool({ name: 'delete_pet', arguments: { pet_id: 1 } })).isError).toBeFalsy();
    expect(await petExists(ca, 1)).toBe(false);
  });

  it('environments.resetMock on one instance resets the state the other one serves', async () => {
    expect(await petExists(cb, 1)).toBe(false);
    expect(await petExists(cb, 21)).toBe(true);
    const r = await cons.as(cons.admin, { method: 'POST', url: `/api/environments/${envId}/mock/reset`, payload: {} });
    expect(r.statusCode).toBe(204);
    expect(await petExists(cb, 1)).toBe(true);
    expect(await petExists(cb, 21)).toBe(false);
    expect(await petExists(ca, 21)).toBe(false);
  });

  describe('X-Neurouter-Mock-State binding (G13)', () => {
    const evalKey = async () => {
      const admin = await a.services.users.ensureBootstrapAdmin();
      const { key, token } = await a.services.apiKeys.create({ tenantId, name: 'eval test', serverId, environmentId: envId, scopes: ['tools:read', 'tools:write'], ownerUserId: admin.id, purpose: 'eval', expiresInDays: 1 });
      return { id: key.id, token };
    };
    const run = async (status: 'running' | 'succeeded', over: { tenant_id?: string; environment_id?: string } = {}) => {
      const id = newId();
      await a.services.dbs.main.db
        .insertInto('eval_runs')
        .values({ id, tenant_id: over.tenant_id ?? tenantId, server_id: serverId, suite_id: newId(), environment_id: over.environment_id ?? envId, build_id: newId(), status, trigger: 'cli', created_at: Date.now() })
        .execute();
      return id;
    };
    /** Deletes pet `id` with the header; true when the delete stayed in its own namespace (env still has the pet). */
    const isolated = async (token: string, header: string, id: number, on: RunningServer = b): Promise<boolean> => {
      const c = await mcpClient(on, 'petstore', 'dev', token, { headers: { [HEADER_MOCK_STATE]: header } });
      try {
        const del = await c.callTool({ name: 'delete_pet', arguments: { pet_id: id } });
        expect(del.isError, text(del)).toBeFalsy();
      } finally {
        await c.close().catch(() => {});
      }
      return petExists(ca, id);
    };

    it('honours a running eval run of this tenant and environment, on either instance', async () => {
      const k = await evalKey();
      const runId = await run('running');
      expect(await isolated(k.token, `eval:${runId}:task-1`, 2, a)).toBe(true);
      expect(await isolated(k.token, `eval:${runId}:task-2`, 2, b)).toBe(true);
      // the eval namespace is readable through the shared store from the other instance
      const pet = (await a.services.mockStore.get({ tenantId, environmentId: envId, name: `eval:${runId}:task-1` }, { key: '/pet', name: 'pet', idField: 'id', idType: 'integer', scopeParams: [], defaultScope: {}, itemSchema: {} }, {}, '2'));
      expect(pet).toBeNull();
    });

    it('honours gen:<keyId> only for the key that sends it', async () => {
      const k = await evalKey();
      const other = await evalKey();
      expect(await isolated(k.token, `gen:${k.id}:ref-1`, 3)).toBe(true);
      expect(await isolated(k.token, `gen:${other.id}:ref-1`, 3)).toBe(false);
    });

    it('ignores a forged header: user key, finished run, foreign tenant, other environment, unknown run, bad shape', async () => {
      const k = await evalKey();
      const userKey = await keyFor(a, 'petstore', 'dev', ['tools:read', 'tools:write']);
      const running = await run('running');
      const prodEnv = (await a.services.servers.environments(serverId)).find((e) => e.slug === 'prod')!;
      const cases: Array<[string, string]> = [
        [userKey, `eval:${running}:forged`],
        [k.token, `eval:${await run('succeeded')}:done`],
        [k.token, `eval:${await run('running', { tenant_id: newId() })}:foreign`],
        [k.token, `eval:${await run('running', { environment_id: prodEnv.id })}:prod`],
        [k.token, `eval:${newId()}:unknown`],
        [k.token, `eval:gen-${newId()}`],
        [k.token, `eval:${running}:${'x'.repeat(151)}`],
        [k.token, 'env'],
      ];
      let id = 4;
      for (const [token, header] of cases) {
        expect(await isolated(token, header, id), header).toBe(false);
        id++;
      }
    });
  });
});
