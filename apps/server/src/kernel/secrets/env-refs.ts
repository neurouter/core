import { PROVIDER_ENV_KEYS } from '@neurouter/shared';
import { Env } from '../config/env.js';
import type { TenantRef } from '../tenancy/types.js';

/** What a tenant may do with `env:NAME` references (the `SecretRefPolicy` extension, spec §1.4). */
export interface EnvRefTenantPolicy {
  allowEnvRefs(t: TenantRef): boolean;
  allowEnvName?(name: string, t: TenantRef): boolean;
}

export type EnvRefDenial = 'env_refs_disabled' | 'internal_variable' | 'not_allowlisted';

/**
 * Variables an `env:` reference can never read (spec §4.9 G12): every variable the gateway itself
 * is configured with (the env schema: `DATABASE_URL`, `NEUROUTER_MASTER_KEYS`, `HASH_PEPPER`,
 * `OIDC_CLIENT_SECRET`, …), the server-level LLM keys, anything `NEUROUTER_*`, and the usual
 * credentials of the process itself (libpq, cloud SDKs).
 */
const ENV_SCHEMA_NAMES: readonly string[] = Object.keys((Env as unknown as { shape: Record<string, unknown> }).shape ?? {});
export const INTERNAL_ENV_NAMES: ReadonlySet<string> = new Set([
  ...ENV_SCHEMA_NAMES,
  ...Object.values(PROVIDER_ENV_KEYS),
  'DATABASE_URL',
  'AUDIT_DATABASE_URL',
  'HASH_PEPPER',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGUSER',
  'PGHOST',
  'PGDATABASE',
  'PGSERVICEFILE',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'NODE_OPTIONS',
]);
export const INTERNAL_ENV_PREFIXES: readonly string[] = ['NEUROUTER_', 'OIDC_', 'OTEL_EXPORTER_OTLP_HEADERS'];

export function isInternalEnvName(name: string): boolean {
  const n = name.toUpperCase();
  return INTERNAL_ENV_NAMES.has(n) || INTERNAL_ENV_PREFIXES.some((p) => n.startsWith(p));
}

/** `NEUROUTER_SECRET_ENV_ALLOW` entries: exact names or `PREFIX*`. Empty = no operator allow-list. */
export function matchesAllowList(name: string, allow: readonly string[]): boolean {
  if (allow.length === 0) return true;
  return allow.some((a) => (a.endsWith('*') ? name.startsWith(a.slice(0, -1)) : name === a));
}

/**
 * The single gate for reading `env:NAME` references on behalf of a tenant (upstream credentials,
 * GraphQL introspection header refs, audit webhook secrets) and for revealing whether one is set
 * (environment health and views). Order: tenant policy (`allowEnvRefs`), the internal-variable floor,
 * the operator allow-list, then the tenant's name policy. Denied references read as "not set".
 */
export class EnvRefGate {
  constructor(
    private readonly o: {
      policy: EnvRefTenantPolicy;
      allow: readonly string[];
      tenant: (tenantId: string) => Promise<TenantRef | null>;
      env?: NodeJS.ProcessEnv;
    },
  ) {}

  /** Null when allowed. */
  async denial(tenant: string | TenantRef, name: string): Promise<EnvRefDenial | null> {
    const t = typeof tenant === 'string' ? await this.o.tenant(tenant) : tenant;
    if (!t || !this.o.policy.allowEnvRefs(t)) return 'env_refs_disabled';
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || isInternalEnvName(name)) return 'internal_variable';
    if (!matchesAllowList(name, this.o.allow)) return 'not_allowlisted';
    if (this.o.policy.allowEnvName && !this.o.policy.allowEnvName(name, t)) return 'not_allowlisted';
    return null;
  }

  /** The variable's value, or null when unset or not allowed for this tenant. */
  async read(tenant: string | TenantRef, name: string): Promise<string | null> {
    if (await this.denial(tenant, name)) return null;
    const v = (this.o.env ?? process.env)[name];
    return v === undefined || v === '' ? null : v;
  }
}

/** Human text for a write-time 422 `unsupported_ref`. */
export function envRefDenialMessage(name: string, d: EnvRefDenial): string {
  switch (d) {
    case 'env_refs_disabled':
      return 'env:NAME references are disabled on this deployment; store the value as a secret instead';
    case 'internal_variable':
      return `env:${name} names a variable of the gateway itself and can't be used as a credential`;
    case 'not_allowlisted':
      return `env:${name} is not in this deployment's allow-list (NEUROUTER_SECRET_ENV_ALLOW)`;
  }
}
