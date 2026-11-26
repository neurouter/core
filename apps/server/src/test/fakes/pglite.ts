import { Kysely, PostgresDialect } from 'kysely';
import type { PoolConfig } from 'pg';
import { EmptyInListPlugin } from '../../kernel/db/empty-in-plugin.js';
import { installPgTypeParsers } from '../../kernel/db/postgres.js';

/**
 * An in-process Postgres (PGlite, WASM) behind Kysely's PostgresDialect via node-postgres, with the
 * app's pg type parsers (int8 → number, json → text). No pgvector: use it for migrations and stores
 * that don't need the full chain (0001 needs the vector extension).
 */
export async function pgliteKysely<DB>(): Promise<{ db: Kysely<DB>; close: () => Promise<void> }> {
  const { PGlite } = await import('@electric-sql/pglite');
  const { createPgConfig } = await import('@electric-sql/pglite/node-postgres');
  const pg = (await import('pg')).default;
  installPgTypeParsers();
  const lite = new PGlite();
  const pool = new pg.Pool(createPgConfig(lite) as unknown as PoolConfig);
  const db = new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new EmptyInListPlugin()] });
  return {
    db,
    close: async () => {
      await db.destroy();
      await lite.close();
    },
  };
}
