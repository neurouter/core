import * as z from 'zod';
import { DiscoveryMode, EnvironmentKind, ExposureMode, ConfirmMode, Role, SpecFormatHint } from '../domain/index.js';
import { OPS_TOOLS } from '../mcp/tool-names.js';
import { LimitsInput } from './limits.js';
import { Policy } from './policy.js';
import { SecretRefString } from './secret-ref.js';

/**
 * `neurouter.yaml` (backend §6.2): the GitOps source for servers, environments and instance
 * settings. It never contains secret values, only references (`env:NAME`, `secret:NAME`).
 * Objects are strict so typos are reported with their path.
 */

export const SERVER_SLUG_RE = /^[a-z][a-z0-9-]{1,38}[a-z0-9]$/;
export const ENV_SLUG_RE = /^[a-z][a-z0-9-]{0,30}$/;
/** The built-in environment every server gets unless the file declares one with this slug (A42). */
export const BUILTIN_MOCK_ENV = 'mock';
/** `baseUrl: mock:` routes to the in-process mock generated from the spec (§16). */
export const MOCK_BASE_URL = 'mock:';

const HttpUrl = z.url({ protocol: /^https?$/ });
const ServerSlug = z.string().regex(SERVER_SLUG_RE, 'server slug: lowercase letters, digits and dashes, 3–40 chars, starting with a letter');
const EnvSlugYaml = z.string().regex(ENV_SLUG_RE, 'environment slug: lowercase letters, digits and dashes, 1–31 chars, starting with a letter');
const HeaderName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/, 'invalid header name');
/** Static headers must not carry credentials: those belong in `auth` with a secret reference. */
const CREDENTIAL_HEADER_RE = /^(authorization|proxy-authorization|cookie|x-api-key|api-key|x-auth-token|x-access-token)$|secret|token|api[-_]?key|password/i;

export const BaseUrl = z.union([z.literal(MOCK_BASE_URL), HttpUrl], { error: 'baseUrl must be "mock:" or an http(s) URL' });

/* ------------------------------------------------------------------ upstream auth (§13.5) */

const NamedSecret = z.strictObject({ name: z.string().min(1).max(128), secret: SecretRefString });

export const YamlUpstreamAuth = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('none') }),
  z.strictObject({ type: z.literal('bearer'), secret: SecretRefString }),
  z.strictObject({ type: z.literal('header'), header: NamedSecret.extend({ name: HeaderName }) }),
  /** Discouraged (the secret ends up in URLs); lint warns. */
  z.strictObject({ type: z.literal('query'), query: NamedSecret }),
  z.strictObject({ type: z.literal('basic'), username: z.string().min(1).max(256), secret: SecretRefString }),
  z.strictObject({
    type: z.literal('oauth_client_credentials'),
    oauth_client_credentials: z.strictObject({ tokenUrl: HttpUrl, clientId: z.string().min(1), clientSecret: SecretRefString, scopes: z.array(z.string()).default([]), audience: z.string().optional() }),
  }),
  z
    .strictObject({
      type: z.literal('oauth_passthrough'),
      /** Broker mode (default): the user connects once via the API's own authorization server. */
      oauth_passthrough: z
        .strictObject({ authorizationUrl: HttpUrl, tokenUrl: HttpUrl, clientId: z.string().min(1), clientSecret: SecretRefString.optional(), scopes: z.array(z.string()).default([]) })
        .optional(),
      /** External-AS mode (§13.4): forward the inbound JWT, only when its `aud` contains `upstreamAudience`. */
      forwardInboundToken: z.boolean().optional(),
      upstreamAudience: z.string().min(1).optional(),
    })
    .superRefine((a, ctx) => {
      if (a.forwardInboundToken && !a.upstreamAudience) ctx.addIssue({ code: 'custom', path: ['upstreamAudience'], message: 'forwardInboundToken requires upstreamAudience' });
      if (!a.forwardInboundToken && !a.oauth_passthrough) ctx.addIssue({ code: 'custom', path: ['oauth_passthrough'], message: 'broker mode needs oauth_passthrough { authorizationUrl, tokenUrl, clientId, scopes }' });
    }),
]);
export type YamlUpstreamAuth = z.infer<typeof YamlUpstreamAuth>;

/* ------------------------------------------------------------------ environments */

export const YamlWrites = z.strictObject({
  enabled: z.boolean().default(false),
  /** Allow-list of write tools; omitted = all write tools. */
  tools: z.array(z.string().min(1)).optional(),
  /** Prod default: `elicit`; never `none` on prod. Non-prod default: `none`. */
  confirm: ConfirmMode.optional(),
});
export type YamlWrites = z.infer<typeof YamlWrites>;

export const YamlEnvironment = z
  .strictObject({
    slug: EnvSlugYaml,
    name: z.string().min(1).max(100).optional(),
    kind: EnvironmentKind,
    baseUrl: BaseUrl,
    auth: YamlUpstreamAuth.default({ type: 'none' }),
    headers: z.record(HeaderName, z.string().max(4096)).default({}),
    writes: YamlWrites.default({ enabled: false }),
    codeMode: z.boolean().default(true),
    limits: LimitsInput.optional(),
    policies: z.array(Policy).default([]),
    /** Outbound host allow-list (default: the baseUrl host only). */
    allowedHosts: z.array(z.string().min(1).max(253)).optional(),
    /** Allow plain http for prod when the host is in a private network (§9.9). */
    allowHttp: z.boolean().optional(),
    /** Pin new builds automatically (dev/qa default true; prod default false, A3). */
    autoPromote: z.boolean().optional(),
    /** Pin a build by hash prefix (prod promotion from the file). */
    build: z.string().regex(/^[0-9a-f]{6,64}$/, 'build: a build hash prefix (hex)').optional(),
    /** Per-environment discovery override. */
    discovery: DiscoveryMode.optional(),
  })
  .superRefine((e, ctx) => {
    if (e.kind === 'prod' && e.writes.confirm === 'none') ctx.addIssue({ code: 'custom', path: ['writes', 'confirm'], message: 'prod environments cannot use confirm: none (use elicit or deny_without_elicitation)' });
    for (const name of Object.keys(e.headers)) {
      if (CREDENTIAL_HEADER_RE.test(name)) ctx.addIssue({ code: 'custom', path: ['headers', name], message: `header "${name}" looks like a credential; use auth (type: header) with a secret reference` });
    }
    if (e.baseUrl === MOCK_BASE_URL && e.auth.type !== 'none') ctx.addIssue({ code: 'custom', path: ['auth'], message: 'mock environments take no credentials (auth: { type: none })' });
  });
export type YamlEnvironment = z.infer<typeof YamlEnvironment>;

/* ------------------------------------------------------------------ servers */

export const YamlSpecSource = z
  .strictObject({
    url: HttpUrl.optional(),
    /** Relative to the yaml file. */
    path: z.string().min(1).optional(),
    format: SpecFormatHint.optional(),
    graphql: z.strictObject({ endpointPath: z.string().startsWith('/').default('/graphql'), selectionDepth: z.number().int().min(1).max(5).default(2) }).optional(),
    /** Re-fetch a `url` spec daily (job `spec.refresh`). */
    refresh: z.enum(['never', 'daily']).default('never'),
  })
  .refine((s) => (s.url === undefined) !== (s.path === undefined), 'spec needs exactly one of url or path');
export type YamlSpecSource = z.infer<typeof YamlSpecSource>;

export const YamlExposure = z.strictObject({
  mode: ExposureMode.default('auto'),
  discovery: DiscoveryMode.default('auto'),
  pinned: z.array(z.string().min(1)).default([]),
});

export const YamlOpsTools = z.strictObject(Object.fromEntries(OPS_TOOLS.map((t) => [t, z.boolean().optional()])) as Record<(typeof OPS_TOOLS)[number], z.ZodOptional<z.ZodBoolean>>);

export const YamlServer = z
  .strictObject({
    slug: ServerSlug,
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    spec: YamlSpecSource,
    /** Overlay file path (relative to the yaml file); when set, the overlay is file-managed. */
    overlay: z.string().min(1).optional(),
    exposure: YamlExposure.default({ mode: 'auto', discovery: 'auto', pinned: [] }),
    opsTools: YamlOpsTools.default({}),
    publicReport: z.boolean().default(false),
    environments: z.array(YamlEnvironment).default([]),
  })
  .superRefine((s, ctx) => {
    const seen = new Set<string>();
    s.environments.forEach((e, i) => {
      if (seen.has(e.slug)) ctx.addIssue({ code: 'custom', path: ['environments', i, 'slug'], message: `duplicate environment slug "${e.slug}"` });
      seen.add(e.slug);
    });
  });
export type YamlServer = z.infer<typeof YamlServer>;

/* ------------------------------------------------------------------ instance, auth, settings */

export const YamlOidc = z.strictObject({
  issuer: HttpUrl,
  clientId: z.string().min(1),
  clientSecret: SecretRefString,
  displayName: z.string().max(100).optional(),
  scopes: z.array(z.string()).optional(),
  adminGroups: z.array(z.string()).default([]),
  groupsClaim: z.string().optional(),
  allowedEmailDomains: z.array(z.string()).default([]),
  defaultRole: Role.optional(),
});

export const YamlExternalAs = z.strictObject({
  issuer: HttpUrl,
  jwksUri: HttpUrl.optional(),
  /** `auto` = the MCP resource URI of each endpoint. */
  audience: z.string().min(1).default('auto'),
  requiredScopes: z.array(z.string()).default([]),
  /** External scope → Neurouter OAuth scope (default identity for mcp:tools/mcp:write/mcp:code). */
  scopeMap: z.record(z.string(), z.enum(['mcp:tools', 'mcp:write', 'mcp:code'])).optional(),
});

export const EvalEffort = z.enum(['low', 'medium', 'high']);
export type EvalEffort = z.infer<typeof EvalEffort>;

export const YamlSettings = z.strictObject({
  codeMode: z.strictObject({ enabled: z.boolean().default(true) }).optional(),
  evals: z
    .strictObject({
      model: z.string().min(1).optional(),
      judgeModel: z.string().min(1).optional(),
      generatorModel: z.string().min(1).optional(),
      apiKey: SecretRefString.optional(),
      effort: EvalEffort.optional(),
      repeats: z.number().int().min(1).max(5).optional(),
      fallbacks: z.enum(['default', 'off']).optional(),
    })
    .optional(),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  discovery: z.strictObject({ nativeSearchClients: z.array(z.string()).default([]) }).optional(),
  tasks: z.strictObject({ labelInferred: z.boolean().default(false) }).optional(),
  audit: z
    .strictObject({
      storeOutputs: z.boolean().optional(),
      /** SIEM export: signed NDJSON POSTs of every audit row (at-least-once; receivers dedupe on id). */
      webhook: z.strictObject({ url: HttpUrl, secret: SecretRefString.optional(), enabled: z.boolean().default(true) }).optional(),
      /** SIEM export: one OTel log record per audit row over OTLP (standard OTEL_EXPORTER_OTLP_* variables). */
      otelLogs: z.boolean().optional(),
    })
    .optional(),
});
export type YamlSettings = z.infer<typeof YamlSettings>;

export const NeurouterYaml = z
  .strictObject({
    version: z.literal(1),
    instance: z.strictObject({ name: z.string().min(1).max(100).optional(), publicUrl: HttpUrl.optional() }).optional(),
    auth: z.strictObject({ oidc: YamlOidc.optional(), externalAs: YamlExternalAs.optional() }).optional(),
    settings: YamlSettings.optional(),
    servers: z.array(YamlServer).default([]),
  })
  .superRefine((f, ctx) => {
    const seen = new Set<string>();
    f.servers.forEach((s, i) => {
      if (seen.has(s.slug)) ctx.addIssue({ code: 'custom', path: ['servers', i, 'slug'], message: `duplicate server slug "${s.slug}"` });
      seen.add(s.slug);
    });
  });
export type NeurouterYaml = z.infer<typeof NeurouterYaml>;
export type NeurouterYamlInput = z.input<typeof NeurouterYaml>;

/** JSON Schema for editor completion (`npx neurouter validate --print-schema`). */
export function neurouterYamlJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(NeurouterYaml, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return { ...schema, $id: 'https://neurouter.dev/schemas/neurouter.yaml.json', title: 'neurouter.yaml' };
}

/** The effective confirm mode for an environment (prod default `elicit`, else `none`). */
export function effectiveConfirm(kind: EnvironmentKind, confirm: ConfirmMode | undefined): ConfirmMode {
  if (confirm) return confirm;
  return kind === 'prod' ? 'elicit' : 'none';
}
