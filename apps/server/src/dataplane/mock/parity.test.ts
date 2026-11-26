import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Kysely } from 'kysely';
import { compile, handleMockRequest, MemoryMockStateStore, type MockNs, type MockResponse, type MockStateStore, type OpenApiMockModel } from '@neurouter/compiler';
import { m0009_mock_state } from '../../kernel/db/migrations/main/0009_mock_state.js';
import type { MainDB } from '../../kernel/db/schema.js';
import { recordedSession } from '../../test/fakes/mock-session.js';
import { pgliteKysely } from '../../test/fakes/pglite.js';
import { createTestDatabases } from '../../test/fakes/test-db.js';
import { DbMockStateStore } from './db-store.js';

const REPO = resolve(import.meta.dirname, '../../../../..');
const SPECS = { github: 'examples/github/github-subset.json', petstore: 'examples/petstore/openapi.yaml', acme: 'examples/acme-orders/openapi.yaml' } as const;
/** Recorded on the in-memory `MockStore` (first on v0.1.1; re-recorded in 0.2.1 for schema-valid values and scope-independent seeds). */
const GOLDEN_FILE = resolve(import.meta.dirname, 'mock-session.golden.json');
const GOLDEN = JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')) as Record<string, Array<{ ns: string; req: string; status: number; sha: string }>>;
const FIXED = () => Date.parse('2026-02-01T00:00:00Z');
const TENANT = '0190a0b0-0000-7000-8000-0000000000a1';
const ENV: MockNs = { tenantId: TENANT, environmentId: '0190a0b0-0000-7000-8000-0000000000e1', name: 'env' };
const EVAL: MockNs = { ...ENV, name: 'eval:0190a0b0-0000-7000-8000-000000000001:task-1' };

async function replay(model: OpenApiMockModel, store: MockStateStore): Promise<Array<{ ns: string; req: string; res: MockResponse }>> {
  const reqs = recordedSession(model);
  for (const ns of [ENV, EVAL]) await store.reset(ns);
  const out = [];
  for (const [ns, list] of [[ENV, reqs], [EVAL, reqs.slice(0, 12)]] as const)
    for (const q of list) out.push({ ns: ns.name.split(':')[0]!, req: `${q.method} ${q.path}${q.query ? ' ' + JSON.stringify(q.query) : ''}`, res: await handleMockRequest(model, store, ns, q) });
  return out;
}

const digest = (rows: Awaited<ReturnType<typeof replay>>) => rows.map((r) => ({ ns: r.ns, req: r.req, status: r.res.status, sha: createHash('sha256').update(JSON.stringify([r.res.headers, r.res.body])).digest('hex').slice(0, 16) }));

/**
 * P0b golden parity (spec §7.5): a recorded mock session over every operation of three specs
 * (list, paging, filters, other scopes, read/404, create, update/replace, delete, actions, 404/405)
 * gives byte-identical responses in the recorded golden, on the memory store and on the DB store (SQLite + PGlite).
 */
describe('mock store parity (v0.1.1 golden ↔ memory ↔ DB)', () => {
  const models: Record<string, OpenApiMockModel> = {};
  const dbs: Array<{ name: string; db: Kysely<MainDB>; close: () => Promise<void> }> = [];
  beforeAll(async () => {
    for (const [k, f] of Object.entries(SPECS)) models[k] = (await compile({ spec: { bytes: readFileSync(resolve(REPO, f)) }, namespace: 'api' })).mockModel as OpenApiMockModel;
    const sqlite = await createTestDatabases();
    dbs.push({ name: 'sqlite', db: sqlite.main.db, close: () => sqlite.close() });
    const pg = await pgliteKysely<MainDB>();
    await m0009_mock_state.up(pg.db, { dialect: 'postgres', embeddingDims: 384 });
    dbs.push({ name: 'pglite', ...pg });
  }, 60_000);
  afterAll(async () => {
    for (const d of dbs) await d.close();
  });

  for (const spec of Object.keys(SPECS)) {
    it(`${spec}: memory store matches the golden`, async () => {
      const got = digest(await replay(models[spec]!, new MemoryMockStateStore({ now: FIXED })));
      // RECORD_GOLDEN=1 re-records after an intended change of the mock data (0.2.1: schema-valid values, scope-independent seeds)
      if (process.env.RECORD_GOLDEN) writeFileSync(GOLDEN_FILE, JSON.stringify({ ...JSON.parse(readFileSync(GOLDEN_FILE, 'utf8')), [spec]: got }, null, 1) + '\n');
      else expect(got).toEqual(GOLDEN[spec]);
    });

    it(`${spec}: DB store (SQLite and PGlite) answers exactly like the memory store`, async () => {
      const mem = await replay(models[spec]!, new MemoryMockStateStore({ now: FIXED }));
      for (const d of dbs) {
        const got = await replay(models[spec]!, new DbMockStateStore(d.db, FIXED));
        expect(got, d.name).toEqual(mem);
        if (!process.env.RECORD_GOLDEN) expect(digest(got), d.name).toEqual(GOLDEN[spec]);
      }
    }, 60_000);
  }
});
