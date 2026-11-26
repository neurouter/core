import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RouterProvider, createMemoryHistory } from '@tanstack/react-router';
import { HttpResponse } from 'msw';
import { PROBLEM_CONTENT_TYPE, problemType, type Me } from '@/contract';
import { Providers } from '@/app/providers';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { createDb, type MockDb } from '@/mocks/db';
import { contractFixtures } from '@/mocks/fixtures';
import { createContractHandlers, type ContractFixtures } from '@/mocks/handlers';
import { setCsrfToken } from '@/lib/api-client';
import { server } from './msw-server';

export const unauthenticated = () =>
  HttpResponse.json(
    { type: problemType('unauthenticated'), title: 'Authentication required', status: 401, code: 'unauthenticated', requestId: 't' },
    { status: 401, headers: { 'content-type': PROBLEM_CONTENT_TYPE } },
  );

/**
 * Renders the real route tree at `path` with memory history, a fresh QueryClient and
 * contract-generated MSW handlers over a fresh mock db (instant simulated delays), so guards,
 * loaders and search validation run for real.
 */
export async function renderRoute(path: string, opts: { me?: Me | null; fixtures?: ContractFixtures; db?: MockDb; readOnly?: boolean; demo?: boolean } = {}) {
  setCsrfToken(null);
  const db = opts.db ?? createDb({ speed: 0 });
  const fixtures: ContractFixtures = {
    ...contractFixtures(db, { ...(opts.me ? { me: opts.me } : {}), demo: !!opts.demo }),
    ...(opts.me === null ? { 'me.get': unauthenticated } : {}),
    ...opts.fixtures,
  };
  server.use(...createContractHandlers(fixtures, { readOnly: !!opts.readOnly }));
  const queryClient = createQueryClient();
  queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false, refetchInterval: false, refetchOnWindowFocus: false } });
  const history = createMemoryHistory({ initialEntries: [path] });
  const router = createAppRouter({ queryClient, history });
  const user = userEvent.setup();
  const utils = render(
    <Providers queryClient={queryClient}>
      <RouterProvider router={router} />
    </Providers>,
  );
  await router.load();
  return { ...utils, router, queryClient, user, db };
}
