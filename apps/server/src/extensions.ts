/**
 * Extension points of the core server (multi-tenancy spec §1.4). The private cloud build passes an
 * implementation through `startServer({ extensions })`; core compiles and passes every test without
 * any (each extension has a test double in `test/fakes/extensions.ts`).
 *
 * Wired in P0: `tenancy`, `secretRefs`, `modelKeys`, `executor`, `routes`, `migrations`, `jobs`,
 * `features`, and `usage` (fed one `tool_calls` event per committed tool-call audit row).
 * Declared with core defaults and wired later: `quotas` (enforcement points, P3), `netPolicy`
 * (per-tenant upstream policy; needs tenant-aware upstream fetchers, P2/P3), `identityProviders` (P2).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Migration } from 'kysely/migration';
import type { Executor } from '@neurouter/executor';
import type { Services } from './deps.js';
import type { JobScheduler } from './kernel/jobs/scheduler.js';
import type { NetPolicy } from './kernel/lib/net/ssrf-guard.js';
import type { ModelKeyPolicy, SecretRefPolicy, TenantRef, TenantResolver } from './kernel/tenancy/types.js';

export type { ModelKeyPolicy, SecretRefPolicy, TenantContext, TenantRef, TenantResolver, TenantRole, TenantStatus } from './kernel/tenancy/types.js';
export { SingleTenantResolver, INSTANCE_SCOPE_ID } from './kernel/tenancy/index.js';
export type { NetPolicy };

export type QuotaOp =
  | { kind: 'tool_call'; via: 'direct' | 'call_tool' | 'script' | 'eval' }
  | { kind: 'script_start' }
  | { kind: 'eval_run'; taskRuns: number }
  | { kind: 'create'; resource: 'server' | 'environment' | 'api_key' | 'member' | 'oauth_grant' }
  | { kind: 'mock_write'; bytes: number };

export type QuotaDecision =
  | { allowed: true }
  | { allowed: false; code: 'quota_exceeded' | 'plan_required' | 'tenant_suspended' | 'budget_cap'; meter?: string; retryAfterMs?: number; message: string; upgradeUrl?: string };

/** Core default: always allowed. */
export interface QuotaEnforcer {
  check(t: TenantRef, op: QuotaOp): Promise<QuotaDecision>;
}

export interface UsageEvent {
  tenantId: string;
  meter: 'tool_calls' | 'code_cpu_ms' | 'eval_task_runs' | 'active_principal';
  value: number;
  at: number;
  dedupKey: string;
  principalHash?: string;
}

/** Core default: no-op. */
export interface UsageSink {
  record(e: readonly UsageEvent[]): void;
}

export interface IdentityProvider {
  id: 'google' | 'github' | `oidc:${string}`;
  displayName: string;
  start(req: FastifyRequest, returnTo: string): Promise<{ redirectUrl: string }>;
  callback(req: FastifyRequest): Promise<{ subject: string; email: string; emailVerified: boolean; name: string; avatarUrl?: string }>;
}

export interface NeurouterExtensions {
  tenancy?: TenantResolver;
  quotas?: QuotaEnforcer;
  usage?: UsageSink;
  secretRefs?: SecretRefPolicy;
  modelKeys?: ModelKeyPolicy;
  /** Wraps the configured executor (cloud: FairShareExecutor). */
  executor?: (base: Executor) => Executor;
  /** Extra login providers (cloud: Google any-domain, GitHub). Declared for P1/P2; not rendered yet. */
  identityProviders?: IdentityProvider[];
  /** Extra Fastify plugins mounted after core routes; get the core Services. */
  routes?: Array<(app: FastifyInstance, s: Services) => Promise<void>>;
  /** Extra migrations, merged after core's by name (cloud names start with `c` + 4 digits, e.g. `c0001_billing`). */
  migrations?: { main?: Record<string, Migration>; audit?: Record<string, Migration> };
  /** Extra background jobs. */
  jobs?: Array<(sch: JobScheduler, s: Services) => void>;
  /** Merged into GET /api/auth/config → console feature flags (e.g. `{ tenancy: { multi: true } }`). */
  features?: () => Promise<Record<string, unknown>>;
  /** Tightens the upstream net policy per tenant (cloud: no private ranges). */
  netPolicy?: (base: NetPolicy, t: TenantRef) => NetPolicy;
}

/** Core defaults for the policy extensions (self-hosted OSS behaviour). */
export const DEFAULT_QUOTAS: QuotaEnforcer = { check: async () => ({ allowed: true }) };
export const DEFAULT_USAGE: UsageSink = { record: () => {} };
export const DEFAULT_SECRET_REFS: SecretRefPolicy = { allowEnvRefs: () => true };
export const DEFAULT_MODEL_KEYS: ModelKeyPolicy = { allowEnvKeys: () => true };
