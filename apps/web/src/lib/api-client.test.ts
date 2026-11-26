import { describe, expect, it, vi } from 'vitest';
import { HttpResponse, http } from 'msw';
import { api } from '@/contract';
import { server } from '@/test/msw-server';
import { ApiContractError, ApiError, apiFetch, applyServerErrors, setCsrfToken } from './api-client';

describe('apiFetch', () => {
  it('parses responses with the contract schema', async () => {
    const me = await apiFetch(api.me.get);
    expect(me.instance.name).toBe('Acme Corp');
  });

  it('maps problem+json to ApiError with field errors, retry-after and extensions', async () => {
    server.use(
      http.post('/api/keys', () =>
        HttpResponse.json(
          { type: 'https://neurouter.dev/problems/validation-failed', title: 'Validation failed', status: 422, code: 'validation_failed', requestId: 'r1', detail: '1 field is invalid', errors: [{ path: ['name'], message: 'Required', code: 'too_small' }], reason: 'x' },
          { status: 422, headers: { 'content-type': 'application/problem+json', 'retry-after': '3' } },
        ),
      ),
    );
    const err = await apiFetch(api.keys.create, { body: { name: '' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 422, code: 'validation_failed', requestId: 'r1', retryAfterSec: 3, reason: 'x' });
    const setError = vi.fn();
    expect(applyServerErrors({ setError }, err)).toBe(1);
    expect(setError).toHaveBeenCalledWith('name', { type: 'server', message: 'Required' });
    expect(applyServerErrors({ setError }, new Error('x'))).toBe(0);
  });

  it('recognises the demo read-only 403 (code forbidden + reason demo_read_only)', async () => {
    server.use(http.post('/api/keys/k1/revoke', () => HttpResponse.json({ type: 't', title: 'Read-only demo', status: 403, code: 'forbidden', reason: 'demo_read_only', requestId: 'r' }, { status: 403, headers: { 'content-type': 'application/problem+json' } })));
    const err = (await apiFetch(api.keys.revoke, { params: { id: 'k1' } }).catch((e: unknown) => e)) as ApiError;
    expect(err.isDemoReadOnly).toBe(true);
  });

  it('turns non-JSON gateway errors into a synthetic ApiError', async () => {
    server.use(http.get('/api/me', () => new HttpResponse('<html>bad gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } })));
    await expect(apiFetch(api.me.get)).rejects.toMatchObject({ status: 502, code: 'bad_gateway' });
  });

  it('reports network failures', async () => {
    server.use(http.get('/api/me', () => HttpResponse.error()));
    await expect(apiFetch(api.me.get)).rejects.toMatchObject({ status: 0, code: 'network' });
  });

  it('throws ApiContractError when the response drifts from the contract', async () => {
    server.use(http.get('/api/me', () => HttpResponse.json({ user: { id: 1 } })));
    await expect(apiFetch(api.me.get)).rejects.toBeInstanceOf(ApiContractError);
  });

  it('sends the CSRF header and If-Match on mutations', async () => {
    let seen: Headers | null = null;
    server.use(
      http.delete('/api/servers/:id/overlay/draft', ({ request }) => {
        seen = request.headers;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    setCsrfToken('tok');
    await apiFetch(api.overlays.discardDraft, { params: { id: 's1' }, headers: { 'if-match': 'W/"1"' } });
    expect(seen!.get('x-csrf-token')).toBe('tok');
    expect(seen!.get('if-match')).toBe('W/"1"');
    setCsrfToken(null);
  });
});
