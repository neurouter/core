import { DEFAULT_EVAL_MODEL, OAUTH_SCOPE_MAP, parseSecretRef, PROVIDER_ENV_KEYS, providerForModel, type Diagnostic, type NeurouterYaml, type Scope } from '@neurouter/shared';

/**
 * neurouter.yaml keys that configure the process rather than the database (backend §6.2):
 * `instance.publicUrl`, `auth.oidc`, `settings.evals.apiKey` and `auth.externalAs`. They are read
 * once at boot, before the config is derived, and only fill what the environment leaves unset:
 * environment variables always win over the file (PUBLIC_URL, OIDC_*, OPENAI_API_KEY / …).
 * Secret values come from `env:NAME` references; `secret:NAME` references name secrets stored per
 * environment and cannot configure the instance, so they are reported and ignored.
 */
export interface FileEnvDefaults {
  /** Environment variables to add (only names absent from the source). */
  env: Record<string, string>;
  /** Boot warnings (unresolvable references). */
  warnings: string[];
  externalAs: { issuer: string; jwksUri?: string; audience: string; requiredScopes: string[]; scopeMap?: Record<string, Scope> } | null;
}

const unset = (src: Record<string, string | undefined>, k: string) => src[k] === undefined || src[k] === '';

/** The provider the file's `settings.evals.apiKey` is for: the provider of the eval model. */
export function evalKeyProvider(cfg: NeurouterYaml, source: Record<string, string | undefined> = {}) {
  return providerForModel(cfg.settings?.evals?.model ?? source.NEUROUTER_EVAL_MODEL ?? DEFAULT_EVAL_MODEL);
}

export function fileEnvDefaults(cfg: NeurouterYaml, source: Record<string, string | undefined>): FileEnvDefaults {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  const setDefault = (k: string, v: string | undefined) => {
    if (v !== undefined && v !== '' && unset(source, k)) env[k] = v;
  };
  const resolve = (ref: string, what: string): string | null => {
    const r = parseSecretRef(ref);
    if (!r || r.kind !== 'env') {
      warnings.push(`${what}: ${ref} is ignored; only env:NAME references can configure the instance`);
      return null;
    }
    const v = source[r.name];
    if (!v) {
      warnings.push(`${what}: ${r.name} is not set in the environment`);
      return null;
    }
    return v;
  };

  setDefault('PUBLIC_URL', cfg.instance?.publicUrl?.replace(/\/+$/, ''));

  const oidc = cfg.auth?.oidc;
  if (oidc && unset(source, 'OIDC_ISSUER') && unset(source, 'OIDC_CLIENT_ID') && unset(source, 'OIDC_CLIENT_SECRET')) {
    const secret = resolve(oidc.clientSecret, 'auth.oidc.clientSecret');
    if (secret) {
      env.OIDC_ISSUER = oidc.issuer;
      env.OIDC_CLIENT_ID = oidc.clientId;
      env.OIDC_CLIENT_SECRET = secret;
      setDefault('OIDC_DISPLAY_NAME', oidc.displayName);
      setDefault('OIDC_SCOPES', oidc.scopes?.join(' '));
      setDefault('OIDC_GROUPS_CLAIM', oidc.groupsClaim);
      setDefault('OIDC_ADMIN_GROUPS', oidc.adminGroups.join(','));
      setDefault('OIDC_ALLOWED_EMAIL_DOMAINS', oidc.allowedEmailDomains.join(','));
      setDefault('OIDC_DEFAULT_ROLE', oidc.defaultRole);
    } else warnings.push('auth.oidc is not applied: console OIDC sign-in stays off');
  }

  const apiKey = cfg.settings?.evals?.apiKey;
  if (apiKey) {
    const provider = evalKeyProvider(cfg, source);
    if (!provider) warnings.push('settings.evals.apiKey is ignored: cannot tell the provider of the eval model (prefix it with openai:, anthropic: or gemini:)');
    else if (unset(source, PROVIDER_ENV_KEYS[provider])) {
      const v = resolve(apiKey, 'settings.evals.apiKey');
      if (v) env[PROVIDER_ENV_KEYS[provider]] = v;
    }
  }

  const ext = cfg.auth?.externalAs;
  const externalAs = ext
    ? {
        issuer: ext.issuer,
        ...(ext.jwksUri ? { jwksUri: ext.jwksUri } : {}),
        audience: ext.audience ?? 'auto',
        requiredScopes: ext.requiredScopes ?? [],
        // external scope → Neurouter OAuth scope (mcp:*) → internal scope; mcp:* keep their identity mapping
        ...(ext.scopeMap ? { scopeMap: { ...OAUTH_SCOPE_MAP, ...Object.fromEntries(Object.entries(ext.scopeMap).map(([k, v]) => [k, OAUTH_SCOPE_MAP[v]])) } as Record<string, Scope> } : {}),
      }
    : null;
  return { env, warnings, externalAs };
}

/**
 * Static warnings for keys the server accepts but does not (fully) apply, shown by `validate` and
 * the console's config status with their line.
 */
export function configWarnings(cfg: NeurouterYaml, lineOf: (path: string) => number, file: string): Diagnostic[] {
  const out: Diagnostic[] = [];
  const warn = (path: string, message: string) => out.push({ severity: 'warning', code: 'config_ignored', message: `${path}: ${message}`, line: lineOf(path), col: 1, pointer: file });
  if (cfg.settings?.tasks) warn('settings.tasks', 'deprecated and ignored (no feature labels inferred tasks)');
  const oidcRef = cfg.auth?.oidc ? parseSecretRef(cfg.auth.oidc.clientSecret) : null;
  if (oidcRef && oidcRef.kind !== 'env') warn('auth.oidc.clientSecret', 'only env:NAME references are supported here; auth.oidc is not applied');
  const key = cfg.settings?.evals?.apiKey;
  if (key) {
    const r = parseSecretRef(key);
    if (r && r.kind !== 'env') warn('settings.evals.apiKey', 'only env:NAME references are supported here; the key is not applied');
    else if (!evalKeyProvider(cfg)) warn('settings.evals.apiKey', 'cannot tell the provider of settings.evals.model; the key is not applied');
  }
  return out;
}
