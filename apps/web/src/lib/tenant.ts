import { TENANT_QUERY } from '@/contract';

/**
 * The console's organization per browser tab (multi-tenancy spec §3.3). The slug lives in
 * `sessionStorage`, so two tabs can work in two organizations; the API client sends it as
 * `X-Neurouter-Tenant` on every `/api` call. With no slug the server falls back to the
 * session's active organization.
 */
export const TENANT_STORAGE_KEY = 'neurouter-tenant';

function session(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

export function getTenantSlug(): string | null {
  try {
    return session()?.getItem(TENANT_STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

export function setTenantSlug(slug: string | null): void {
  try {
    const s = session();
    if (!s) return;
    if (slug) s.setItem(TENANT_STORAGE_KEY, slug);
    else s.removeItem(TENANT_STORAGE_KEY);
  } catch {
    // storage blocked: the server falls back to the session's active organization
  }
}

/**
 * Deep links carry `?org=<slug>`: store it for this tab and strip it from the address bar (before
 * the router reads the URL). Returns the slug it consumed, if any.
 */
export function consumeOrgParam(loc: Pick<Location, 'pathname' | 'search' | 'hash'> = window.location, history: Pick<History, 'replaceState' | 'state'> = window.history): string | null {
  const params = new URLSearchParams(loc.search);
  const slug = params.get(TENANT_QUERY)?.trim();
  if (!params.has(TENANT_QUERY)) return null;
  params.delete(TENANT_QUERY);
  const rest = params.toString();
  history.replaceState(history.state, '', `${loc.pathname}${rest ? `?${rest}` : ''}${loc.hash}`);
  if (!slug) return null;
  setTenantSlug(slug);
  return slug;
}
