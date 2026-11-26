import type { FastifyInstance } from 'fastify';
import { api, readinessBand, type ReadinessBand } from '@neurouter/shared';
import { toIso } from '../../../kernel/lib/clock.js';
import { AppError } from '../../../kernel/lib/errors.js';
import { parseJsonColumn } from '../../../kernel/lib/json.js';
import type { ApiContext } from '../context.js';
import { route } from '../routes.js';

const BAND_COLOR: Record<ReadinessBand, string> = { not_ready: '#e05d44', needs_work: '#dfb317', ready: '#97ca00', excellent: '#4c1' };

/** shields.io-style flat badge, inline text, no external fonts. */
export function badgeSvg(label: string, value: string, color: string): string {
  const w = (s: string) => Math.round(s.length * 6.6 + 12);
  const lw = w(label);
  const vw = w(value);
  const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient><clipPath id="r"><rect width="${lw + vw}" height="20" rx="3" fill="#fff"/></clipPath><g clip-path="url(#r)"><rect width="${lw}" height="20" fill="#555"/><rect x="${lw}" width="${vw}" height="20" fill="${color}"/><rect width="${lw + vw}" height="20" fill="url(#s)"/></g><g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

/** `public.report`, `public.badge` (§14.14): only for servers with `publicReport` and a measured run. */
export async function publicRoutes(app: FastifyInstance, c: ApiContext): Promise<void> {
  const db = c.dbs.main.db;
  const measured = async (slug: string) => {
    if (!c.config.env.NEUROUTER_PUBLIC_REPORTS) throw AppError.notFound('Report');
    const s = await db.selectFrom('servers').selectAll().where('tenant_id', '=', c.tenantId).where('slug', '=', slug).executeTakeFirst();
    if (!s || s.public_report !== 1 || s.status !== 'active') throw AppError.notFound('Report');
    const run = await db.selectFrom('eval_runs').selectAll().where('server_id', '=', s.id).where('status', '=', 'succeeded').where('trigger', '!=', 'suggestion_verify').where('headline', 'is not', null).orderBy('created_at', 'desc').limit(1).executeTakeFirst();
    if (!run) throw AppError.notFound('Report');
    return { s, run };
  };

  route(app, 'public.report', api.public.report, async (req, reply) => {
    const { s, run } = await measured(req.params.slug);
    const score = parseJsonColumn<{ modeScores?: { tool?: number; code?: number }; cells?: Array<{ model: string; mode: 'tool' | 'code'; score: number }> }>(run.score) ?? {};
    const models = parseJsonColumn<string[]>(run.models) ?? [];
    const cells = score.cells ?? [];
    const spec = s.current_spec_revision_id ? await db.selectFrom('spec_revisions').select('title').where('id', '=', s.current_spec_revision_id).executeTakeFirst() : null;
    const build = await db.selectFrom('builds').select('visible_count').where('id', '=', run.build_id).executeTakeFirst();
    const names = models.length ? models : [...new Set(cells.map((x) => x.model))];
    const cell = (m: string, mode: 'tool' | 'code') => {
      const x = cells.find((y) => y.model === m && y.mode === mode);
      return x ? Math.round(x.score) : null;
    };
    reply.header('cache-control', 'public, max-age=300');
    const ms = score.modeScores ?? {};
    return {
      server: { name: s.name, slug: s.slug, description: s.description },
      score: Math.round(run.headline!),
      band: readinessBand(run.headline!),
      confidence: (run.confidence === 'degraded' ? 'degraded' : 'measured') as 'degraded' | 'measured',
      recommendedMode: run.recommended_mode === 'tool' || run.recommended_mode === 'code' ? (run.recommended_mode as 'tool' | 'code') : null,
      modeScores: { ...(typeof ms.tool === 'number' ? { tool: Math.round(ms.tool) } : {}), ...(typeof ms.code === 'number' ? { code: Math.round(ms.code) } : {}) },
      models: names.map((m) => ({ model: m, toolScore: cell(m, 'tool'), codeScore: cell(m, 'code') })),
      measuredAt: toIso(run.ended_at ?? run.created_at),
      specTitle: spec?.title ?? s.name,
      toolCount: build?.visible_count ?? 0,
    };
  });

  route(app, 'public.badge', api.public.badge, async (req, reply) => {
    let svg: string;
    try {
      const { run } = await measured(req.params.slug);
      const sc = Math.round(run.headline!);
      svg = badgeSvg('agent-ready', String(sc), BAND_COLOR[readinessBand(sc)]);
    } catch (err) {
      if (!(err instanceof AppError) || err.code !== 'not_found') throw err;
      return reply.status(404).header('content-type', 'image/svg+xml').header('cache-control', 'public, max-age=300').send(badgeSvg('agent-ready', 'unknown', '#9f9f9f'));
    }
    return reply.header('content-type', 'image/svg+xml').header('cache-control', 'public, max-age=300').send(svg);
  });
}
