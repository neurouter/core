import { sql, type Kysely } from 'kysely';
import type { MainDB } from './schema.js';
import type { Dialect } from './url.js';

/**
 * Keeps the SQLite external-content FTS5 index (`tools_fts`) in sync with a build's `tools` rows
 * (Postgres uses a generated tsvector, so these are no-ops there). Builds are immutable, so rows
 * are indexed once on insert and removed when the build is deleted.
 */
export async function indexBuildTools(db: Kysely<MainDB>, dialect: Dialect, buildId: string): Promise<void> {
  if (dialect !== 'sqlite') return;
  await sql`insert into tools_fts(rowid, name, title, description, search_text) select seq, name, title, description, search_text from tools where build_id = ${buildId}`.execute(db);
}

export async function unindexBuildTools(db: Kysely<MainDB>, dialect: Dialect, buildId: string): Promise<void> {
  if (dialect !== 'sqlite') return;
  await sql`insert into tools_fts(tools_fts, rowid, name, title, description, search_text) select 'delete', seq, name, title, description, search_text from tools where build_id = ${buildId}`.execute(db);
}
