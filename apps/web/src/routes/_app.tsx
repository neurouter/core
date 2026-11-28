import { Outlet, createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery } from '@tanstack/react-query';
import { AreaError } from '@/app/route-guards';
import { AppShell } from '@/components/layout/app-shell';
import { requireAuth } from '@/features/auth/guards';
import { meQueryOptions } from '@/features/auth/queries';
import { NoOrganizationPage } from '@/features/tenancy/no-organization';

/** Authenticated shell (pathless). Unauthenticated users are redirected to /auth/login?returnTo=… */
export const Route = createFileRoute('/_app')({
  beforeLoad: requireAuth,
  component: AppLayout,
  errorComponent: AreaError,
});

function AppLayout() {
  const { data: me } = useSuspenseQuery(meQueryOptions());
  // signed in without a membership (spec §3.3): one empty state instead of pages full of 403s
  if (me.tenant === null && !me.user.anonymous) return <NoOrganizationPage me={me} />;
  return (
    <AppShell me={me}>
      <Outlet />
    </AppShell>
  );
}
