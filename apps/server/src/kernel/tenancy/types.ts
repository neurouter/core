/**
 * Tenancy types shared by the kernel and both planes (multi-tenancy spec §1.4, §3). Re-exported from
 * `extensions.ts`, the public extension surface of `@neurouter/server`.
 */
import type { FastifyRequest } from 'fastify';

export type TenantStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';
export type TenantKind = 'personal' | 'org';

export interface TenantRef {
  id: string;
  slug: string;
  name: string;
  status: TenantStatus;
  /** `oss` in core. */
  plan: string;
  /** `personal` (created at sign-up) or `org` (spec §2.5); `org` when unknown. */
  kind?: TenantKind;
}

export type TenantRole = 'owner' | 'admin' | 'viewer';

/** Per-request tenant context: replaces the old `ApiContext.tenantId` / `Services.tenantId` constants. */
export interface TenantContext {
  tenant: TenantRef;
  /** Null on the data plane and on public routes. */
  role: TenantRole | null;
}

/**
 * Request → tenant (spec §3). Core ships `SingleTenantResolver` (always the default tenant); the
 * private cloud build provides a multi-tenant resolver. Every lookup that carries a slug MUST also be
 * checked against the credential's tenant by the caller (a mismatch looks like "unknown").
 */
export interface TenantResolver {
  /** False → core never registers the 3-segment MCP route. */
  readonly multi: boolean;
  /** MCP and PRM: `tenantSlug` is null on the legacy 2-segment route. Null result → 404 after auth. */
  forMcp(p: { tenantSlug: string | null; serverSlug: string; envSlug: string }): Promise<TenantRef | null>;
  /** Console `/api`: picks the tenant (header/query/session) and checks membership. Null → 403 `no_tenant`. */
  forConsole(req: FastifyRequest, userId: string, sessionDefault: string | null): Promise<{ tenant: TenantRef; role: TenantRole } | null>;
  /** Public pages (`/public/...`): `tenantSlug` is null on the legacy (tenant-less) paths. */
  forPublic(p: { tenantSlug: string | null }): Promise<TenantRef | null>;
  /**
   * The tenant that instance-level inputs apply to: `neurouter.yaml`, `neurouter keys create`
   * without `--tenant`, the legacy MCP route. Null when the deployment has none.
   */
  defaultTenant(): Promise<TenantRef | null>;
  /** The user's role in the tenant, or null when they are not an (active) member. */
  roleOf(tenantId: string, userId: string): Promise<TenantRole | null>;
  bySlug(slug: string): Promise<TenantRef | null>;
  byId(id: string): Promise<TenantRef | null>;
}

/**
 * `env:NAME` secret references (spec §4.9 G12, §9.1). `allowEnvRefs(t) = false` turns them off for a
 * tenant (cloud). `allowEnvName` narrows which variables a tenant may reference; it is consulted
 * after the core floor, which never lets a reference read a gateway-internal variable
 * (`kernel/secrets/env-refs.ts`).
 */
export interface SecretRefPolicy {
  allowEnvRefs(t: TenantRef): boolean;
  allowEnvName?(name: string, t: TenantRef): boolean;
}

/** Server-level LLM provider keys (`OPENAI_API_KEY`, …) for hosted evals. Cloud: false (BYOK only). */
export interface ModelKeyPolicy {
  allowEnvKeys(t: TenantRef): boolean;
}

