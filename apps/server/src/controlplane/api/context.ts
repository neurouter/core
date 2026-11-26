import type { Logger } from 'pino';
import type { AuditRecorder } from '../../kernel/audit/recorder.js';
import type { AuditStore } from '../../kernel/audit/store.js';
import type { Config } from '../../kernel/config/load.js';
import type { CoordinationStore } from '../../kernel/coordination/types.js';
import type { Databases } from '../../kernel/db/index.js';
import type { JobsService } from '../../kernel/jobs/jobs.service.js';
import type { Clock } from '../../kernel/lib/clock.js';
import type { RuntimeConfigSource } from '../../kernel/runtime-config.js';
import type { NamedSecrets } from '../../kernel/secrets/named-secrets.js';
import type { SettingsService } from '../../kernel/settings/settings.service.js';
import type { CommittedAuditRow } from '../../kernel/audit/writer.js';
import type { LocalLinkService } from '../auth/local-link.js';
import type { LoginService } from '../auth/login.js';
import type { OidcProvider } from '../auth/oidc.js';
import type { SessionService } from '../auth/sessions.js';
import type { ConfigSync } from '../config-sync/reconcile.js';
import type { ApiKeysService } from '../keys/api-keys.service.js';
import type { BuildsService } from '../servers/builds.service.js';
import type { ServersService } from '../servers/servers.service.js';
import type { GraphqlIntrospector, SpecFetcher } from '../servers/fetch-spec.js';
import type { UsersService } from '../users/users.service.js';
import type { ConsolePorts } from './ports.js';
import type { EvalsService } from '../evals/evals.service.js';
import type { Views } from './views.js';
import type { TenantResolver } from '../../kernel/tenancy/types.js';
import type { EnvRefGate } from '../../kernel/secrets/env-refs.js';
import type { ModelKeyPolicy } from '../../kernel/tenancy/types.js';

/** Everything the console API needs, built by the composition root (no data-plane types). */
export interface ApiContext {
  config: Config;
  logger: Logger;
  clock: Clock;
  dbs: Databases;
  coord: CoordinationStore;
  /** Tenant resolution (spec §3); handlers read the request's tenant with `tenantOf(req)`, never a constant. */
  tenancy: TenantResolver;
  /** `env:NAME` reference gate (spec §4.9 G12). */
  envRefs: EnvRefGate;
  /** Server-level LLM key policy (spec §8.8). */
  modelKeys: ModelKeyPolicy;
  /** Console feature flags from extensions (`/api/auth/config`). */
  features: () => Promise<Record<string, unknown>>;
  version: string;
  settings: SettingsService;
  audit: AuditRecorder;
  auditStore: AuditStore;
  jobs: JobsService;
  namedSecrets: NamedSecrets;
  runtime: RuntimeConfigSource;
  servers: ServersService;
  builds: BuildsService;
  fetchSpec: SpecFetcher;
  introspectGraphql: GraphqlIntrospector;
  configSync: ConfigSync;
  apiKeys: ApiKeysService;
  users: UsersService;
  sessions: SessionService;
  login: LoginService;
  oidcProvider: OidcProvider | null;
  links: LocalLinkService;
  views: Views;
  ports: ConsolePorts;
  embedderStatus: () => 'ready' | 'loading' | 'disabled' | 'error';
  embedderModel: string | null;
  coordinationBackend: 'memory' | 'postgres';
  instanceId: string;
  /** Eval service (§15); optional so route tests can build a context without it. */
  evals?: EvalsService;
  /** Audit post-commit hooks (SSE `call.recorded`). */
  postCommit: Array<(rows: readonly CommittedAuditRow[]) => void>;
}

/** Embedder status values the console understands (idle → loading). */
export function embedderView(s: string): 'ready' | 'loading' | 'disabled' | 'error' {
  if (s === 'ready' || s === 'disabled' || s === 'error') return s;
  return 'loading';
}
