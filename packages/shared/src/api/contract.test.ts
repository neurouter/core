import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { ALL_ENDPOINTS, API_KEY_ALIASES, DEMO_ANONYMOUS_ALLOW, api, endpointByKey, isNonSpaPath, mcpPath } from './routes.js';
import { buildPath, pathParamNames, serializeQuery } from './endpoint.js';
import { PROBLEM_CODES, Page, Problem, isRedactedMarker, problemType, timeRangeIssue, toProblemPath } from './common.js';
import { isSafeReturnTo } from './auth.js';
import { ServerCreate, ServerPatch } from './servers.js';
import { EnvironmentCreate, UpstreamAuthIn, WritesConfig } from './environments.js';
import { ToolListQuery } from './tools.js';
import { AuditQuery } from './audit.js';
import { OverlayDraftPatch } from './overlays.js';
import { EvalRunCreate, TranscriptItem } from './evals.js';
import { TaskListQuery, TimelineItem } from './tasks.js';
import { Capability } from '../domain/capabilities.js';

/** Every endpoint key named in backend spec §14.2–§14.15 (backend keys, A45). */
const SPEC_KEYS = [
  // §14.2
  'auth.config', 'auth.oidcStart', 'auth.oidcCallback', 'auth.link', 'auth.logout', 'me.get', 'me.badges',
  // §14.3
  'metrics.overview', 'metrics.timeseries', 'metrics.toolUsage',
  // §14.4
  'servers.list', 'servers.create', 'servers.get', 'servers.update', 'servers.delete', 'servers.connect',
  // §14.5
  'specs.list', 'specs.reimport', 'specs.get', 'specs.download', 'specs.diff', 'builds.list', 'builds.get', 'builds.stubs',
  // §14.6
  'tools.list', 'tools.get', 'tools.search', 'tools.diff',
  'overlays.getDraft', 'overlays.updateDraft', 'overlays.discardDraft', 'overlays.publish', 'overlays.versions', 'overlays.getVersion',
  'overlays.diff', 'overlays.revert', 'overlays.download', 'overlays.validate',
  // §14.7
  'environments.list', 'environments.create', 'environments.get', 'environments.update', 'environments.delete', 'environments.setWrites',
  'environments.setToolWrite', 'environments.pinBuild', 'environments.setSecret', 'environments.deleteSecret', 'environments.test',
  'environments.resetMock', 'environments.connectUpstream',
  // §14.8
  'keys.list', 'keys.create', 'keys.update', 'keys.revoke', 'oauthClients.list', 'oauthClients.block', 'oauthClients.unblock', 'oauthGrants.list', 'oauthGrants.revoke',
  // §14.9
  'tasks.list', 'tasks.get', 'calls.get', 'scripts.get',
  // §14.10
  'inbox.summary', 'inbox.needGroups', 'inbox.needGroup', 'inbox.triageNeedGroup', 'inbox.mergeNeedGroups', 'inbox.issues', 'inbox.issue',
  'inbox.triageIssue', 'inbox.exportNeedMarkdown', 'inbox.exportIssueMarkdown',
  // §14.11
  'evals.suites', 'evals.generateSuite', 'evals.suite', 'evals.updateTask', 'evals.createTask', 'evals.freezeSuite', 'evals.runs', 'evals.createRun',
  'evals.run', 'evals.taskRun', 'evals.cancelRun', 'evals.compare', 'readiness.get', 'suggestions.list', 'suggestions.verify', 'suggestions.apply', 'suggestions.dismiss',
  // §14.12
  'audit.list', 'audit.get', 'audit.export', 'audit.verify',
  // §14.13
  'settings.get', 'settings.update', 'settings.testModel', 'killSwitches.list', 'killSwitches.set', 'killSwitches.clear',
  'config.status', 'config.reload', 'config.export', 'config.validate', 'system.info', 'users.list', 'users.update', 'jobs.get', 'events.stream',
  // §14.14
  'public.report', 'public.badge',
  // §14.15
  'specs.preview', 'specs.draft', 'specs.draftUpdate', 'specs.cancelPreview', 'environments.testDraft', 'tools.searchAll', 'overlays.preview',
  'writeSwitches.get', 'opsTools.list', 'opsTools.set', 'tasks.events', 'inbox.list', 'inbox.splitNeed', 'evals.runTasks', 'suggestions.get',
  'suggestions.search', 'modelProviders.list', 'modelProviders.create', 'modelProviders.update', 'modelProviders.delete', 'modelProviders.test', 'telemetry.test',
] as const;

/** Keys of §14 that are aliases of another key (registered once). */
const SPEC_ALIAS_KEYS = ['tools.searchPreview', 'writeSwitches.set', 'inbox.exportMarkdown', 'settings.modelProviders.list', 'settings.modelProviders.test'];

describe('endpoint registry', () => {
  const keys = ALL_ENDPOINTS.map((e) => e.key as string);

  it('has unique keys and unique method + path pairs', () => {
    expect(new Set(keys).size).toBe(keys.length);
    const seen = new Set<string>();
    for (const { key, def } of ALL_ENDPOINTS) {
      const id = `${def.method} ${def.path}`;
      expect(seen.has(id), `${key} duplicates ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it('registers every §14 key, and nothing else', () => {
    for (const k of SPEC_KEYS) expect(keys, k).toContain(k);
    expect([...keys].sort()).toEqual([...SPEC_KEYS].sort());
  });

  it('resolves every alias to a registered endpoint', () => {
    for (const [alias, target] of Object.entries(API_KEY_ALIASES)) expect(keys, `${alias} → ${target}`).toContain(target);
    for (const k of SPEC_ALIAS_KEYS) expect(endpointByKey(k), k).toBeDefined();
    expect(endpointByKey('writeSwitches.set')).toBe(api.environments.setToolWrite);
  });

  it('paths live under /api (or the documented /public and /oauth exceptions) and declare params matching :segments', () => {
    for (const { key, def } of ALL_ENDPOINTS) {
      const ok = def.path.startsWith('/api/') || (key.startsWith('public.') && def.path.startsWith('/public/')) || (key === 'environments.connectUpstream' && def.path.startsWith('/oauth/'));
      expect(ok, `${key}: ${def.path}`).toBe(true);
      const names = pathParamNames(def.path);
      if (names.length === 0) {
        expect(def.params, `${key} has params but no :segments`).toBeUndefined();
        continue;
      }
      expect(def.params, `${key} needs a params schema`).toBeDefined();
      const shape = (def.params as z.ZodObject).shape as Record<string, unknown>;
      expect(Object.keys(shape).sort(), key).toEqual([...names].sort());
    }
  });

  it('json endpoints declare a response; empty ones return 204; GETs have no body; navigations are GET', () => {
    for (const { key, def } of ALL_ENDPOINTS) {
      if (def.kind === 'json') expect(def.response, key).toBeDefined();
      if (def.kind === 'empty') expect(def.status, key).toBe(204);
      if (def.method === 'GET') expect(def.body, key).toBeUndefined();
      if (def.kind === 'navigation') expect(def.method, key).toBe('GET');
    }
  });

  it('access lists only known capabilities, public or user; mutations never use a :read capability', () => {
    const allowed = new Set<string>([...Capability.options, 'public', 'user']);
    for (const { key, def } of ALL_ENDPOINTS) {
      expect(def.access.length, key).toBeGreaterThan(0);
      for (const a of def.access) expect(allowed.has(a), `${key}: ${a}`).toBe(true);
    }
    // documented exceptions: read-only computations behind POST
    const readPosts = new Set(['environments.test', 'overlays.validate', 'overlays.preview', 'config.validate', 'audit.verify']);
    for (const { key, def } of ALL_ENDPOINTS) {
      if (def.method === 'GET' || readPosts.has(key) || def.access.includes('public') || def.access.includes('user')) continue;
      expect(def.access.some((a) => a.endsWith(':read')), key).toBe(false);
    }
  });

  it('demo allow-list names only registered mutating endpoints', () => {
    for (const k of DEMO_ANONYMOUS_ALLOW) {
      const def = endpointByKey(k);
      expect(def, k).toBeDefined();
      expect(def!.method, k).not.toBe('GET');
    }
    expect(DEMO_ANONYMOUS_ALLOW).not.toContain('suggestions.verify');
  });

  it('every schema converts to JSON Schema (OpenAPI docs, MSW, form generators)', () => {
    const bad: string[] = [];
    for (const { key, def } of ALL_ENDPOINTS) {
      for (const part of ['params', 'query', 'body', 'response'] as const) {
        const s = def[part] as z.ZodType | undefined;
        if (!s) continue;
        try {
          z.toJSONSchema(s, { io: part === 'response' ? 'output' : 'input', unrepresentable: 'any' });
        } catch (err) {
          bad.push(`${key}.${part}: ${(err as Error).message}`);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('has the expected size', () => {
    expect(ALL_ENDPOINTS.length).toBe(SPEC_KEYS.length);
  });
});

describe('path and query helpers', () => {
  it('buildPath encodes params and throws on missing ones', () => {
    expect(buildPath('/api/eval-runs/:id/task-runs/:taskRunId', { id: 'a b', taskRunId: 'k' })).toBe('/api/eval-runs/a%20b/task-runs/k');
    expect(() => buildPath('/api/servers/:id', {})).toThrow(/Missing path param/);
    expect(mcpPath('petstore', 'dev')).toBe('/mcp/petstore/dev');
  });
  it('serializeQuery repeats array keys, drops empties and formats dates', () => {
    const d = new Date('2026-11-24T10:00:00.000Z');
    expect(serializeQuery({ decision: ['allowed', 'denied_acl'], q: '', x: undefined, y: null, from: d, n: 0, b: false })).toBe(
      '?decision=allowed&decision=denied_acl&from=2026-11-24T10%3A00%3A00.000Z&n=0&b=false',
    );
  });
  it('query schemas coerce strings', () => {
    expect(ToolListQuery.parse({ pinned: 'true', limit: '20', q: '' })).toMatchObject({ pinned: true, limit: 20, q: undefined });
    expect(() => ToolListQuery.parse({ limit: '500' })).toThrow();
    expect(TaskListQuery.parse({ outcome: 'inferred', framing: ['explicit', 'script'] })).toMatchObject({ outcome: ['inferred'], framing: ['explicit', 'script'] });
  });
  it('audit query: optional range, max 90 days', () => {
    expect(AuditQuery.parse({})).toBeTruthy();
    expect(AuditQuery.parse({ decision: 'denied_read_only' }).decision).toEqual(['denied_read_only']);
    expect(() => AuditQuery.parse({ from: '2026-01-01T00:00:00Z', to: '2026-11-02T00:00:00Z' })).toThrow(/90 days/);
    expect(timeRangeIssue('2026-11-02T00:00:00Z', '2026-11-01T00:00:00Z')).toMatch(/after/);
  });
  it('isNonSpaPath', () => {
    expect(isNonSpaPath('/api/me')).toBe(true);
    expect(isNonSpaPath('/mcp/petstore/dev')).toBe(true);
    expect(isNonSpaPath('/public/servers/github/badge.svg')).toBe(true);
    expect(isNonSpaPath('/servers')).toBe(false);
    expect(isNonSpaPath('/apiary')).toBe(false);
  });
  it('isSafeReturnTo', () => {
    expect(isSafeReturnTo('/servers')).toBe(true);
    for (const v of ['//evil.com', '/\\evil.com', 'https://evil.com', 'javascript:alert(1)', '', '/\t/evil']) expect(isSafeReturnTo(v), v).toBe(false);
  });
});

describe('problem+json', () => {
  it('has the Neurouter codes with their statuses', () => {
    expect(problemType('config_managed')).toBe('https://neurouter.dev/problems/config-managed');
    expect(PROBLEM_CODES.config_managed.status).toBe(409);
    expect(PROBLEM_CODES.spec_fetch_failed.status).toBe(502);
    expect(PROBLEM_CODES.llm_key_missing.status).toBe(412);
    expect(PROBLEM_CODES.executor_unavailable.status).toBe(503);
    expect(PROBLEM_CODES.draft_conflict.status).toBe(409);
  });
  it('keeps extensions (reason, configPath)', () => {
    const p = Problem.parse({ type: problemType('forbidden'), title: 'Forbidden', status: 403, code: 'forbidden', requestId: 'r1', reason: 'demo_read_only' });
    expect(p.reason).toBe('demo_read_only');
    expect(toProblemPath(['a', 0])).toEqual(['a', '0']);
    expect(Page(z.number()).parse({ items: [1], nextCursor: null })).toEqual({ items: [1], nextCursor: null });
    expect(isRedactedMarker({ $redacted: 'x' })).toBe(true);
  });
});

describe('contract details', () => {
  it('server create: from a source or from a preview', () => {
    expect(ServerCreate.parse({ slug: 'petstore', name: 'Petstore', source: { url: 'https://example.com/openapi.yaml' } })).toBeTruthy();
    expect(ServerCreate.parse({ previewId: 'p1', slug: 'petstore', name: 'Petstore' })).toMatchObject({ previewId: 'p1' });
    expect(() => ServerCreate.parse({ slug: 'Pet_Store', name: 'x', source: { content: 'x' } })).toThrow();
    expect(ServerPatch.parse({ exposure: { mode: 'code' }, opsTools: { whoami: false } })).toBeTruthy();
  });
  it('upstream auth carries references, never literal secrets', () => {
    expect(UpstreamAuthIn.parse({ type: 'bearer', secretRef: 'env:GITHUB_TOKEN' })).toBeTruthy();
    expect(UpstreamAuthIn.parse({ type: 'header', headerName: 'X-API-Key', secretRef: 'secret:acme-key' })).toBeTruthy();
    expect(() => UpstreamAuthIn.parse({ type: 'bearer', secretRef: 'ghp_literal' })).toThrow(/Literal secrets/);
    expect(() => UpstreamAuthIn.parse({ type: 'header', headerName: 'bad header', secretRef: 'env:X' })).toThrow();
    expect(EnvironmentCreate.parse({ slug: 'dev', kind: 'dev', baseUrl: 'mock:' }).auth).toEqual({ type: 'none' });
  });
  it('writes config', () => {
    expect(WritesConfig.parse({ enabled: true, confirm: 'elicit', confirmEnvironmentSlug: 'prod' })).toBeTruthy();
    expect(() => WritesConfig.parse({ enabled: true, confirm: 'always' })).toThrow();
  });
  it('overlay draft patch: ops or yaml', () => {
    expect(OverlayDraftPatch.parse({ ops: [{ op: 'set', selector: 'operationId:listPets', field: 'hidden', value: true }] })).toBeTruthy();
    expect(OverlayDraftPatch.parse({ yaml: 'overlay: 1\n' })).toBeTruthy();
    expect(() => OverlayDraftPatch.parse({ ops: [] })).toThrow();
  });
  it('eval run create presets', () => {
    expect(EvalRunCreate.parse({ serverId: 's', preset: 'quick' })).toBeTruthy();
    expect(EvalRunCreate.parse({ serverId: 's', taskSet: 'failed_in:r1', overlay: { draft: true }, repeats: 3 })).toBeTruthy();
    expect(() => EvalRunCreate.parse({ serverId: 's', repeats: 6 })).toThrow();
    expect(() => EvalRunCreate.parse({ serverId: 's', taskSet: 'bogus' })).toThrow();
    expect(TranscriptItem.parse({ type: 'tool_call', id: 't1', tool: 'list_pets', arguments: {} })).toBeTruthy();
  });
  it('timeline items nest (script inner calls)', () => {
    const item = TimelineItem.parse({
      id: 's1', kind: 'script', ts: '2026-11-26T10:00:00.000Z', summary: 'run_script',
      children: [{ id: 'c1', kind: 'call', ts: '2026-11-26T10:00:00.100Z', summary: 'list_pets', via: 'script', decision: 'allowed', status: 'ok' }],
    });
    expect(item.children?.[0]?.via).toBe('script');
  });
});
