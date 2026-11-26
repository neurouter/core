import type { Kysely } from 'kysely';
import type { MainDB } from '../../kernel/db/schema.js';
import type { Embedder } from './embedder.js';
import { fuseRankings } from './hybrid.js';
import type { KeywordIndex } from './keyword-index.js';
import type { VectorIndex } from './vector-index.js';

/** Candidates taken from each ranked list before fusion. */
export const LIST_DEPTH = 50;

export type SearchMode = 'hybrid' | 'keyword';

export interface RankedTool {
  id: string;
  name: string;
  score: number;
}

/**
 * Tool search (§9.4, COPY/ADAPT Hub search.service): the caller passes the ACL-allowed tool ids
 * (visible tools of the build the principal may call), nothing else is ever scored (ACL before
 * ranking). Keyword list (FTS5 bm25 / ts_rank_cd) + vector list (cosine over local embeddings,
 * skipped until the model is ready) fused by RRF (k = 60) + exact-name boost.
 */
export class ToolSearchService {
  constructor(
    private readonly db: Kysely<MainDB>,
    private readonly keyword: KeywordIndex,
    private readonly vectors: VectorIndex | null = null,
    private readonly embedder: Embedder | null = null,
    private readonly log?: { debug: (o: object, m: string) => void },
  ) {}

  mode(): SearchMode {
    return this.vectors && this.embedder?.status() === 'ready' ? 'hybrid' : 'keyword';
  }

  private async vectorList(query: string, ids: readonly string[]): Promise<string[]> {
    if (!this.vectors || !this.embedder || this.embedder.status() !== 'ready') return [];
    try {
      const q = await this.embedder.embedQuery(query);
      return (await this.vectors.search(q, ids, this.embedder.modelId, LIST_DEPTH)).map((h) => h.toolId);
    } catch (err) {
      this.log?.debug({ err }, 'vector search skipped; keyword-only for this request');
      return [];
    }
  }

  /** `allowed`: tool row id → exposed name. */
  async search(query: string, allowed: ReadonlyMap<string, string>, limit: number): Promise<{ ranked: RankedTool[]; mode: SearchMode }> {
    const ids = [...allowed.keys()];
    if (!ids.length) return { ranked: [], mode: this.mode() };
    const q = query.trim().toLowerCase();
    const [kw, vec] = await Promise.all([this.keyword.search(query, ids, LIST_DEPTH), this.vectorList(query, ids)]);
    const exact = new Set(ids.filter((id) => allowed.get(id)?.toLowerCase() === q || allowed.get(id)?.toLowerCase() === q.replace(/\s+/g, '_')));
    const mode: SearchMode = vec.length ? 'hybrid' : 'keyword';
    const fused = fuseRankings({ lists: [kw.map((h) => h.toolId), vec], allowed: new Set(ids), names: new Map(allowed), exact, limit: Math.max(limit * 3, 25) });
    // name-coverage boost: prefer tools whose name words are all asked for (create an issue → issues_create
    // before issues_create_comment). Small enough to only reorder near-ties of the fused ranking.
    const qWords = new Set(stemWords(query));
    const ranked = fused
      .map((c) => {
        const words = stemWords(allowed.get(c.id) ?? '').filter((w) => !NAME_STOP.has(w));
        const hit = (w: string) => qWords.has(w) || [...qWords].some((q) => q.length >= 4 && w.length >= 4 && (q.startsWith(w) || w.startsWith(q)));
        const covered = words.length ? words.filter(hit).length / words.length : 0;
        return { ...c, score: c.score + covered * 0.01 };
      })
      .sort((a, b) => b.score - a.score || (allowed.get(a.id) ?? '').localeCompare(allowed.get(b.id) ?? ''))
      .slice(0, limit);
    return { mode, ranked: ranked.map((c) => ({ id: c.id, name: allowed.get(c.id) ?? '', score: Math.round(c.score * 1e6) / 1e6 })) };
  }
}

/** Connector words that carry no meaning in tool names (`issues_list_for_repo`). */
const NAME_STOP = new Set(['for', 'by', 'in', 'of', 'the', 'a', 'an', 'to', 'on', 'and', 'or', 'with', 'from']);

/** Lower-cased word stems (`issues_create` → issue, create). */
export function stemWords(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9]+/g) ?? []).map((w) => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w));
}
