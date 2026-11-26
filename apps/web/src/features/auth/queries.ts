import { queryOptions } from '@tanstack/react-query';
import { api } from '@/contract';
import { apiFetch, setCsrfToken } from '@/lib/api-client';

export const authKeys = {
  me: ['me'] as const,
  badges: ['me', 'badges'] as const,
  config: ['auth', 'config'] as const,
};

/** `/api/me`: staleTime 5 min, refetch on focus; keeps the CSRF token current. */
export function meQueryOptions() {
  return queryOptions({
    queryKey: authKeys.me,
    queryFn: async ({ signal }) => {
      const me = await apiFetch(api.me.get, { signal });
      setCsrfToken(me.csrfToken);
      return me;
    },
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/** Sidebar counts (`inboxOpen`, `evalsRunning`), polled every 30 s. */
export function badgesQueryOptions() {
  return queryOptions({
    queryKey: authKeys.badges,
    queryFn: ({ signal }) => apiFetch(api.me.badges, { signal }),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });
}

export function authConfigQueryOptions() {
  return queryOptions({
    queryKey: authKeys.config,
    queryFn: ({ signal }) => apiFetch(api.auth.config, { signal }),
    staleTime: 5 * 60_000,
  });
}
