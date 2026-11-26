import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/load.js';
import { denyCidrs, METADATA_DENY_CIDRS, outboundPolicy, proxyOptions, upstreamPolicy } from './policy.js';
import { createSafeFetch, noProxyMatch, proxyFor } from './safe-fetch.js';
import { blockedReason, SsrfError } from './ssrf-guard.js';

const cfg = (env: Record<string, string> = {}) => loadConfig({ NODE_ENV: 'test', ...env });

describe('cloud-metadata deny floor (UPSTREAM_DENY_CIDRS adds, never replaces)', () => {
  it('keeps the metadata ranges when UPSTREAM_DENY_CIDRS is overridden', () => {
    const c = cfg({ UPSTREAM_DENY_CIDRS: '10.9.0.0/16' });
    expect(denyCidrs(c)).toEqual(expect.arrayContaining([...METADATA_DENY_CIDRS, '10.9.0.0/16']));
    const p = upstreamPolicy(c);
    expect(p.allowPrivate).toBe(true);
    for (const ip of ['169.254.169.254', 'fd00:ec2::254', '169.254.170.2', '100.100.100.200', '10.9.1.1']) expect(blockedReason(ip, p), ip).toMatch(/denied range/);
    expect(blockedReason('10.1.1.1', p)).toBeNull();
    expect(blockedReason('169.254.169.254', outboundPolicy(cfg({ UPSTREAM_DENY_CIDRS: '' })))).toMatch(/denied range/);
  });

  it('UPSTREAM_ALLOW_METADATA=true is the explicit opt-out', () => {
    const c = cfg({ UPSTREAM_DENY_CIDRS: '10.9.0.0/16', UPSTREAM_ALLOW_METADATA: 'true' });
    expect(denyCidrs(c)).toEqual(['10.9.0.0/16']);
    expect(blockedReason('169.254.169.254', upstreamPolicy(c))).toBeNull();
  });
});

describe('egress proxy (HTTPS_PROXY / HTTP_PROXY / NO_PROXY)', () => {
  it('parses the env into proxy options; NO_PROXY matching follows curl', () => {
    expect(proxyOptions(cfg())).toEqual({});
    const o = proxyOptions(cfg({ HTTPS_PROXY: 'http://proxy.corp:3128', NO_PROXY: 'localhost,.internal.test,10.0.0.0/8,api.example.test:8443' }));
    expect(o.proxy).toEqual({ https: 'http://proxy.corp:3128', noProxy: ['localhost', '.internal.test', '10.0.0.0/8', 'api.example.test:8443'] });
    const np = o.proxy!.noProxy;
    expect(noProxyMatch(new URL('http://localhost:3000/'), np)).toBe(true);
    expect(noProxyMatch(new URL('https://svc.internal.test/'), np)).toBe(true);
    expect(noProxyMatch(new URL('https://internal.test/'), np)).toBe(true);
    expect(noProxyMatch(new URL('https://10.2.3.4/'), np)).toBe(true);
    expect(noProxyMatch(new URL('https://api.example.test:8443/'), np)).toBe(true);
    expect(noProxyMatch(new URL('https://api.example.test/'), np)).toBe(false);
    expect(noProxyMatch(new URL('https://other.test/'), ['*'])).toBe(true);
    expect(proxyFor(new URL('https://api.example.test/'), o.proxy)).toBe('http://proxy.corp:3128');
    expect(proxyFor(new URL('http://api.example.test/'), o.proxy)).toBeNull(); // no HTTP_PROXY
    expect(proxyFor(new URL('http://x.test/'), { http: 'http://p:1', noProxy: [] })).toBe('http://p:1');
  });

  let proxy: Server;
  let direct: Server;
  let proxyUrl = '';
  let directPort = 0;
  const proxied: string[] = [];
  beforeAll(async () => {
    proxy = createServer((req, res) => {
      proxied.push(`${req.method} ${req.url}`);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"via":"proxy"}');
    });
    direct = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"via":"direct"}');
    });
    await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
    await new Promise<void>((r) => direct.listen(0, '127.0.0.1', r));
    proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
    directPort = (direct.address() as { port: number }).port;
  });
  afterAll(() => {
    proxy?.close();
    direct?.close();
  });

  const dns: Record<string, string> = { 'api.example.test': '93.184.216.34', 'meta.example.test': '169.254.169.254', 'near.internal.test': '127.0.0.1' };
  const resolver = async (h: string) => (dns[h] ? [{ address: dns[h]!, family: 4 }] : Promise.reject(Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' })));

  it('guarded fetches go through the proxy, after the target name passes the SSRF check; NO_PROXY hosts connect directly', async () => {
    const f = createSafeFetch({ policy: { allowPrivate: true, denyCidrs: METADATA_DENY_CIDRS, allowHttp: 'always' }, resolver, proxy: { http: proxyUrl, noProxy: ['.internal.test'] } });
    try {
      const r = await f('http://api.example.test/v1/orders');
      expect(await r.json()).toEqual({ via: 'proxy' });
      expect(proxied).toEqual(['GET http://api.example.test/v1/orders']);
      await expect(f('http://meta.example.test/latest/meta-data/')).rejects.toBeInstanceOf(SsrfError);
      await expect(f('http://unknown.example.test/')).rejects.toThrow(/Cannot resolve/);
      expect(proxied).toHaveLength(1);
      const d = await f(`http://near.internal.test:${directPort}/`);
      expect(await d.json()).toEqual({ via: 'direct' });
    } finally {
      await f.close();
    }
  });
});
