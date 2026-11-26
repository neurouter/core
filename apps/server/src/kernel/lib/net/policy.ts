import type { Config } from '../../config/load.js';
import type { ProxyConfig } from './safe-fetch.js';
import type { NetPolicy } from './ssrf-guard.js';

/**
 * Cloud instance-metadata endpoints (AWS/GCP/Azure/OpenStack IMDS, ECS task metadata, Alibaba, AWS
 * IPv6 IMDS). Always denied for upstream and outbound fetches, whatever UPSTREAM_DENY_CIDRS says:
 * the variable adds to this floor. `UPSTREAM_ALLOW_METADATA=true` is the only (documented) opt-out.
 */
export const METADATA_DENY_CIDRS: readonly string[] = ['169.254.169.254/32', '169.254.170.2/32', '169.254.170.23/32', '100.100.100.200/32', 'fd00:ec2::254/128'];

/** UPSTREAM_DENY_CIDRS plus the metadata floor (unless explicitly opted out). */
export function denyCidrs(config: Pick<Config, 'env'>): string[] {
  const own = config.env.UPSTREAM_DENY_CIDRS;
  if (config.env.UPSTREAM_ALLOW_METADATA) return [...own];
  return [...new Set([...METADATA_DENY_CIDRS, ...own])];
}

/**
 * Hosts upstreams may never target (spec §9.1): `NEUROUTER_DENY_HOSTS`, default the gateway's own
 * origin (`PUBLIC_URL` host:port, no loops or amplification through the gateway); `none` disables.
 */
export function denyHosts(config: Pick<Config, 'env'> & { publicUrl?: string }): string[] {
  const own = config.env.NEUROUTER_DENY_HOSTS;
  if (own && own.length) return own.some((h) => h.toLowerCase() === 'none') ? [] : [...own];
  if (!config.publicUrl) return [];
  try {
    const u = new URL(config.publicUrl);
    return [`${u.hostname}:${u.port || (u.protocol === 'https:' ? '443' : '80')}`];
  } catch {
    return [];
  }
}

/** Policy for calls to an environment's API (private networks per UPSTREAM_ALLOW_PRIVATE_NETWORKS). */
export function upstreamPolicy(config: Pick<Config, 'env'> & { publicUrl?: string }, allowHttp = false): NetPolicy {
  const allowPrivate = config.env.UPSTREAM_ALLOW_PRIVATE_NETWORKS;
  return { allowPrivate, denyCidrs: denyCidrs(config), allowHttp: allowHttp || allowPrivate ? 'always' : config.env.OUTBOUND_ALLOW_HTTP_LOOPBACK ? 'loopback' : 'never', denyHosts: denyHosts(config) };
}

/** Policy for other outbound fetches (spec URLs, OIDC, JWKS, webhooks). */
export function outboundPolicy(config: Pick<Config, 'env'>): NetPolicy {
  return { allowPrivate: config.env.OUTBOUND_ALLOW_PRIVATE_NETWORKS, denyCidrs: denyCidrs(config), allowHttp: config.env.OUTBOUND_ALLOW_HTTP_LOOPBACK ? 'loopback' : 'never' };
}

/** Egress proxy from HTTPS_PROXY / HTTP_PROXY / NO_PROXY (spread into createSafeFetch options). */
export function proxyOptions(config: Pick<Config, 'env'>): { proxy?: ProxyConfig } {
  const { HTTPS_PROXY, HTTP_PROXY, NO_PROXY } = config.env;
  if (!HTTPS_PROXY && !HTTP_PROXY) return {};
  return { proxy: { ...(HTTPS_PROXY ? { https: HTTPS_PROXY } : {}), ...(HTTP_PROXY ? { http: HTTP_PROXY } : {}), noProxy: NO_PROXY } };
}
