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
/**
 * Recorded on the in-memory `MockStore`. Data version 1 (`dv1` namespaces): first on v0.1.1, re-recorded in
 * 0.2.1 for schema-valid values and scope-independent seeds, and frozen since (suites frozen on 0.2.1 name
 * its values). Data version 2 (0.2.2 default): realistic values, newest-first timestamps.
 */
const GOLDEN_FILES = { 1: resolve(import.meta.dirname, 'mock-session.golden.json'), 2: resolve(import.meta.dirname, 'mock-session-v2.golden.json') } as const;
type Golden = Record<string, Array<{ ns: string; req: string; status: number; sha: string }>>;
const readGolden = (dv: 1 | 2): Golden => {
  try {
    return JSON.parse(readFileSync(GOLDEN_FILES[dv], 'utf8')) as Golden;
  } catch {
    return {};
  }
};
const FIXED = () => Date.parse('2026-02-01T00:00:00Z');
const TENANT = '0190a0b0-0000-7000-8000-0000000000a1';
const BASE: MockNs = { tenantId: TENANT, environmentId: '0190a0b0-0000-7000-8000-0000000000e1', name: 'env' };
const nss = (dv: 1 | 2): [MockNs, MockNs] => [
  { ...BASE, name: dv === 1 ? 'env:dv1' : 'env' },
  { ...BASE, name: `eval:0190a0b0-0000-7000-8000-000000000001:${dv === 1 ? 'dv1:' : ''}task-1` },
];

async function replay(model: OpenApiMockModel, store: MockStateStore, dv: 1 | 2): Promise<Array<{ ns: string; req: string; res: MockResponse }>> {
  const reqs = recordedSession(model);
  const [ENV, EVAL] = nss(dv);
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
describe('mock store parity (golden ↔ memory ↔ DB, data versions 1 and 2)', () => {
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

  for (const dv of [1, 2] as const)
    for (const spec of Object.keys(SPECS)) {
      it(`${spec} (data v${dv}): memory store matches the golden`, async () => {
        const got = digest(await replay(models[spec]!, new MemoryMockStateStore({ now: FIXED }), dv));
        // RECORD_GOLDEN=2 re-records the version-2 golden after an intended change of the mock data; version 1 is frozen
        if (process.env.RECORD_GOLDEN === String(dv)) writeFileSync(GOLDEN_FILES[dv], JSON.stringify({ ...readGolden(dv), [spec]: got }, null, 1) + '\n');
        else expect(got).toEqual(readGolden(dv)[spec]);
      });

      it(`${spec} (data v${dv}): DB store (SQLite and PGlite) answers exactly like the memory store`, async () => {
        const mem = await replay(models[spec]!, new MemoryMockStateStore({ now: FIXED }), dv);
        for (const d of dbs) {
          const got = await replay(models[spec]!, new DbMockStateStore(d.db, FIXED), dv);
          expect(got, d.name).toEqual(mem);
          if (process.env.RECORD_GOLDEN !== String(dv)) expect(digest(got), d.name).toEqual(readGolden(dv)[spec]);
        }
      }, 60_000);
    }
});
