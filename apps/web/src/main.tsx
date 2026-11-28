import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from '@tanstack/react-router';
import { Providers } from '@/app/providers';
import { createQueryClient } from '@/app/query-client';
import { createAppRouter } from '@/app/router';
import { toast } from '@/components/ui/toast';
import { getDisplayPrefs } from '@/lib/display-prefs';
import { consumeOrgParam } from '@/lib/tenant';
import './styles/globals.css';

const DEMO = import.meta.env.VITE_DEMO === 'true';
// VITE_ENABLE_MSW: read-write in-memory mocks (dev, and the `build:mock` bundle the e2e suite runs on)
const MOCKS = import.meta.env.VITE_ENABLE_MSW === 'true';

async function enableMocks(): Promise<void> {
  if (DEMO) {
    // the static demo site: read-only mocks plus simulated agent traffic
    const [{ startMockWorker }, { startDemoSimulator }, { mockDb }] = await Promise.all([import('@/mocks/browser'), import('@/demo/simulator'), import('@/mocks/handlers')]);
    await startMockWorker({ readOnly: true });
    startDemoSimulator(queryClient, mockDb());
  } else if (MOCKS) {
    const { startMockWorker } = await import('@/mocks/browser');
    await startMockWorker();
  }
}

getDisplayPrefs(); // applies the stored table density
consumeOrgParam(); // `?org=<slug>` deep link: kept for this tab, stripped from the URL (spec §3.3)

const queryClient = createQueryClient({
  onUnauthorized: () => {
    const returnTo = window.location.pathname + window.location.search;
    void router.navigate({ to: '/auth/login', search: { returnTo, error: 'session_expired' } });
  },
  onMutationForbidden: (err) =>
    err.isDemoReadOnly
      ? toast.add({ title: 'Read-only demo', description: err.detail ?? err.title, type: 'info' })
      : toast.add({ title: "You don't have permission to do that", description: err.detail ?? err.title, type: 'error' }),
});
const router = createAppRouter({ queryClient });

void enableMocks().then(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Providers queryClient={queryClient}>
        <RouterProvider router={router} />
      </Providers>
    </StrictMode>,
  );
});
