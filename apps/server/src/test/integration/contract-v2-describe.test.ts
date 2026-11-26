import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunningServer } from '../../server.js';
import { assertEnvelope } from '../fakes/envelope-assert.js';
import { rawMcp } from '../fakes/golden.js';
import { bootServer, keyFor } from '../fakes/server.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');
const BASE_OVERLAY = readFileSync(resolve(import.meta.dirname, '../fixtures/acme.overlay.yaml'), 'utf8');
const V2 = { 'x-neurouter-contract': '2' };
type Env = Record<string, any>;

/**
 * Contract 2, P5 (contract-v2 §4.5, §4.6): the description standard as tools/list serves it (golden for
 * acme-orders: effect first, related tools, arguments, the checked example, Pages/Fields, dry run/confirm), and
 * overlay `readBack` (target labels and before values in plans, `{before, after, response}` after writes).
 */
describe('contract 2: descriptions and readBack (acme, mock)', () => {
  let s: RunningServer;
  let key: string;
  let dir: string;
  const mcp = async () => {
    const c = rawMcp(`${s.url}/mcp/acme/mock`, key, { headers: V2 });
    await c.initialize();
    return c;
  };
  const call = async (c: Awaited<ReturnType<typeof mcp>>, name: string, args: Record<string, unknown>): Promise<Env> => assertEnvelope((await c.call(name, args)).result, name);

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'nr-describe-'));
    writeFileSync(
      join(dir, 'acme.overlay.yaml'),
      `${BASE_OVERLAY.replace(/^tools:\n/m, `tools:\n  operationId:cancelOrder:\n    readBack: get_order\n  operationId:updateOrder:\n    readBack: { tool: get_order, label: [customerId, status] }\n`)}`,
    );
    writeFileSync(
      join(dir, 'neurouter.yaml'),
      [
        'version: 1',
        'settings:',
        '  codeMode: { enabled: true }',
        'servers:',
        '  - slug: acme',
        '    name: Acme Orders',
        `    spec: { path: ${JSON.stringify(resolve(REPO_ROOT, 'examples/acme-orders/openapi.yaml'))} }`,
        '    overlay: acme.overlay.yaml',
        '    exposure: { contract: 2 }',
        '    environments:',
        '      - { slug: mock, kind: dev, baseUrl: "mock:", writes: { enabled: true }, codeMode: true }',
      ].join('\n'),
    );
    s = await bootServer({ NEUROUTER_CONFIG: join(dir, 'neurouter.yaml') });
    key = await keyFor(s, 'acme', 'mock', ['tools:read', 'tools:write', 'code:run']);
  }, 60_000);
  afterAll(async () => {
    await s?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('tools/list serves the description standard (golden)', async () => {
    const c = await mcp();
    const list = (await c.list({ 'x-neurouter-exposure': 'tools' })) as Array<{ name: string; description: string; annotations?: { destructiveHint?: boolean } }>;
    const text = list.filter((t) => !t.name.startsWith('neurouter_') && t.name !== 'run_script').map((t) => `## ${t.name}\n${t.description}`).join('\n\n');
    await expect(`${text}\n`).toMatchFileSnapshot('./contract-v2-descriptions.golden.txt');
    const cancel = list.find((t) => t.name === 'cancel_order')!;
    expect(cancel.description.split('\n')[0]).toMatch(/^Cancels an order .*Irreversible\.$/);
    expect(cancel.annotations?.destructiveHint).toBe(true);
    // every example in a description runs as written
    for (const t of list) {
      const m = /^Example: ([a-z_]+)\((\{.*\})\)$/m.exec(t.description);
      if (!m || m[1] !== t.name) continue;
      const args = JSON.parse(m[2]!) as Record<string, unknown>;
      const r = await call(c, t.name, { ...args, ...(/^Dry run:/m.test(t.description) ? { dry_run: true } : {}) });
      expect(r.ok, `${t.name}: ${JSON.stringify(r.error)}`).toBe(true);
    }
  });

  it('readBack: the dry-run plan names the target with a label and its current values', async () => {
    const c = await mcp();
    const r = await call(c, 'cancel_order', { order_id: 'order_2', reason: 'other', dry_run: true });
    expect(r.ok).toBe(true);
    expect(r.data.plan.target).toMatch(/^order order_2 \(.+\)$/);
    expect(r.data.plan.before).toHaveProperty('status');
  });

  it('readBack: confirmation_required carries the labelled plan; the confirmed write answers {before, after, response}', async () => {
    const c = await mcp();
    const pending = (await call(c, 'list_orders', { status: 'pending', limit: 5 })).data.items[0].id as string;
    const first = await call(c, 'cancel_order', { order_id: pending, reason: 'other' });
    expect(first.error.code).toBe('confirmation_required');
    expect(first.data.plan.target.startsWith(`order ${pending} (`)).toBe(true);
    const done = await call(c, 'cancel_order', first.error.next[0].args);
    expect(done.ok, JSON.stringify(done.error)).toBe(true);
    expect(done.data.before.status).toBe('pending');
    // the mock's action endpoints answer without changing state, so `after` is read back as is; the stateful
    // update below checks real before/after values
    expect(Object.keys(done.data.after)).toEqual(Object.keys(done.data.before));
    expect(done.data.response).toHaveProperty('status');
    expect(done.state.wrote.startsWith(`cancel_order → order ${pending} (`)).toBe(true);
  });

  it('readBack with label fields: before/after show them and the changed fields', async () => {
    const c = await mcp();
    const r = await call(c, 'update_order', { order_id: 'order_4', note: 'leave at the door' });
    expect(r.ok, JSON.stringify(r.error)).toBe(true);
    expect(Object.keys(r.data.before)).toEqual(expect.arrayContaining(['customerId', 'status']));
    expect(r.data.after.note).toBe('leave at the door');
    expect(r.state.wrote).toMatch(new RegExp(`^update_order → order order_4 \\(${r.data.after.customerId}, ${r.data.after.status}\\)$`));
  });
});
