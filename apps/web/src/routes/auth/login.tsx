import { useEffect, useState, type FormEvent } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { LogInIcon, TerminalIcon } from 'lucide-react';
import { api } from '@/contract';
import { BrandMark } from '@/components/layout/brand-mark';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import { authConfigQueryOptions } from '@/features/auth/queries';
import { ApiError, apiFetch } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';
import { isSafeReturnTo } from '@/lib/permissions';

const LoginErrorCode = z.enum(['access_denied', 'no_account', 'disabled', 'idp_error', 'session_expired', 'link_expired']);

const searchSchema = z.object({
  returnTo: z.string().optional().catch(undefined),
  error: LoginErrorCode.optional().catch(undefined),
  /** One-time console link token (`neurouter console-link` prints `/auth/login?token=…`). */
  token: z.string().optional().catch(undefined),
});

export const LOGIN_ERRORS: Record<z.infer<typeof LoginErrorCode>, string> = {
  access_denied: 'Your identity provider denied access.',
  no_account: 'There is no Neurouter account for you yet. Ask an admin to add you.',
  disabled: 'Your account is disabled.',
  idp_error: 'Sign-in failed at the identity provider. Try again.',
  session_expired: 'Your session expired. Sign in again to continue.',
  link_expired: 'This sign-in link has expired or was already used. Run neurouter console-link for a new one.',
};

export const Route = createFileRoute('/auth/login')({
  validateSearch: searchSchema,
  component: LoginPage,
});

/** Converts an absolute same-origin href into a path; anything unsafe falls back to "/". */
export function safeReturnPath(returnTo: string | undefined, origin = window.location.origin): string {
  if (!returnTo) return '/';
  let path = returnTo;
  if (returnTo.startsWith(origin)) path = returnTo.slice(origin.length) || '/';
  return isSafeReturnTo(path) && !path.startsWith('/auth/') ? path : '/';
}

/** Sign-in (A-AUTH): the one-time local admin link printed by the CLI, or a single OIDC provider. */
function LoginPage() {
  const { returnTo, error, token } = Route.useSearch();
  const target = safeReturnPath(returnTo);
  const { data } = useQuery(authConfigQueryOptions());
  const [link, setLink] = useState(token ?? '');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function exchange(value: string) {
    setLinkError(null);
    setBusy(true);
    try {
      const t = value.includes('token=') ? (new URL(value, window.location.origin).searchParams.get('token') ?? value) : value.trim();
      await apiFetch(api.auth.link, { body: { token: t } });
      browserNavigation.assign(target);
    } catch (err) {
      setLinkError(err instanceof ApiError ? (err.detail ?? err.title) : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    // a link opened straight from the terminal: exchange it once
    if (!token) return;
    apiFetch(api.auth.link, { body: { token } })
      .then(() => browserNavigation.assign(target))
      .catch((err: unknown) => setLinkError(err instanceof ApiError ? (err.detail ?? err.title) : 'Sign-in failed'));
  }, [token, target]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void exchange(link);
  };

  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="gap-3">
          <BrandMark />
          <CardTitle className="text-xl">Sign in to Neurouter</CardTitle>
          <CardDescription>{data?.orgName ? `${data.orgName} console` : 'Console'}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error ? (
            <Alert variant="destructive">
              <AlertDescription>{LOGIN_ERRORS[error]}</AlertDescription>
            </Alert>
          ) : null}
          {data?.oidc.enabled ? (
            <Button className="w-full" onClick={() => browserNavigation.assign(`/api/auth/oidc/start?returnTo=${encodeURIComponent(target)}`)}>
              <LogInIcon /> Sign in with {data.oidc.displayName ?? 'SSO'}
            </Button>
          ) : null}
          {data?.localLink !== false ? (
            <>
              {data?.oidc.enabled ? <Separator /> : null}
              <form className="flex flex-col gap-2" onSubmit={submit}>
                <Label htmlFor="console-link">Console link</Label>
                <p className="text-[13px] text-muted-foreground">
                  Run <code className="rounded bg-muted px-1 font-mono text-[12.5px]">neurouter console-link</code> on the server and paste the link or its token.
                </p>
                <Input id="console-link" required autoComplete="off" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://…/auth/login?token=…" aria-invalid={linkError ? true : undefined} aria-describedby={linkError ? 'link-error' : undefined} />
                {linkError ? (
                  <p id="link-error" role="alert" className="text-sm text-destructive">
                    {linkError}
                  </p>
                ) : null}
                <Button type="submit" variant="outline" disabled={busy}>
                  <TerminalIcon /> Sign in with the link
                </Button>
              </form>
            </>
          ) : null}
        </CardContent>
      </Card>
    </main>
  );
}
