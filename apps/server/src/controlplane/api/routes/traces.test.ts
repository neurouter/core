import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { bootServer, keyFor, mcpClient } from '../../../test/fakes/server.js';
import { consoleOn, type TestContext } from '../../../test/fakes/app-context.js';

/** Real HTTP server + MCP client: tasks timeline (§19.2 scenario 3), keys, inbox grouping, audit verify. */
describe('tasks, keys, inbox, audit (agent traffic)', () => {
  let t: TestContext;
  let c: Client;
  let taskId: string;
  let serverId: string;
  beforeAll(async () => {
    t = await consoleOn(await bootServer());
    serverId = (await t.s.services.servers.bySlug(t.s.services.tenantId, 'petstore'))!.id;
  }, 90_000);
  afterAll(async () => {
    await c?.close().catch(() => {});
    await t?.close();
  });

  it('keys API: create (secret once, connect snippets, warnings), list hides eval keys, revoke', async () => {
    const envs = await t.json(t.admin, { url: `/api/servers/${serverId}/environments` }, 200);
    const dev = envs.items.find((e: any) => e.slug === 'dev');
    const out = await t.json(t.admin, { method: 'POST', url: '/api/keys', payload: { name: 'agent', serverId, environmentId: dev.id, scopes: ['tools:read', 'tools:write', 'code:run'] } }, 201);
    expect(out.token).toMatch(/^nrk_live_/);
    expect(out.connect.mcpUrl).toContain('/mcp/petstore/dev');
    await keyFor(t.s, 'petstore', 'dev', ['tools:read'], { purpose: 'eval' });
    const list = await t.json(t.admin, { url: '/api/keys' }, 200);
    expect(list.items.every((k: any) => k.name !== 'test dev')).toBe(true);
    expect(JSON.stringify(list)).not.toContain(out.token);
    c = await mcpClient(t.s, 'petstore', 'dev', out.token);
    const other = await t.json(t.admin, { method: 'POST', url: '/api/keys', payload: { name: 'tmp', serverId, environmentId: dev.id, scopes: ['tools:read'] } }, 201);
    expect((await t.json(t.admin, { method: 'POST', url: `/api/keys/${other.key.id}/revoke` }, 200)).status).toBe('revoked');
  });

  it('timeline: begin → search → call → script (nested calls) → unmet need → end', async () => {
    const begin = await c.callTool({ name: 'neurouter_begin_task', arguments: { goal: 'Find available pets and count them' } });
    taskId = (begin.structuredContent as { task_id: string }).task_id;
    await c.callTool({ name: 'search_tools', arguments: { query: 'find pets by status' } });
    await c.callTool({ name: 'find_pets_by_status', arguments: { status: 'available' } });
    const script = await c.callTool({ name: 'run_script', arguments: { code: 'pets = petstore.find_pets_by_status(status="available")\nfirst = petstore.get_pet_by_id(pet_id=1)\nreturn {"count": len(pets), "first": first["id"]}' } });
    expect(script.isError, JSON.stringify(script.content)).toBeFalsy();
    await c.callTool({ name: 'neurouter_report_unmet_need', arguments: { intent: 'Export all pets as a CSV file' } });
    await c.callTool({ name: 'neurouter_end_task', arguments: { outcome: 'success' } });
    await t.s.services.auditStore.flush();
    const d = await t.json(t.admin, { url: `/api/tasks/${taskId}` }, 200);
    const kinds = d.timeline.map((x: any) => x.kind);
    expect(kinds[0]).toBe('task_begin');
    expect(kinds).toEqual(expect.arrayContaining(['search', 'call', 'script', 'unmet_need', 'task_end']));
    const s = d.timeline.find((x: any) => x.kind === 'script');
    expect(s.children.map((x: any) => x.tool)).toEqual(['find_pets_by_status', 'get_pet_by_id']);
    expect(d).toMatchObject({ framing: 'explicit', outcome: 'success', goal: 'Find available pets and count them', origin: 'agent' });
    expect(d.unmetNeeds).toHaveLength(1);
    const call = d.timeline.find((x: any) => x.kind === 'call');
    const cd = await t.json(t.admin, { url: `/api/calls/${call.auditId}` }, 200);
    expect(cd.policyTrail.map((p: any) => p.step)).toContain('resolve');
    const sd = await t.json(t.admin, { url: `/api/scripts/${s.scriptRunId}` }, 200);
    expect(sd).toMatchObject({ status: 'ok', mode: 'execute' });
    expect(sd.calls).toHaveLength(2);
    const list = await t.json(t.admin, { url: '/api/tasks' }, 200);
    expect(list.items.some((x: any) => x.id === taskId)).toBe(true);
    const ev = await t.json(t.admin, { url: `/api/tasks/${taskId}/events?limit=2` }, 200);
    expect(ev.items).toHaveLength(2);
    expect(ev.nextCursor).not.toBeNull();
  });

  it('inbox groups similar unmet needs; triage, split, merge, markdown', async () => {
    await c.callTool({ name: 'neurouter_report_unmet_need', arguments: { intent: 'export all the pets as CSV file' } });
    const groups = await t.json(t.admin, { url: '/api/inbox/needs' }, 200);
    expect(groups.items).toHaveLength(1);
    expect(groups.items[0].count).toBe(2);
    const g = await t.json(t.admin, { url: `/api/inbox/needs/${groups.items[0].id}` }, 200);
    expect(g.reports.items).toHaveLength(2);
    const split = await t.json(t.admin, { method: 'POST', url: `/api/inbox/needs/reports/${g.reports.items[0].id}/split` }, 200);
    expect(split.count).toBe(1);
    const merged = await t.json(t.admin, { method: 'POST', url: `/api/inbox/needs/${split.id}/merge`, payload: { intoGroupId: g.id } }, 200);
    expect(merged.count).toBe(2);
    expect((await t.json(t.admin, { method: 'PATCH', url: `/api/inbox/needs/${g.id}`, payload: { status: 'planned', note: 'Q1' } }, 200)).status).toBe('planned');
    const md = await t.json(t.admin, { url: `/api/inbox/needs/${g.id}/markdown` }, 200);
    expect(md.markdown).toContain('Unmet need');
    await c.callTool({ name: 'neurouter_report_issue', arguments: { tool: 'find_pets_by_status', problem: 'Returns sold pets too' } });
    const issues = await t.json(t.admin, { url: '/api/inbox/issues' }, 200);
    expect(issues.items).toHaveLength(1);
    expect((await t.json(t.admin, { url: `/api/inbox/issues/${issues.items[0].id}` }, 200)).tool).toBe('find_pets_by_status');
    const sum = await t.json(t.admin, { url: '/api/inbox/summary' }, 200);
    expect(sum.issues.open).toBe(1);
  });

  it('events.stream (SSE) emits call.recorded for agent calls', async () => {
    const ac = new AbortController();
    const res = await fetch(`${t.s.url}/api/events/stream?topics=calls`, { headers: { cookie: t.admin.cookie }, signal: ac.signal });
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    let buf = '';
    const got = (async () => {
      while (!buf.includes('event: call.recorded')) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += new TextDecoder().decode(value);
      }
    })();
    await c.callTool({ name: 'get_pet_by_id', arguments: { pet_id: 2 } });
    await t.s.services.auditStore.flush();
    await Promise.race([got, new Promise((r) => setTimeout(r, 3000))]);
    ac.abort();
    expect(buf).toContain('event: call.recorded');
  });

  it('metrics overview/timeseries/tool usage; audit list/get/verify job', async () => {
    const o = await t.json(t.admin, { url: '/api/metrics/overview' }, 200);
    expect(o.kpis.calls).toBeGreaterThan(0);
    expect(o.kpis.scriptRuns).toBe(1);
    const ts = await t.json(t.admin, { url: '/api/metrics/timeseries?metric=calls&groupBy=mode' }, 200);
    expect(ts.series.map((x: any) => x.key).sort()).toEqual(['code', 'tool']);
    const tools = await t.json(t.admin, { url: `/api/servers/${serverId}/tools?q=find_pets_by_status` }, 200);
    const u = await t.json(t.admin, { url: `/api/tools/${tools.items[0].id}/usage` }, 200);
    expect(u.calls).toBeGreaterThanOrEqual(2);
    expect(u.byMode).toMatchObject({ tool: 1, code: 1 });
    const audit = await t.json(t.admin, { url: `/api/audit?taskId=${taskId}` }, 200);
    expect(audit.items.length).toBeGreaterThan(5);
    const one = await t.json(t.admin, { url: `/api/audit/${audit.items[0].id}` }, 200);
    expect(one.chain.hash).toMatch(/^[0-9a-f]{64}$/);
    const job = await t.json(t.admin, { method: 'POST', url: '/api/audit/verify', payload: {} }, 202);
    await t.s.services.jobs.idle();
    const j = await t.json(t.admin, { url: `/api/jobs/${job.jobId}` }, 200);
    expect(j).toMatchObject({ status: 'succeeded', result: { ok: true } });
    const exp = await t.as(t.admin, { url: '/api/audit/export?format=csv' });
    expect(exp.body.split('\n')[0]).toContain('seq');
  });
});
