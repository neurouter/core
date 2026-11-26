import { redirect } from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import type { Capability } from '@neurouter/shared';
import type { Me } from '@/contract';
import { ApiError } from '@/lib/api-client';
import { canAny } from '@/lib/permissions';
import { meQueryOptions } from './queries';

export { isSafeReturnTo } from '@/lib/permissions';

/** Thrown by area guards; the area's errorComponent renders <ForbiddenState/> in place (URL unchanged). */
export class ForbiddenError extends Error {
  constructor(readonly required: readonly Capability[]) {
    super('You do not have access to this page');
    this.name = 'ForbiddenError';
  }
}

export function isForbiddenError(e: unknown): e is ForbiddenError {
  return e instanceof ForbiddenError || (e instanceof ApiError && e.status === 403);
}

/**
 * `beforeLoad` guard for the authenticated shell: loads `/api/me`, or redirects to the login
 * page with `returnTo` on 401. UX only; the server authorizes.
 */
export async function requireAuth(ctx: { context: { queryClient: QueryClient }; location: { href: string } }): Promise<Me> {
  try {
    return await ctx.context.queryClient.ensureQueryData(meQueryOptions());
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw redirect({ to: '/auth/login', search: { returnTo: ctx.location.href } });
    }
    throw err;
  }
}

/** Throws ForbiddenError unless the user holds at least one of `caps`. */
export function requireAnyCapability(me: Me, caps: readonly Capability[]): void {
  if (!canAny(me, caps)) throw new ForbiddenError(caps);
}
