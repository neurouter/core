import { describe, expect, it } from 'vitest';
import { RESERVED_TENANT_SLUGS, tenantSlugIssue } from '../api/members.js';
import { NON_SPA_PREFIXES } from '../api/routes.js';
import { Capability, capabilitiesFor, hasCapability } from './capabilities.js';
import { Role, roleAtLeast } from './roles.js';

describe('roles and capabilities (multi-tenancy spec §2.2)', () => {
  const ORG = ['members:read', 'members:invite', 'members:manage', 'billing:read', 'billing:manage', 'tenant:delete'];
  const gateway = Capability.options.filter((c) => !ORG.includes(c));

  it('viewer: the gateway :read set + members:read', () => {
    expect(capabilitiesFor('viewer').sort()).toEqual([...gateway.filter((c) => c.endsWith(':read')), 'members:read'].sort());
    expect(hasCapability('viewer', 'billing:read')).toBe(false);
  });

  it('admin: every gateway capability + members:read, members:invite, billing:read; no billing changes, members management or deletion', () => {
    expect(capabilitiesFor('admin').sort()).toEqual([...gateway, 'members:read', 'members:invite', 'billing:read'].sort());
    for (const c of ['members:manage', 'billing:manage', 'tenant:delete'] as const) expect(hasCapability('admin', c)).toBe(false);
  });

  it('owner: everything', () => {
    expect(capabilitiesFor('owner').sort()).toEqual([...Capability.options].sort());
  });

  it('ranks roles', () => {
    expect(Role.options).toEqual(['owner', 'admin', 'viewer']);
    expect(roleAtLeast('admin', 'owner')).toBe(true);
    expect(roleAtLeast('admin', 'admin')).toBe(true);
    expect(roleAtLeast('admin', 'viewer')).toBe(false);
    expect(roleAtLeast('viewer', null)).toBe(false);
  });
});

describe('tenant slug rules (spec §2.3)', () => {
  it('accepts 3–32 lowercase chars and refuses the rest', () => {
    for (const ok of ['acme', 'p11', 'my-org', 'a'.repeat(32)]) expect(tenantSlugIssue(ok), ok).toBeNull();
    for (const bad of ['ab', 'a'.repeat(33), 'Acme', '1acme', 'acme-', '-acme', 'ac_me', '123']) expect(tenantSlugIssue(bad), bad).toBe('format');
    expect(tenantSlugIssue('my--org')).toBe('double_dash');
  });

  it('reserves platform words and every backend path prefix', () => {
    for (const r of ['api', 'admin', 'default', 'mcp', 'oauth', 'well-known', 'invite']) expect(tenantSlugIssue(r), r).toBe('reserved');
    for (const p of NON_SPA_PREFIXES) {
      const word = p.replace(/^\/\.?/, '');
      if (word.length >= 3) expect(RESERVED_TENANT_SLUGS, p).toContain(word);
    }
  });
});
