import { useEffect, useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { api } from '@/contract';
import { BrandMark } from '@/components/layout/brand-mark';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ApiError, apiFetch } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';

export const Route = createFileRoute('/auth/link')({ component: LinkLogin });

/**
 * One-time console link target (`PUBLIC_URL/auth/link#t=<token>`, shared `SPA_PATHS.link`). The
 * token is in the fragment so it never reaches server logs; it is exchanged for a session.
 */
function LinkLogin() {
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('t'));
  const [error, setError] = useState<string | null>(token ? null : 'This link has no token. Run neurouter console-link for a new one.');
  useEffect(() => {
    if (!token) return;
    window.history.replaceState(null, '', window.location.pathname);
    apiFetch(api.auth.link, { body: { token } })
      .then(() => browserNavigation.assign('/'))
      .catch((e: unknown) => setError(e instanceof ApiError ? (e.detail ?? e.title) : 'Sign-in failed.'));
  }, [token]);
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="gap-3">
          <BrandMark />
          <CardTitle className="text-xl">{error ? 'Could not sign you in' : 'Signing you in…'}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 text-[13.5px]">
          {error ? (
            <>
              <p role="alert">{error}</p>
              <Link to="/auth/login" className="font-medium text-primary hover:underline">
                Other ways to sign in
              </Link>
            </>
          ) : (
            <p className="text-muted-foreground">Exchanging the one-time link for a session.</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
