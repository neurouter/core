import { describe, expect, it } from 'vitest';
import { ALL_ENDPOINTS, buildPath } from '@/contract';
import { createDb } from './db';
import { contractFixtures, type Resolver } from './fixtures';

/** Every GET fixture of the demo dataset parses against its contract schema (spec §12). */
describe('demo fixtures', () => {
  const params: Record<string, string> = { id: 'srv_acme_orders', groupId: 'need_bulk_refund', auditId: 'aud_01JDX8K1', reportId: 'need_bulk_refund_r0', slug: 'acme-orders', taskRunId: 'trun.run_14.t01.gpt-6-luna.tool', toolName: 'create_refund', name: 'X' };
  const idFor: Record<string, string> = {
    'tools.get': 'srv_acme_orders__customersSearch', 'tools.diff': 'srv_acme_orders__customersSearch', 'metrics.toolUsage': 'srv_acme_orders__customersSearch', 'tasks.get': 'task_flag_unpaid', 'tasks.events': 'task_flag_unpaid',
    'scripts.get': 'scr_dry', 'inbox.issue': 'iss_total_string', 'inbox.exportIssueMarkdown': 'iss_total_string', 'evals.run': 'run_14', 'evals.runTasks': 'run_14', 'evals.taskRun': 'run_14', 'suggestions.list': 'run_14',
    'suggestions.get': 'sug_rename_list_orders', 'specs.get': 'spec_acme-orders_3', 'overlays.getVersion': 'ovl_acme-orders_4', 'builds.get': 'bld_acme-orders_4', 'builds.stubs': 'bld_acme-orders_4', 'environments.get': 'env_acme-orders_prod',
    'audit.get': 'aud_admin_0', 'evals.suite': 'suite_acme-orders_2', 'jobs.get': 'job_audit_verify', 'specs.diff': 'spec_acme-orders_3',
  };
  const query: Record<string, string> = { 'evals.compare': '?base=run_14&head=run_18', 'overlays.diff': '?from=4&to=draft', 'specs.diff': '?against=spec_acme-orders_2', 'tools.search': '?q=refund', 'tools.searchAll': '?q=order', 'tools.diff': '?against=bld_acme-orders_3', 'metrics.timeseries': '?metric=calls' };
  const db = createDb({ speed: 0 });
  const fixtures = contractFixtures(db);
  for (const { key, def } of ALL_ENDPOINTS) {
    // specs.draft needs a preview created first (covered by the wizard tests)
    if (def.method !== 'GET' || def.kind !== 'json' || !def.response || key === 'specs.draft') continue;
    it(key, async () => {
      const p = { ...params, ...(idFor[key] ? { id: idFor[key] } : {}) };
      const url = `http://mock${buildPath(def.path, p)}${query[key] ?? ''}`;
      const f = fixtures[key];
      const value = typeof f === 'function' ? await (f as Resolver)({ request: new Request(url), params: p }) : f;
      expect(value).not.toBeInstanceOf(Response);
      const parsed = def.response!.safeParse(value);
      expect(parsed.success ? 'ok' : parsed.error.message).toBe('ok');
    });
  }
});
