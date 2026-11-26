import { GRAPHQL_ACCEPT, GRAPHQL_INTROSPECTION_QUERY, readIntrospectionResponse } from '@neurouter/compiler';
import type { FetchLike } from '../../kernel/lib/net/safe-fetch.js';
import { AppError } from '../../kernel/lib/errors.js';

export const SPEC_MAX_BYTES = 16 * 1024 * 1024;
export const SPEC_TIMEOUT_MS = 30_000;

export type SpecFetcher = (url: string) => Promise<{ bytes: Uint8Array; contentType: string | null }>;

/**
 * Spec URL fetch (§6.2): `safe-fetch` under the outbound network policy, 16 MiB cap, 30 s timeout.
 * Failures map to 502 `spec_fetch_failed` with `reason` (unreachable | too_large | not_a_spec | blocked_host).
 */
export function createSpecFetcher(fetchFn: FetchLike): SpecFetcher {
  return async (url: string) => {
    let res: Response;
    try {
      res = await fetchFn(url, { headers: { accept: 'application/json, application/yaml, text/yaml, application/graphql, text/plain, */*' }, signal: AbortSignal.timeout(SPEC_TIMEOUT_MS) });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const reason = /blocked|forbidden|not allowed/i.test(msg) ? 'blocked_host' : /too large|exceed/i.test(msg) ? 'too_large' : 'unreachable';
      throw new AppError('spec_fetch_failed', `Could not fetch the spec: ${msg.slice(0, 200)}`, { extensions: { reason } });
    }
    if (!res.ok) throw new AppError('spec_fetch_failed', `The spec URL answered ${res.status}`, { extensions: { reason: 'unreachable' } });
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > SPEC_MAX_BYTES) throw new AppError('spec_fetch_failed', 'The spec is larger than 16 MiB', { extensions: { reason: 'too_large' } });
    const head = new TextDecoder().decode(buf.subarray(0, 2048)).trimStart();
    if (/^<!doctype html|^<html/i.test(head)) throw new AppError('spec_fetch_failed', 'The URL returned HTML, not a spec', { extensions: { reason: 'not_a_spec' } });
    return { bytes: buf, contentType: res.headers.get('content-type') };
  };
}

export type GraphqlIntrospector = (url: string, headers?: Record<string, string>) => Promise<{ bytes: Uint8Array; contentType: string }>;

/**
 * GraphQL endpoint introspection (console import, re-import): one POST of the introspection query
 * through the same SSRF-guarded fetch, size cap and timeout as spec URLs. Request headers (e.g.
 * Authorization) are used for this request only and never stored. Failures map to 502
 * `spec_fetch_failed` with `reason` (unreachable | blocked_host | too_large | unauthorized |
 * introspection_disabled | not_graphql).
 */
export function createGraphqlIntrospector(fetchFn: FetchLike): GraphqlIntrospector {
  return async (url, headers = {}) => {
    let res: Response;
    try {
      res = await fetchFn(url, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json', accept: GRAPHQL_ACCEPT },
        body: JSON.stringify({ query: GRAPHQL_INTROSPECTION_QUERY, operationName: 'IntrospectionQuery' }),
        signal: AbortSignal.timeout(SPEC_TIMEOUT_MS),
      });
    } catch (err) {
      const msg = (err as Error).message ?? String(err);
      const reason = /blocked|forbidden|not allowed/i.test(msg) ? 'blocked_host' : /too large|exceed/i.test(msg) ? 'too_large' : 'unreachable';
      throw new AppError('spec_fetch_failed', `Could not reach the GraphQL endpoint: ${msg.slice(0, 200)}`, { extensions: { reason } });
    }
    let text: string;
    try {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.byteLength > SPEC_MAX_BYTES) throw new Error('too large');
      text = new TextDecoder().decode(buf);
    } catch (err) {
      const big = /too large|exceed/i.test((err as Error).message);
      throw new AppError('spec_fetch_failed', big ? 'The introspection result is larger than 16 MiB' : `Could not read the GraphQL response: ${(err as Error).message.slice(0, 200)}`, { extensions: { reason: big ? 'too_large' : 'unreachable' } });
    }
    if (res.status === 401 || res.status === 403) throw new AppError('spec_fetch_failed', `The GraphQL endpoint answered ${res.status}; add an Authorization header`, { extensions: { reason: 'unauthorized' } });
    const out = readIntrospectionResponse(text);
    if (!out.ok) {
      if (!res.ok) throw new AppError('spec_fetch_failed', `The GraphQL endpoint answered ${res.status}${out.reason === 'introspection_disabled' ? `: ${out.message.replace(/^The endpoint refused the introspection query: /, '')}` : ''}`, { extensions: { reason: 'upstream_status' } });
      throw new AppError('spec_fetch_failed', out.message, { extensions: { reason: out.reason } });
    }
    return { bytes: new TextEncoder().encode(out.json), contentType: 'application/json' };
  };
}
