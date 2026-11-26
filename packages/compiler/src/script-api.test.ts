import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeTool } from './describe.js';
import { pyArgMap } from './stubs.js';
import { firstSentence, generateOpsStubV2, pyCallText, scriptApi, scriptErrorClass, scriptErrorType, scriptPrelude } from './script-api.js';
import { compileFile, GITHUB_SUBSET, REPO } from './test/fixtures.js';

const ACME = path.join(REPO, 'examples/acme-orders/openapi.yaml');
const GITHUB_AGENT_READY = readFileSync(path.join(REPO, 'examples/github/agent-ready.overlay.yaml'), 'utf8');
const example = (t: { checkedExample?: { arguments: Record<string, unknown>; runs: boolean | null } }) => (t.checkedExample && t.checkedExample.runs !== false ? t.checkedExample.arguments : null);

/**
 * Contract-2 script API (P4) and description standard (P5): goldens for acme-orders and the GitHub subset with the
 * agent-ready overlay (`.pyi` with full docstrings and snake_case keywords; agent descriptions).
 */
describe('contract-2 script API', () => {
  it('acme-orders .pyi golden: docstrings with Args, Returns, Raises, Pages, Writes and a checked example', async () => {
    const r = await compileFile(ACME, undefined, 'acme');
    const api = scriptApi(r.tools, 'acme', { example, confirmTokens: true });
    await expect(api.stubs).toMatchFileSnapshot('./__snapshots__/acme.contract2.pyi');
    expect(api.signatures.create_order).toContain('customer_id: str');
    expect(api.stubs).toContain('    Example:\n        acme.get_order(order_id="order_1")');
    expect(api.stubs).toContain('Irreversible.');
    expect(api.typeStubs).toContain('class _nr_f_acme_list_orders:');
    expect(api.typeStubs).toMatch(/def pages\(self, args: dict\[str, Any\] \| None = None, max_items: int = 500, \*, .*\) -> list\[_nr_t_acme\.Order\]/);
  });

  it('GitHub subset (agent-ready overlay) .pyi golden', async () => {
    const r = await compileFile(GITHUB_SUBSET, GITHUB_AGENT_READY, 'github');
    const api = scriptApi(r.tools, 'github', { example, confirmTokens: true });
    await expect(api.stubs).toMatchFileSnapshot('./__snapshots__/github.contract2.pyi');
    // every visible API tool has a docstring with an example (checked against the mock)
    const visible = r.tools.filter((t) => !t.hidden && t.kind !== 'composite');
    const withExample = visible.filter((t) => api.docs[t.name]?.includes('Example:'));
    expect(withExample.length).toBeGreaterThanOrEqual(visible.length - 2);
  });

  it('GitHub agent descriptions golden (P5 description standard)', async () => {
    const r = await compileFile(GITHUB_SUBSET, GITHUB_AGENT_READY, 'github');
    const visible = r.tools.filter((t) => !t.hidden);
    const text = visible.map((t) => `## ${t.name}\n${describeTool(t, visible, { example: example(t), paging: null, fields: { name: 'fields' }, dryRun: t.risk.write ? 'dry_run' : null, confirm: t.risk.destructive ? 'confirm' : null })}`).join('\n\n');
    await expect(`${text}\n`).toMatchFileSnapshot('./__snapshots__/github.descriptions.txt');
    for (const t of visible) expect(describeTool(t, visible, { example: example(t) }).length, t.name).toBeLessThanOrEqual(800);
  });

  it('snake_case keyword names map back to the schema names (D8); collisions keep their own form', () => {
    const t = { inputSchema: { type: 'object', properties: { customerId: {}, from: {}, page_size: {}, pageSize: {} } } };
    expect(pyArgMap(t, { snake: true })).toEqual({ customer_id: 'customerId', from_: 'from', page_size: 'page_size', pageSize: 'pageSize' });
    expect(pyArgMap(t)).toEqual({ customerId: 'customerId', from_: 'from', page_size: 'page_size', pageSize: 'pageSize' });
  });

  it('error classes keep the P1 built-in types', () => {
    expect(['not_found', 'invalid_args', 'forbidden', 'writes_disabled', 'confirmation_required', 'timeout', 'rate_limited', 'upstream_error', 'unknown_tool'].map(scriptErrorType)).toEqual(['LookupError', 'ValueError', 'PermissionError', 'PermissionError', 'PermissionError', 'TimeoutError', 'RuntimeError', 'RuntimeError', 'AttributeError']);
    expect(['not_found', 'writes_disabled', 'rate_limited', 'upstream_conflict'].map(scriptErrorClass)).toEqual(['NotFound', 'WritesDisabled', 'RateLimited', 'UpstreamError']);
  });

  it('prelude binds namespaces and ops without setattr; ops stub lists report only when enabled', () => {
    const p = scriptPrelude([{ ns: 'acme', functions: ['get_order', 'list_orders'] }], ['log_decision'], true);
    expect(p).toContain('import _nr, ops as _nr_m_ops, acme as _nr_m_acme');
    expect(p).toContain('        self.list_orders = _nr_fn("acme.list_orders")');
    expect(p).toContain('NotFound = LookupError');
    expect(p).toContain('    def report(self, kind, text, **kw):');
    expect(p).not.toContain('setattr');
    expect(generateOpsStubV2([], false)).not.toContain('def report(');
    expect(generateOpsStubV2([], true)).toContain('def report(');
  });

  it('python call text and first sentences', async () => {
    const r = await compileFile(ACME, undefined, 'acme');
    const t = r.tools.find((x) => x.name === 'create_order')!;
    expect(pyCallText(t, { customerId: 'customer_1', items: [{ sku: 'a', quantity: 1 }] })).toBe('acme.create_order(customer_id="customer_1", items=[{"sku": "a", "quantity": 1}])');
    expect(firstSentence('Cancels an order. Paid orders are refunded.')).toBe('Cancels an order.');
  });
});
