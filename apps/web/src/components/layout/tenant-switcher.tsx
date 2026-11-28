import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { CheckIcon, ChevronsUpDownIcon } from 'lucide-react';
import { api, type Me, type TenantSummary } from '@/contract';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { apiFetch } from '@/lib/api-client';
import { notifyError } from '@/lib/notify';
import { ROLE_LABEL } from '@/lib/permissions';
import { setTenantSlug } from '@/lib/tenant';

/**
 * Organization switcher in the sidebar header slot (frontend spec §5.2, multi-tenancy spec §3.3).
 * Rendered only on a multi-tenant deployment (`me.tenancy.multi`). Switching remembers the
 * organization for the session, pins it to this tab (`X-Neurouter-Tenant`), drops every cached
 * query (they belong to the old organization) and goes home.
 */
export function TenantSwitcher({ me }: { me: Me }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  if (!me.tenancy.multi) return null;
  const current = me.tenant;

  async function pick(t: TenantSummary) {
    if (t.slug === current?.slug || busy) return;
    setBusy(true);
    try {
      await apiFetch(api.tenants.switch, { body: { slug: t.slug } });
      setTenantSlug(t.slug);
      await navigate({ to: '/' });
      await qc.resetQueries();
    } catch (err) {
      notifyError(err, `Could not switch to ${t.name}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Organization: ${current?.name ?? 'none'}`}
        disabled={busy}
        className="flex min-w-0 flex-1 items-center gap-1 rounded-md text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span className="truncate text-[12.5px] text-muted-foreground">{current?.name ?? 'No organization'}</span>
        <ChevronsUpDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Organizations</DropdownMenuLabel>
          {me.tenants.map((t) => (
            <DropdownMenuItem key={t.id} onClick={() => void pick(t)} aria-current={t.slug === current?.slug ? 'true' : undefined}>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate">{t.name}</span>
                <span className="text-xs text-muted-foreground">
                  {ROLE_LABEL[t.role]} · {t.slug}
                </span>
              </span>
              {t.slug === current?.slug ? <CheckIcon aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
