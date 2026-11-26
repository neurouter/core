import { useSuspenseQuery } from '@tanstack/react-query';
import type { Capability } from '@neurouter/shared';
import type { Me } from '@/contract';
import { meQueryOptions } from '@/features/auth/queries';
import { can, readOnlyReason } from '@/lib/permissions';

/** The signed-in identity (inside the authenticated shell `me` is always loaded by the guard). */
export function useMe(): Me {
  return useSuspenseQuery(meQueryOptions()).data;
}

/** UI permission check (hide/disable only; the API authorizes). */
export function useCan(cap: Capability): boolean {
  return can(useMe(), cap);
}

/**
 * Mutation-control state for `cap`: `disabled` plus the tooltip reason ("Read-only demo",
 * "Viewer role: ask an admin"). Controls stay visible but disabled (frontend §9 "Read-only").
 */
export function useMutationGate(cap: Capability): { allowed: boolean; reason: string | null } {
  const me = useMe();
  const allowed = can(me, cap) && !me.instance.demoReadOnly;
  return { allowed, reason: allowed ? null : readOnlyReason(me) };
}
