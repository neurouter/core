import { DEFAULT_TENANT_ID } from '@neurouter/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '../../kernel/lib/ids.js';
import { consoleOn, type TestContext } from '../fakes/app-context.js';
import { bootServer, keyFor, mcpClient } from '../fakes/server.js';

const counter = async (t: TestContext, name: string) => (await t.s.services.metrics.registry.getSingleMetric(name)?.get())?.values.reduce((a, v) => a + v.value, 0) ?? 0;

/**
 * Eval traffic (`api_keys.purpose = 'eval'`) gets the same ops-tool answers as live traffic, but never
 * reaches the inbox, need groups, ops metrics or usage_daily; inbox and analytics filter eval rows even
 * if some exist.
 */
describe('eval traffic isolation', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await consoleOn(await bootServer());
  }, 60_000);
  afterAll(async () => t?.close());

  const db = () => t.s.services.dbs.main.db;

  it('eval ops reports answer like live ones but are only audited; live reports still reach the inbox', async () => {
    const s = t.s;
    const ev = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read'], { purpose: 'eval' }));
    const b = await ev.callTool({ name: 'neurouter_begin_task', arguments: { goal: 'Book a vet' } });
    const evalTask = (b.structuredContent as { task_id: string }).task_id;
    const need = await ev.callTool({ name: 'neurouter_report_unmet_need', arguments: { intent: 'Book a vet appointment for my pet', attempted: ['find_pets_by_status'] } });
    expect(need.structuredContent).toMatchObject({ recorded: true, similar_reports: 0 });
    expect(typeof (need.structuredContent as { group_id: unknown }).group_id).toBe('string');
    const issue = await ev.callTool({ name: 'neurouter_report_issue', arguments: { tool: 'get_pet_by_id', problem: 'Returns the wrong pet' } });
    expect(issue.structuredContent).toMatchObject({ recorded: true });
    const dec = await ev.callTool({ name: 'neurouter_log_decision', arguments: { choice: 'decline', reason: 'no booking tool' } });
    expect(dec.structuredContent).toMatchObject({ recorded: true });
    await ev.callTool({ name: 'neurouter_end_task', arguments: { outcome: 'failure' } });
    await ev.close();

    expect(await db().selectFrom('unmet_needs').selectAll().execute()).toEqual([]);
    expect(await db().selectFrom('need_groups').selectAll().execute()).toEqual([]);
    expect(await db().selectFrom('issues').selectAll().execute()).toEqual([]);
    expect(await counter(t, 'neurouter_unmet_needs_total')).toBe(0);
    expect(await counter(t, 'neurouter_issues_total')).toBe(0);
    expect(await counter(t, 'neurouter_ops_calls_total')).toBe(0);
    expect(await counter(t, 'neurouter_tasks_total')).toBe(0);
    expect((await db().selectFrom('tasks').select('origin').where('id', '=', evalTask).executeTakeFirstOrThrow()).origin).toBe('eval');

    // the eval scorer reads the ops_call audit row: status ok, the intent in its params
    await s.services.auditStore.flush();
    const audit = await s.services.dbs.audit.db.selectFrom('audit_log').select(['tool_name', 'status', 'params_redacted', 'via']).where('task_id', '=', evalTask).where('kind', '=', 'ops_call').execute();
    const row = audit.find((r) => r.tool_name === 'neurouter_report_unmet_need')!;
    expect(row).toMatchObject({ status: 'ok', via: 'eval' });
    expect(JSON.parse(row.params_redacted!)).toMatchObject({ intent: 'Book a vet appointment for my pet' });

    // the eval task's trace still shows the reports (from the audit row), and the inbox shows nothing
    const task = await t.json(t.admin, { url: `/api/tasks/${evalTask}` }, 200);
    expect(task.origin).toBe('eval');
    expect(task.unmetNeeds).toEqual([]);
    const kinds = task.timeline.map((i: { kind: string; summary: string }) => `${i.kind}:${i.summary}`);
    expect(kinds).toEqual(expect.arrayContaining(['unmet_need:Book a vet appointment for my pet', 'issue:Returns the wrong pet', 'decision:decline — no booking tool']));
    expect(await t.json(t.admin, { url: '/api/inbox/summary' }, 200)).toEqual({ needs: { open: 0, new7d: 0 }, issues: { open: 0, new7d: 0 } });

    // live traffic is unchanged
    const live = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read']));
    const lb = await live.callTool({ name: 'neurouter_begin_task', arguments: { goal: 'Book a vet' } });
    const liveTask = (lb.structuredContent as { task_id: string }).task_id;
    const ln = await live.callTool({ name: 'neurouter_report_unmet_need', arguments: { intent: 'Book a vet appointment for my pet' } });
    expect(ln.structuredContent).toMatchObject({ recorded: true, similar_reports: 0 });
    await live.callTool({ name: 'neurouter_report_issue', arguments: { tool: 'get_pet_by_id', problem: 'Returns the wrong pet' } });
    await live.close();
    expect(await db().selectFrom('unmet_needs').select('task_id').execute()).toEqual([{ task_id: liveTask }]);
    expect(await counter(t, 'neurouter_unmet_needs_total')).toBe(1);
    expect(await t.json(t.admin, { url: '/api/inbox/summary' }, 200)).toMatchObject({ needs: { open: 1 }, issues: { open: 1 } });
    expect((await t.json(t.admin, { url: '/api/tasks?origin=eval' }, 200)).items.map((x: { id: string }) => x.id)).toEqual([evalTask]);
    expect((await t.json(t.admin, { url: '/api/tasks?origin=agent' }, 200)).items.map((x: { id: string }) => x.id)).toEqual([liveTask]);
  }, 60_000);

  it('eval tool calls are not counted in usage_daily (direct or inside scripts)', async () => {
    const s = t.s;
    const ev = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read', 'code:run'], { purpose: 'eval' }));
    await ev.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 1 } });
    await ev.callTool({ name: 'run_script', arguments: { code: 'return petstore.get_pet_by_id(pet_id=2)["id"]' } });
    await ev.close();
    const live = await mcpClient(s, 'petstore', 'dev', await keyFor(s, 'petstore', 'dev', ['tools:read']));
    await live.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 3 } });
    await live.close();
    await s.services.auditStore.flush();
    const evalRows = await s.services.dbs.audit.db.selectFrom('audit_log').select(['via']).where('kind', '=', 'tool_call').where('tool_name', '=', 'get_pet_by_id').where('via', 'in', ['eval', 'script']).execute();
    expect(evalRows.map((r) => r.via).sort()).toEqual(['eval', 'script']);
    let calls = -1;
    for (let i = 0; i < 50 && calls !== 1; i++) {
      calls = Number((await db().selectFrom('usage_daily').select('calls').where('tool_name', '=', 'get_pet_by_id').executeTakeFirst())?.calls ?? 0);
      if (calls !== 1) await new Promise((r) => setTimeout(r, 20));
    }
    expect(calls).toBe(1);
  }, 60_000);

  it('defense in depth: inbox, badges and overview ignore eval-origin rows that exist anyway', async () => {
    const s = t.s;
    const d = db();
    const evalTask = (await d.selectFrom('tasks').select(['id', 'server_id', 'environment_id', 'credential_key']).where('origin', '=', 'eval').executeTakeFirstOrThrow());
    const now = s.services.clock.now();
    const g = newId();
    await d.insertInto('need_groups').values({ id: g, tenant_id: DEFAULT_TENANT_ID, server_id: evalTask.server_id, label: 'Planted eval group', intent_norm_hash: 'planted', count: 1, distinct_principals: 1, first_seen_at: now, last_seen_at: now, status: 'open', note: null, centroid: null }).execute();
    await d.insertInto('unmet_needs').values({ id: newId(), tenant_id: DEFAULT_TENANT_ID, group_id: g, server_id: evalTask.server_id, environment_id: evalTask.environment_id, task_id: evalTask.id, user_id: null, credential_key: evalTask.credential_key, client_name: null, intent: 'Planted eval need', attempted: '[]', created_at: now, audit_id: null }).execute();
    // an eval report in the live group too
    const liveGroup = (await d.selectFrom('need_groups').select('id').where('label', '!=', 'Planted eval group').executeTakeFirstOrThrow()).id;
    await d.insertInto('unmet_needs').values({ id: newId(), tenant_id: DEFAULT_TENANT_ID, group_id: liveGroup, server_id: evalTask.server_id, environment_id: evalTask.environment_id, task_id: null, user_id: null, credential_key: evalTask.credential_key, client_name: null, intent: 'Planted eval need in live group', attempted: '[]', created_at: now, audit_id: null }).execute();
    await d.insertInto('issues').values({ id: newId(), tenant_id: DEFAULT_TENANT_ID, server_id: evalTask.server_id, environment_id: evalTask.environment_id, task_id: evalTask.id, tool_name: 'get_pet_by_id', problem: 'Planted eval issue', evidence: null, related_audit_id: null, status: 'open', note: null, created_at: now, updated_at: now }).execute();

    expect(await t.json(t.admin, { url: '/api/inbox/summary' }, 200)).toMatchObject({ needs: { open: 1 }, issues: { open: 1 } });
    const groups = await t.json(t.admin, { url: '/api/inbox/needs' }, 200);
    expect(groups.items.map((x: { label: string }) => x.label)).toEqual(['Book a vet appointment for my pet']);
    const detail = await t.json(t.admin, { url: `/api/inbox/needs/${liveGroup}` }, 200);
    expect(detail.reports.items.map((x: { intent: string }) => x.intent)).toEqual(['Book a vet appointment for my pet']);
    expect(detail.sampleIntents).toEqual(['Book a vet appointment for my pet']);
    const list = await t.json(t.admin, { url: '/api/inbox' }, 200);
    expect(list.items.map((x: { title: string }) => x.title).sort()).toEqual(['Book a vet appointment for my pet', 'Returns the wrong pet']);
    const issues = await t.json(t.admin, { url: '/api/inbox/issues' }, 200);
    expect(issues.items.map((x: { problem: string }) => x.problem)).toEqual(['Returns the wrong pet']);
    const me = await t.json(t.admin, { url: '/api/me' }, 200);
    expect(me.badges.inboxOpen).toBe(2);
    const overview = await t.json(t.admin, { url: '/api/metrics/overview' }, 200);
    expect(overview.kpis).toMatchObject({ unmetNeedsOpen: 1, issuesOpen: 1 });
    expect(overview.recentTasks.every((x: { origin: string }) => x.origin === 'agent')).toBe(true);
  }, 60_000);
});
