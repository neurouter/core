import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../config/load.js';
import { denyHosts, upstreamPolicy } from './policy.js';
import { assertUrlAllowed, hostDenied } from './ssrf-guard.js';

describe('NEUROUTER_DENY_HOSTS (multi-tenancy spec §9.1)', () => {
  it('matches host, host:port and *.suffix', () => {
    expect(hostDenied(new URL('https://app.neurouter.com/x'), ['app.neurouter.com'])).toBe(true);
    expect(hostDenied(new URL('https://APP.neurouter.com./x'), ['app.neurouter.com'])).toBe(true);
    expect(hostDenied(new URL('https://svc-123.a.run.app/'), ['*.run.app'])).toBe(true);
    expect(hostDenied(new URL('http://localhost:3000/'), ['localhost:3000'])).toBe(true);
    expect(hostDenied(new URL('http://localhost:4010/'), ['localhost:3000'])).toBe(false);
    expect(hostDenied(new URL('https://api.github.com/'), ['app.neurouter.com', '*.run.app'])).toBe(false);
  });

  it("defaults to the gateway's own origin; `none` disables; the policy refuses denied hosts", () => {
    const cfg = loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'https://app.neurouter.com', DATABASE_URL: 'sqlite::memory:' });
    expect(denyHosts(cfg)).toEqual(['app.neurouter.com:443']);
    const p = upstreamPolicy(cfg);
    expect(() => assertUrlAllowed('https://app.neurouter.com/mcp/x/y', p)).toThrow(/denied host/);
    expect(() => assertUrlAllowed('https://api.github.com/', p)).not.toThrow();
    expect(denyHosts(loadConfig({ NODE_ENV: 'test', PUBLIC_URL: 'https://app.neurouter.com', DATABASE_URL: 'sqlite::memory:', NEUROUTER_DENY_HOSTS: 'none' }))).toEqual([]);
    expect(denyHosts(loadConfig({ NODE_ENV: 'test', DATABASE_URL: 'sqlite::memory:', NEUROUTER_DENY_HOSTS: 'a.test,*.run.app' }))).toEqual(['a.test', '*.run.app']);
  });
});
