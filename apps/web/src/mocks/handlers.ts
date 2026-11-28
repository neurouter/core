import { http, HttpResponse, type HttpHandler } from 'msw';
import type * as z from 'zod';
import { ALL_ENDPOINTS, type EndpointDef, type Me } from '@/contract';
import { DEMO_READ_ONLY_ALLOW_UI } from '@/lib/demo-allow';
import { createDb, type MockDb } from './db';
import { contractFixtures, meFixture, problem, tenancyGuard, type ContractFixtures, type Resolver } from './fixtures';
import { loadTenancy, saveTenancy } from './tenancy';

export type { ContractFixtures };

const METHOD = { GET: http.get, POST: http.post, PUT: http.put, PATCH: http.patch, DELETE: http.delete } as const;

/**
 * Non-GET endpoints that only read, preview or simulate, so the read-only demo still answers them
 * (frontend spec §12, backend §23 demo notes). Nothing they do outlives a reload.
 */
export const DEMO_READ_ONLY_ALLOW = DEMO_READ_ONLY_ALLOW_UI;

const DEMO_MESSAGE = "This is a read-only demo, so changes aren't saved. Run Neurouter yourself to try it.";

/** Extra checks on allow-listed demo mutations: only the quick eval and the sample import pass. */
async function demoRefuses(key: string, request: Request): Promise<boolean> {
  if (key !== 'evals.createRun' && key !== 'servers.create') return false;
  const b = (await request.clone().json().catch(() => ({}))) as { preset?: string; previewId?: string };
  return key === 'evals.createRun' ? b.preset !== 'quick' : !b.previewId;
}

/**
 * MSW handlers generated from the contract: one per endpoint in `ALL_ENDPOINTS`. Fixtures are
 * validated against the endpoint's response schema (so mocks can't drift); endpoints without a
 * fixture answer 501 problem+json.
 */
export function createContractHandlers(fixtures: ContractFixtures = {}, opts: { readOnly?: boolean; guard?: (def: EndpointDef, request: Request) => Response | null } = {}): HttpHandler[] {
  // static paths first (`/api/tools/search` before `/api/tools/:id`): MSW matches in order
  const params = (path: string) => (path.match(/:/g) ?? []).length;
  const endpoints = [...ALL_ENDPOINTS].sort((a, b) => params(a.def.path) - params(b.def.path));
  return endpoints.filter(({ def }) => def.kind !== 'navigation' && def.kind !== 'sse' && def.kind !== 'binary').map(({ key, def }: { key: string; def: EndpointDef }) =>
    METHOD[def.method](def.path, async ({ request, params }) => {
      if (opts.readOnly && def.method !== 'GET' && (!DEMO_READ_ONLY_ALLOW.has(key) || (await demoRefuses(key, request)))) {
        return problem(403, 'forbidden', 'Read-only demo', DEMO_MESSAGE, { reason: 'demo_read_only' });
      }
      const refused = opts.guard?.(def, request);
      if (refused) return refused;
      if (!(key in fixtures)) return problem(501, 'not_implemented', 'Not mocked', `No MSW fixture for ${key} (${def.method} ${def.path})`);
      const f = fixtures[key];
      const value = typeof f === 'function' ? await (f as Resolver)({ request, params }) : f;
      if (value instanceof Response) return value;
      if (def.kind === 'empty') return new HttpResponse(null, { status: 204 });
      if (def.kind === 'download') return new HttpResponse(String(value ?? ''), { status: 200 });
      if (!def.response) return HttpResponse.json(value ?? null, { status: def.status });
      const parsed = (def.response as z.ZodType).safeParse(value);
      if (!parsed.success) return problem(500, 'internal', 'Invalid fixture', `Fixture for ${key} does not match the contract: ${parsed.error.message}`);
      return HttpResponse.json(parsed.data as never, { status: def.status });
    }),
  );
}

let shared: MockDb | null = null;
/** One db per page (dev mocks, demo); tests create their own with `createDb({ speed: 0 })`. */
export function mockDb(): MockDb {
  shared ??= createDb();
  return shared;
}

/** Defaults: signed-in admin over the demo dataset. */
export function defaultFixtures(db: MockDb = mockDb(), me?: Me): ContractFixtures {
  return contractFixtures(db, me ? { me } : {});
}

export const handlers = (db: MockDb = mockDb()) => createContractHandlers(defaultFixtures(db));

/**
 * The read-write browser mocks (dev, the e2e `build:mock` bundle): the tenancy state (session,
 * organizations, members, invites) persists in localStorage across reloads, and the server's
 * session/tenant checks run before every handler (401 signed out, 403 `no_tenant`).
 */
export function browserHandlers(db: MockDb = mockDb()): HttpHandler[] {
  db.tenancy = loadTenancy();
  db.persistTenancy = () => saveTenancy(db.tenancy);
  db.persistTenancy();
  return createContractHandlers(defaultFixtures(db), { guard: tenancyGuard(db) });
}

/** The public demo site: same fixtures, every write refused with `demo_read_only` unless allow-listed. */
export const demoHandlers = (db: MockDb = mockDb()): HttpHandler[] => createContractHandlers(contractFixtures(db, { demo: true, me: meFixture('owner', { demoReadOnly: true }) }), { readOnly: true });
