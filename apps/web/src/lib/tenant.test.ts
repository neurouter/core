import { describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { api } from '@/contract';
import { server } from '@/test/msw-server';
import { apiFetch } from './api-client';
import { TENANT_STORAGE_KEY, consumeOrgParam, getTenantSlug, setTenantSlug } from './tenant';

describe('tenant per tab', () => {
  it('stores the slug in sessionStorage (per tab), not localStorage', () => {
    expect(getTenantSlug()).toBeNull();
    setTenantSlug('acme');
    expect(window.sessionStorage.getItem(TENANT_STORAGE_KEY)).toBe('acme');
    expect(window.localStorage.getItem(TENANT_STORAGE_KEY)).toBeNull();
    setTenantSlug(null);
    expect(getTenantSlug()).toBeNull();
  });

  it('?org=<slug> is stored and stripped, other params and the hash are kept', () => {
    const replaceState = vi.fn();
    const slug = consumeOrgParam({ pathname: '/tasks', search: '?org=bluefin&q=refund', hash: '#x' }, { replaceState, state: { k: 1 } });
    expect(slug).toBe('bluefin');
    expect(getTenantSlug()).toBe('bluefin');
    expect(replaceState).toHaveBeenCalledWith({ k: 1 }, '', '/tasks?q=refund#x');
  });

  it('leaves the URL alone without ?org=', () => {
    const replaceState = vi.fn();
    expect(consumeOrgParam({ pathname: '/', search: '?q=1', hash: '' }, { replaceState, state: null })).toBeNull();
    expect(replaceState).not.toHaveBeenCalled();
  });

  it('the API client sends X-Neurouter-Tenant on every call once a slug is stored', async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.get('/api/servers', ({ request }) => {
        seen.push(request.headers.get('x-neurouter-tenant'));
        return HttpResponse.json({ items: [], nextCursor: null, totalEstimate: 0 });
      }),
    );
    await apiFetch(api.servers.list);
    setTenantSlug('bluefin');
    await apiFetch(api.servers.list);
    expect(seen).toEqual([null, 'bluefin']);
  });
});
