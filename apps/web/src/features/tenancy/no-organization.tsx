import { useQueryClient } from '@tanstack/react-query';
import { Building2Icon, LogOutIcon } from 'lucide-react';
import type { Me } from '@/contract';
import { EmptyState } from '@/components/feedback/states';
import { BrandMark } from '@/components/layout/brand-mark';
import { signOut } from '@/components/layout/user-menu';
import { Button } from '@/components/ui/button';

export const NO_ORG_TITLE = 'You are not a member of any organization';
export const NO_ORG_TEXT = 'You are not a member of any organization on this server. Ask an owner or admin for an invite link, or sign in with another account.';

/** In-place empty state for a 403 `no_tenant` (multi-tenancy spec §3.3). */
export function NoOrganizationState() {
  return (
    <div role="alert" className="mx-auto w-full max-w-xl py-10">
      <EmptyState icon={Building2Icon} title={NO_ORG_TITLE} description={NO_ORG_TEXT} />
    </div>
  );
}

/**
 * Signed in, but no membership (`me.tenant === null`): instead of a shell full of 403s, one page
 * that says so and offers to sign in with another account.
 */
export function NoOrganizationPage({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-4">
      <BrandMark />
      <div className="w-full max-w-xl">
        <EmptyState
          icon={Building2Icon}
          title={NO_ORG_TITLE}
          description={
            <>
              {NO_ORG_TEXT} You're signed in as <strong>{me.user.email}</strong>.
            </>
          }
          action={
            <Button variant="outline" onClick={() => void signOut(queryClient)}>
              <LogOutIcon /> Sign out
            </Button>
          }
        />
      </div>
    </main>
  );
}
