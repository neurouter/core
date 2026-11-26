import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogProviderLike } from '../../../kernel/audit/sinks/otel-logs.js';
import { verifyWebhookSignature } from '../../../kernel/audit/sinks/webhook.js';
import { createTestContext, importPetstore, PETSTORE, type TestContext } from '../../../test/fakes/app-context.js';

describe('audit export sinks (settings auditSinks → SinkDispatcher job)', () => {
  let t: TestContext;
  const posts: Array<{ url: string; headers: Headers; body: string }> = [];
  const logs: Array<{ body?: unknown; attributes?: Record<string, unknown> }> = [];
  beforeAll(async () => {
    const outbound = async (input: string | URL | Request, init: RequestInit = {}) => {
      posts.push({ url: String(input), headers: new Headers(init.headers), body: String(init.body ?? '') });
      return new Response(null, { status: 204 });
    };
    const provider: LogProviderLike = { getLogger: () => ({ emit: (r: { body?: unknown; attributes?: Record<string, unknown> }) => void logs.push(r) }) as never, forceFlush: async () => {}, shutdown: async () => {} };
    t = await createTestContext({}, { outboundFetch: outbound as never, otelLogProvider: async () => provider });
    await importPetstore(t);
  }, 60_000);
  afterAll(async () => t?.close());

  it('nothing is delivered until a sink is enabled; the console configures the webhook (secret write-only) and OTel logs', async () => {
    expect(await t.s.services.sinkDispatcher.runOnce()).toEqual({});
    const bad = await t.as(t.admin, { method: 'PATCH', url: '/api/settings', payload: { audit: { export: { webhookEnabled: true } } } });
    expect(bad.statusCode).toBe(422);
    const s = await t.json(t.admin, { method: 'PATCH', url: '/api/settings', payload: { audit: { export: { webhookUrl: 'https://siem.example.test/hook', webhookSecret: 'whsec-0123456789abcdef', webhookEnabled: true, otelLogsEnabled: true } } } }, 200);
    expect(s.audit.export).toMatchObject({ webhookUrl: 'https://siem.example.test/hook', webhookEnabled: true, webhookSecret: 'stored', otelLogsEnabled: true });
    expect(JSON.stringify(s)).not.toContain('whsec-0123456789abcdef');
    await t.s.services.auditStore.flush();
    const out = await t.s.services.sinkDispatcher.runOnce();
    expect(out.webhook!.delivered).toBeGreaterThan(0);
    expect(out.otel_logs!.delivered).toBe(out.webhook!.delivered);
    const post = posts.find((p) => p.url === 'https://siem.example.test/hook')!;
    expect(post.headers.get('content-type')).toBe('application/x-ndjson');
    expect(verifyWebhookSignature('whsec-0123456789abcdef', post.body, post.headers.get('x-neurouter-signature')!, Date.now())).toBe(true);
    expect(post.body.split('\n').filter(Boolean).every((l) => JSON.parse(l).type === 'event' || JSON.parse(l).type === 'checkpoint')).toBe(true);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0]!.attributes).toMatchObject({ 'event.name': 'neurouter.audit' });
    const v = await t.json(t.admin, { url: '/api/settings' }, 200);
    expect(v.audit.export.sinks).toEqual([expect.objectContaining({ name: 'webhook', lastError: null }), expect.objectContaining({ name: 'otel_logs', lastError: null })]);
    expect(v.audit.export.sinks[0].lastSeq).toBeGreaterThan(0);
    // the cursor advanced: a second run delivers nothing new
    const again = await t.s.services.sinkDispatcher.runOnce();
    expect(again.webhook!.delivered).toBe(0);
  });

  it('neurouter.yaml settings.audit.webhook (env:NAME secret) and otelLogs are applied', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nr-sinks-'));
    const f = join(dir, 'neurouter.yaml');
    writeFileSync(f, `version: 1\nsettings:\n  audit:\n    webhook: { url: https://siem2.example.test/hook, secret: env:NR_TEST_HOOK_SECRET }\n    otelLogs: false\nservers:\n  - slug: pets3\n    name: Pets\n    spec: { path: ${PETSTORE} }\n`);
    const r = await t.s.services.configSync.loadFile(f);
    expect(r.ok).toBe(true);
    expect(await t.s.services.settings.get('auditSinks', DEFAULT_TENANT_ID)).toEqual({ webhook: { url: 'https://siem2.example.test/hook', secretRef: 'env:NR_TEST_HOOK_SECRET', enabled: true }, otelLogs: { enabled: false } });
    process.env.NR_TEST_HOOK_SECRET = 'file-secret-0123456789';
    try {
      await t.s.services.auditStore.flush();
      posts.length = 0;
      t.s.services.audit.system(DEFAULT_TENANT_ID, 'test.event', { kind: 'config_apply', targetType: 'config', targetId: 'x' });
      await t.s.services.auditStore.flush();
      await t.s.services.sinkDispatcher.runOnce();
    } finally {
      delete process.env.NR_TEST_HOOK_SECRET;
    }
    const post = posts.find((p) => p.url === 'https://siem2.example.test/hook')!;
    expect(verifyWebhookSignature('file-secret-0123456789', post.body, post.headers.get('x-neurouter-signature')!, Date.now())).toBe(true);
  });
});
