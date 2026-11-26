import type { HttpBinding, ToolDef } from '@neurouter/shared';

export interface BuiltRequest {
  method: HttpBinding['method'];
  url: URL;
  /** URL template for spans/audit (never filled values). */
  urlTemplate: string;
  headers: Record<string, string>;
  body: string | undefined;
}

export class RequestBuildError extends Error {
  constructor(
    message: string,
    readonly code: 'invalid_args' | 'host_not_allowed' | 'bad_base_url',
  ) {
    super(message);
  }
}

/**
 * Maps agent-visible args back to the spec's args (overlay renames; hidden args re-added with their
 * defaults; defaults applied when omitted) — the arguments step of §9.6 (5) uses this before validation.
 */
export function applyArgTransforms(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  const t = tool.args;
  if (!t) return out;
  for (const [k, v] of Object.entries(t.defaults ?? {})) if (out[k] === undefined) out[k] = v;
  return out;
}

/** Agent args (validated) → spec arg names (renames reversed, hidden args with defaults). */
export function toSpecArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const t = tool.args;
  if (!t) return args;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) out[t.renamed?.[k] ?? k] = v;
  for (const [k, v] of Object.entries(t.hidden ?? {})) if (out[k] === undefined && v !== undefined) out[k] = v;
  return out;
}

const PRIMITIVE = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : JSON.stringify(v));

/** OpenAPI query serialization (form/explode default; spaceDelimited/pipeDelimited; deepObject). */
export function serializeQuery(qs: URLSearchParams, name: string, value: unknown, style = 'form', explode = true): void {
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (style === 'form' && explode) for (const v of value) qs.append(name, PRIMITIVE(v));
    else qs.append(name, value.map(PRIMITIVE).join(style === 'spaceDelimited' ? ' ' : style === 'pipeDelimited' ? '|' : ','));
    return;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (style === 'deepObject') for (const [k, v] of entries) qs.append(`${name}[${k}]`, PRIMITIVE(v));
    else if (explode) for (const [k, v] of entries) qs.append(k, PRIMITIVE(v));
    else qs.append(name, entries.flatMap(([k, v]) => [k, PRIMITIVE(v)]).join(','));
    return;
  }
  qs.append(name, PRIMITIVE(value));
}

export function hostAllowed(url: URL, allowedHosts: readonly string[]): boolean {
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return allowedHosts.some((h) => {
    const a = h.toLowerCase();
    return a === host || a === hostname || (a.startsWith('*.') && hostname.endsWith(a.slice(1)));
  });
}

/**
 * HTTP request building (§9.9): `baseUrl` + `pathTemplate` with every path param
 * `encodeURIComponent`-encoded (no `/` or `..` survives), query per OpenAPI style/explode, headers
 * from params + static env headers + credentials, JSON or form body (spread reassembled). The
 * outbound host must be in the environment's `allowedHosts` (§18.5).
 */
export function buildHttpRequest(
  tool: ToolDef,
  specArgs: Record<string, unknown>,
  env: { baseUrl: string; headers: Record<string, string>; allowedHosts: readonly string[]; credentials: { headers: Record<string, string>; query: Record<string, string> } },
  version: string,
): BuiltRequest {
  const b = tool.binding;
  if (b.type !== 'http') throw new RequestBuildError('not an HTTP tool', 'invalid_args');
  let base: URL;
  try {
    base = new URL(env.baseUrl);
  } catch {
    throw new RequestBuildError(`invalid base URL ${env.baseUrl}`, 'bad_base_url');
  }
  const consumed = new Set<string>();
  let path = b.pathTemplate;
  for (const p of b.params.filter((x) => x.in === 'path')) {
    const v = specArgs[p.arg];
    consumed.add(p.arg);
    if (v === undefined || v === null || v === '') throw new RequestBuildError(`missing path parameter ${p.arg}`, 'invalid_args');
    const s = PRIMITIVE(v);
    path = path.split(`{${p.name}}`).join(encodeURIComponent(s).replace(/\./g, '%2E'));
  }
  const basePath = base.pathname.replace(/\/$/, '');
  const url = new URL(base.origin + basePath + path);
  const qs = new URLSearchParams();
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': `neurouter/${version}` };
  for (const [k, v] of Object.entries(env.headers)) headers[k.toLowerCase()] = v;
  for (const p of b.params) {
    if (p.in === 'path') continue;
    const v = specArgs[p.arg];
    consumed.add(p.arg);
    if (v === undefined || v === null) continue;
    if (p.in === 'query') serializeQuery(qs, p.name, v, p.style ?? 'form', p.explode ?? true);
    else if (p.in === 'header') headers[p.name.toLowerCase()] = PRIMITIVE(v);
    else if (p.in === 'cookie') headers.cookie = `${headers.cookie ? `${headers.cookie}; ` : ''}${p.name}=${encodeURIComponent(PRIMITIVE(v))}`;
  }
  for (const [k, v] of Object.entries(env.credentials.query)) qs.set(k, v);
  for (const [k, v] of Object.entries(env.credentials.headers)) headers[k.toLowerCase()] = v;
  const q = qs.toString();
  if (q) url.search = q;
  if (!hostAllowed(url, env.allowedHosts)) throw new RequestBuildError(`host ${url.host} is not in this environment's allowedHosts`, 'host_not_allowed');

  let body: string | undefined;
  if (b.body) {
    let payload: unknown;
    if (b.body.spread) {
      const obj: Record<string, unknown> = {};
      const props = b.body.properties;
      for (const [k, v] of Object.entries(specArgs)) {
        if (consumed.has(k)) continue;
        if (props && !props.includes(k)) continue;
        if (v !== undefined) obj[k] = v;
      }
      payload = Object.keys(obj).length || ['POST', 'PUT', 'PATCH'].includes(b.method) ? obj : undefined;
    } else if (b.body.arg) {
      payload = specArgs[b.body.arg];
    }
    if (payload !== undefined) {
      if (b.body.contentType === 'application/x-www-form-urlencoded') {
        const f = new URLSearchParams();
        for (const [k, v] of Object.entries((payload ?? {}) as Record<string, unknown>)) if (v !== undefined && v !== null) f.append(k, PRIMITIVE(v));
        body = f.toString();
        headers['content-type'] = 'application/x-www-form-urlencoded';
      } else {
        body = JSON.stringify(payload);
        headers['content-type'] = 'application/json';
      }
    }
  }
  return { method: b.method, url, urlTemplate: basePath + b.pathTemplate, headers, body };
}
