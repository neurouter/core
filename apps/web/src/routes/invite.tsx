import { useEffect, useState, type ReactNode } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MailWarningIcon } from 'lucide-react';
import { SPA_PATHS, api } from '@/contract';
import { BrandMark } from '@/components/layout/brand-mark';
import { signOut } from '@/components/layout/user-menu';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { meQueryOptions } from '@/features/auth/queries';
import { clearInviteToken, readInviteToken } from '@/features/members/invite-token';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDate } from '@/lib/format';
import { browserNavigation } from '@/lib/navigation';
import { ROLE_LABEL } from '@/lib/permissions';
import { setTenantSlug } from '@/lib/tenant';

export const Route = createFileRoute('/invite')({ component: InvitePage });

const LOGIN_HERE = `/auth/login?returnTo=${encodeURIComponent(SPA_PATHS.invite)}`;

/**
 * Invite link target (`PUBLIC_URL/invite#t=<token>`, multi-tenancy spec §2.4). Signed out: keep
 * the token for this tab and go through the login page with `returnTo=/invite`. Signed in: show
 * what the invite grants and accept it; the new organization becomes this tab's organization.
 */
function InvitePage() {
  const [token] = useState(() => readInviteToken());
  const navigate = useNavigate();
  const qc = useQueryClient();
  const me = useQuery({ ...meQueryOptions(), retry: false, refetchOnWindowFocus: false });
  const signedOut = me.error instanceof ApiError && me.error.status === 401;

  useEffect(() => {
    // the token is in sessionStorage now: drop it from the address bar and history
    if (window.location.hash) window.history.replaceState(window.history.state, '', window.location.pathname);
  }, []);
  useEffect(() => {
    if (signedOut && token) void navigate({ to: '/auth/login', search: { returnTo: SPA_PATHS.invite }, replace: true });
  }, [signedOut, token, navigate]);

  const preview = useQuery({
    queryKey: ['invites', 'preview', token, me.data?.user.id],
    queryFn: ({ signal }) => apiFetch(api.invites.preview, { body: { token: token! }, signal }),
    enabled: !!token && !!me.data,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

  async function openOrg(slug: string) {
    clearInviteToken();
    setTenantSlug(slug);
    qc.clear();
    await navigate({ to: '/' });
  }

  const accept = useMutation({
    mutationFn: () => apiFetch(api.invites.accept, { body: { token: token! } }),
    meta: { handlesForbidden: true },
    onSuccess: ({ tenant }) => openOrg(tenant.slug),
  });

  const switchAccount = () => void signOut(qc, () => browserNavigation.assign(LOGIN_HERE));

  if (!token) {
    return (
      <Shell title="This invite link is incomplete">
        <p>The link has no invite token. Open the full link you were sent, or ask for a new one.</p>
        <Link to="/" className="font-medium text-primary hover:underline">
          Go to the console
        </Link>
      </Shell>
    );
  }
  if (me.isPending || signedOut || (me.data && preview.isPending)) {
    return (
      <Shell title="Opening your invite…">
        <p className="flex items-center gap-2 text-muted-foreground">
          <Spinner /> {signedOut ? 'Taking you to sign in.' : 'Checking the invite.'}
        </p>
      </Shell>
    );
  }
  if (me.isError) return <Shell title="Something went wrong">{errorText(me.error)}</Shell>;
  if (preview.isError) {
    const gone = preview.error instanceof ApiError && preview.error.status === 404;
    return (
      <Shell title={gone ? 'This invite is no longer valid' : 'Could not open the invite'}>
        <p>{gone ? 'It may have expired, been revoked, or already been used. Ask the person who invited you for a new link.' : errorText(preview.error)}</p>
        <Link to="/" onClick={clearInviteToken} className="font-medium text-primary hover:underline">
          Go to the console
        </Link>
      </Shell>
    );
  }

  const p = preview.data!;
  const user = me.data!.user;
  const mismatch = !p.emailMatches || (accept.error instanceof ApiError && accept.error.reason === 'invite_email_mismatch');
  return (
    <Shell title={`Join ${p.tenant.name}`} description={`You're invited as ${ROLE_LABEL[p.role].toLowerCase()}.`}>
      <dl className="grid grid-cols-[7rem_1fr] gap-y-1.5">
        <dt className="text-muted-foreground">Organization</dt>
        <dd className="font-medium">{p.tenant.name}</dd>
        <dt className="text-muted-foreground">Role</dt>
        <dd>{ROLE_LABEL[p.role]}</dd>
        <dt className="text-muted-foreground">Invited email</dt>
        <dd className="break-all">{p.email}</dd>
        <dt className="text-muted-foreground">Signed in as</dt>
        <dd className="break-all">{user.email}</dd>
        <dt className="text-muted-foreground">Expires</dt>
        <dd>{formatDate(p.expiresAt)}</dd>
      </dl>
      {p.alreadyMember ? (
        <>
          <Alert>
            <AlertDescription>You're already a member of {p.tenant.name}.</AlertDescription>
          </Alert>
          <Button onClick={() => void openOrg(p.tenant.slug)}>Open {p.tenant.name}</Button>
        </>
      ) : mismatch ? (
        <>
          <Alert variant="destructive">
            <MailWarningIcon />
            <AlertTitle>This invite is for another email address</AlertTitle>
            <AlertDescription>
              It was sent to <strong>{p.email}</strong>, but you're signed in as {user.email}. Sign in with the {p.email} account to accept it.
            </AlertDescription>
          </Alert>
          <Button onClick={switchAccount}>Sign in with another account</Button>
        </>
      ) : (
        <>
          {accept.isError ? (
            <p role="alert" className="text-destructive">
              {errorText(accept.error)}
            </p>
          ) : null}
          <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
            {accept.isPending ? <Spinner /> : null} Accept invite
          </Button>
        </>
      )}
    </Shell>
  );
}

function errorText(err: unknown): string {
  return err instanceof ApiError ? (err.detail ?? err.title) : 'Something went wrong.';
}

function Shell({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center bg-muted/40 p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="gap-3">
          <BrandMark />
          <CardTitle className="text-xl">
            <h1>{title}</h1>
          </CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-4 text-[13.5px]">{children}</CardContent>
      </Card>
    </main>
  );
}
