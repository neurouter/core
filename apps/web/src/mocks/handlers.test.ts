import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS } from '@/contract';
import { createDb } from './db';
import { contractFixtures } from './fixtures';
import { DEMO_READ_ONLY_ALLOW, createContractHandlers } from './handlers';
import { server } from '@/test/msw-server';

describe('contract-generated MSW handlers', () => {
  it('creates one handler per fetchable contract endpoint', () => {
    expect(createContractHandlers()).toHaveLength(ALL_ENDPOINTS.filter((e) => !['navigation', 'sse', 'binary'].includes(e.def.kind)).length);
  });

  it('every endpoint key has a fixture (no 501s in the demo)', () => {
    const fixtures = contractFixtures(createDb({ speed: 0 }));
    const missing = ALL_ENDPOINTS.filter((e) => !['navigation', 'sse', 'binary'].includes(e.def.kind) && !(e.key in fixtures)).map((e) => e.key);
    expect(missing).toEqual([]);
  });

  it('answers 501 problem+json for endpoints without a fixture', async () => {
    server.use(...createContractHandlers({}));
    const res = await fetch('/api/servers/abc');
    expect(res.status).toBe(501);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect((await res.json()).detail).toMatch(/servers\.get/);
  });

  it('validates fixtures against the contract', async () => {
    server.use(...createContractHandlers({ 'servers.get': { id: 'x' } }));
    expect((await fetch('/api/servers/x')).status).toBe(500);
  });

  it('read-only mode refuses writes with demo_read_only, except the allow-list', async () => {
    server.use(...createContractHandlers(contractFixtures(createDb({ speed: 0 }), { demo: true }), { readOnly: true }));
    const del = await fetch('/api/keys/key_dev_sandbox/revoke', { method: 'POST' });
    expect(del.status).toBe(403);
    expect(await del.json()).toMatchObject({ code: 'forbidden', reason: 'demo_read_only' });
    expect(DEMO_READ_ONLY_ALLOW.has('overlays.updateDraft')).toBe(true);
    const patch = await fetch('/api/servers/srv_acme_orders/overlay/draft', { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ops: [{ op: 'set', selector: 'customersSearch', field: 'pinned', value: true }] }) });
    expect(patch.status).toBe(200);
    const fullRun = await fetch('/api/eval-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: 'srv_acme_orders' }) });
    expect(fullRun.status).toBe(403);
    const quick = await fetch('/api/eval-runs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: 'srv_acme_orders', preset: 'quick' }) });
    expect(quick.status).toBe(202);
  });
});
