import type { FastifyInstance, FastifyRequest } from 'fastify';
import { api } from '@neurouter/shared';
import { toIso } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { environmentRuntime } from '../../../kernel/runtime-config.js';
import { requireUser } from '../../auth/guards.js';
import { assertConsoleManaged, assertWithinCodeCap, EnvironmentsService, type EnvRow } from '../../environments/environments.service.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';
import { serverOr404 } from './servers.js';

/** `environments.*`, `writeSwitches.get` (§14.7, §14.15). */
export async function environmentRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const envs = new EnvironmentsService(db, c.clock, c.coord, c.config, c.tenantId);
  const detail = async (req: FastifyRequest, e: EnvRow) => {
    const u = req.webAuth?.user;
    const connected = u && c.ports.upstreamConnected ? await c.ports.upstreamConnected(e.id, u.id).catch(() => false) : false;
    return c.views.envDetail(e, { anonymous: Boolean(u?.anonymous), ...(u ? { userId: u.id } : {}), connected });
  };
  const writeToolsOf = async (e: EnvRow): Promise<string[]> => {
    if (!e.build_id) return [];
    return (await db.selectFrom('tools').select('name').where('build_id', '=', e.build_id).where('write', '=', 1).where('hidden', '=', 0).execute()).map((t) => t.name);
  };

  route(app, 'environments.list', api.environments.list, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const list = await c.servers.environments(s.id);
    return { items: await Promise.all(list.map((e) => detail(req, e))) };
  });
  route(app, 'environments.create', api.environments.create, async (req, reply) => {
    const s = await serverOr404(c, req.params.id);
    assertWithinCodeCap(req.body.limits, await c.settings.get('codeLimitsCap'));
    const e = await envs.create(s.id, req.body);
    reply.status(201);
    return detail(req, e);
  });
  route(app, 'environments.get', api.environments.get, async (req) => detail(req, await envs.get(req.params.id)));
  route(app, 'environments.update', api.environments.update, async (req) => {
    assertWithinCodeCap(req.body.limits, await c.settings.get('codeLimitsCap'));
    return detail(req, await envs.update(req.params.id, req.body));
  });
  route(app, 'environments.delete', api.environments.delete, async (req) => {
    await envs.delete(req.params.id, req.query.confirm);
  });
  route(app, 'environments.setWrites', api.environments.setWrites, async (req) => detail(req, await envs.setWrites(req.params.id, req.body)));
  route(app, 'environments.setToolWrite', api.environments.setToolWrite, async (req) => {
    const e = await envs.get(req.params.id);
    return detail(req, await envs.setToolWrite(e.id, req.params.toolName, req.body, await writeToolsOf(e)));
  });
  route(app, 'environments.pinBuild', api.environments.pinBuild, async (req) => {
    const e = await envs.get(req.params.id);
    if (e.kind === 'prod') assertConsoleManaged(c.config, { ...e, managed_by: 'console' }, 'This environment');
    return detail(req, await envs.pinBuild(e.id, req.body.buildId));
  });
  route(app, 'environments.setSecret', api.environments.setSecret, async (req) => {
    const u = requireUser(req);
    const e = await envs.get(req.params.id);
    const out = await c.namedSecrets.set(c.tenantId, 'environment', e.id, req.params.name, req.body.value, u.id);
    c.runtime.invalidate();
    return { name: req.params.name, ref: `secret:${req.params.name}`, updatedAt: toIso(out.updatedAt) };
  });
  route(app, 'environments.deleteSecret', api.environments.deleteSecret, async (req) => {
    const e = await envs.get(req.params.id);
    if (!(await c.namedSecrets.delete(c.tenantId, 'environment', e.id, req.params.name))) throw AppError.notFound('Secret');
    c.runtime.invalidate();
  });
  route(app, 'environments.test', api.environments.test, async (req) => {
    const u = requireUser(req);
    const e = await envs.get(req.params.id);
    if (u.anonymous && !e.base_url.startsWith('mock:')) throw new AppError('forbidden', 'The public demo only tests mock environments', { extensions: { reason: 'demo_read_only' } });
    const out = await c.ports.testEnvironment(e.id, req.body.toolName, req.body.arguments, u.id);
    if (!req.body.toolName) await envs.recordHealth(e.id, { status: out.ok ? 'up' : 'down', latencyMs: out.latencyMs, error: out.ok ? null : (out.detail ?? null) });
    return out;
  });
  route(app, 'environments.resetMock', api.environments.resetMock, async (req) => {
    const e = await envs.get(req.params.id);
    if (!e.base_url.startsWith('mock:')) throw AppError.validation('Not a mock environment', [{ path: ['id'], message: 'baseUrl is not mock:', code: 'not_mock' }]);
    c.ports.resetMock(e.id, req.body.seed);
  });
  route(app, 'environments.testDraft', api.environments.testDraft, async (req) => {
    const p = await db.selectFrom('spec_previews').select(['id', 'expires_at']).where('id', '=', req.params.id).executeTakeFirst();
    if (!p || p.expires_at <= c.clock.now()) throw AppError.notFound('Spec preview');
    if (req.body.baseUrl === 'mock:') return { ok: true, latencyMs: 0, credential: 'not_required' as const };
    const u = requireUser(req);
    if (u.anonymous) throw new AppError('forbidden', 'The public demo only tests mock environments', { extensions: { reason: 'demo_read_only' } });
    const a = req.body.auth;
    const ref = 'secretRef' in a ? a.secretRef : 'clientSecretRef' in a ? a.clientSecretRef : undefined;
    const credential = a.type === 'none' ? 'not_required' : ref?.startsWith('env:') ? (process.env[ref.slice(4)] ? 'ok' : 'missing') : 'missing';
    const t0 = c.clock.now();
    try {
      const { createSafeFetch } = await import('../../../kernel/lib/net/safe-fetch.js');
      const { upstreamPolicy, proxyOptions } = await import('../../../kernel/lib/net/policy.js');
      const f = createSafeFetch({ policy: upstreamPolicy(c.config, true), ...proxyOptions(c.config), maxBytes: 64 * 1024, timeoutMs: 5000 });
      const res = await f(req.body.baseUrl, { method: 'HEAD' });
      await f.close();
      return { ok: res.status < 500, latencyMs: c.clock.now() - t0, status: res.status, credential: credential as 'ok' | 'missing' | 'not_required' };
    } catch (err) {
      return { ok: false, latencyMs: null, credential: credential as 'ok' | 'missing' | 'not_required', detail: (err as Error).message.slice(0, 300) };
    }
  });

  route(app, 'writeSwitches.get', api.writeSwitches.get, async (req) => {
    const s = await serverOr404(c, req.params.id);
    const list = await c.servers.environments(s.id);
    const buildId = s.latest_build_id;
    const tools = buildId ? await db.selectFrom('tools').select(['name', 'title', 'def']).where('build_id', '=', buildId).where('write', '=', 1).where('hidden', '=', 0).orderBy('name').execute() : [];
    const rts = list.map((e) => ({ e, rt: environmentRuntime(e) }));
    return {
      environments: rts.map(({ e, rt }) => ({ id: e.id, slug: e.slug, kind: e.kind, writesEnabled: rt.writes.enabled, confirm: rt.writes.confirm, managedBy: e.managed_by })),
      tools: tools.map((t) => {
        const def = JSON.parse(typeof t.def === 'string' ? t.def : JSON.stringify(t.def)) as { risk?: { destructive?: boolean } };
        return { name: t.name, title: t.title, destructive: Boolean(def.risk?.destructive), cells: Object.fromEntries(rts.map(({ e, rt }) => [e.slug, rt.writes.enabled && (rt.writes.tools === null || rt.writes.tools.includes(t.name))])) };
      }),
    };
  });
}
