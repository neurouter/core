import { SEARCH_TOOLS, type ErrorCode, type ToolDef } from '@neurouter/shared';
import { Redactor } from '../../kernel/audit/redact.js';
import type { ArgIssue, ErrorSpec } from './draft.js';
import { closestNames, exampleArgs, isPagingArg, nounOf, parentListCall, pathId, propsOf, readCall, requiredOf, sampleValue, similarity } from './relations.js';
import { BUDGET, ENVELOPE_ERROR_CODES, type Call, type EnvelopeErrorCode, type ErrorInfo, type FieldIssue, type Retry } from './types.js';

/** v1 catalog code → contract-2 code and default retry advice. */
const CODE_MAP: Record<ErrorCode, { code: EnvelopeErrorCode; retry: Retry }> = {
  unknown_tool: { code: 'unknown_tool', retry: 'after_fix' },
  not_permitted: { code: 'forbidden', retry: 'no' },
  writes_disabled: { code: 'writes_disabled', retry: 'no' },
  invalid_args: { code: 'invalid_args', retry: 'after_fix' },
  policy_denied: { code: 'policy_denied', retry: 'no' },
  rate_limited: { code: 'rate_limited', retry: 'after_wait' },
  confirmation_declined: { code: 'confirmation_declined', retry: 'no' },
  confirmation_unsupported: { code: 'confirmation_unsupported', retry: 'no' },
  credential_missing: { code: 'unavailable', retry: 'no' },
  upstream_auth: { code: 'upstream_auth', retry: 'no' },
  upstream_auth_required: { code: 'upstream_auth', retry: 'after_fix' },
  upstream_not_found: { code: 'not_found', retry: 'after_fix' },
  upstream_conflict: { code: 'upstream_conflict', retry: 'after_fix' },
  upstream_validation: { code: 'upstream_rejected', retry: 'after_fix' },
  upstream_rate_limited: { code: 'rate_limited', retry: 'after_wait' },
  upstream_error: { code: 'upstream_error', retry: 'yes' },
  timeout: { code: 'timeout', retry: 'yes' },
  response_too_large: { code: 'too_large', retry: 'after_fix' },
  script_rejected: { code: 'script_error', retry: 'after_fix' },
  script_type_error: { code: 'script_error', retry: 'after_fix' },
  script_error: { code: 'script_error', retry: 'after_fix' },
  script_limit: { code: 'limit_exceeded', retry: 'after_fix' },
  executor_unavailable: { code: 'unavailable', retry: 'no' },
  executor_busy: { code: 'unavailable', retry: 'after_wait' },
  kill_switch: { code: 'unavailable', retry: 'no' },
  audit_unavailable: { code: 'unavailable', retry: 'after_wait' },
};

const DEFAULT_RETRY: Record<EnvelopeErrorCode, Retry> = {
  not_found: 'after_fix',
  invalid_args: 'after_fix',
  unknown_tool: 'after_fix',
  forbidden: 'no',
  writes_disabled: 'no',
  policy_denied: 'no',
  rate_limited: 'after_wait',
  confirmation_required: 'after_fix',
  confirmation_declined: 'no',
  confirmation_unsupported: 'no',
  upstream_auth: 'no',
  upstream_conflict: 'after_fix',
  upstream_rejected: 'after_fix',
  upstream_error: 'yes',
  timeout: 'yes',
  too_large: 'after_fix',
  script_error: 'after_fix',
  limit_exceeded: 'after_fix',
  unavailable: 'after_wait',
};

const isEnvelopeCode = (c: string): c is EnvelopeErrorCode => (ENVELOPE_ERROR_CODES as readonly string[]).includes(c);

export function mapCode(code: ErrorCode | EnvelopeErrorCode): { code: EnvelopeErrorCode; retry: Retry } {
  const m = CODE_MAP[code as ErrorCode];
  if (m) return m;
  return isEnvelopeCode(code) ? { code, retry: DEFAULT_RETRY[code] } : { code: 'unavailable', retry: 'no' };
}

export interface ErrorContext {
  /** environment slug, for messages */
  env: string;
  /** the tools the principal may see (next calls only name these) */
  tools: ToolDef[];
  /** closest tool names for an unknown tool (search index), computed by the caller */
  closest?: string[];
}

let redactor: Redactor | null = null;
/** Built-in redaction (sensitive keys, bearer/JWT/PEM/cloud tokens) over a value, then as text. */
function redacted(v: unknown): unknown {
  redactor ??= Redactor.builtins();
  return redactor.redact(v).value;
}

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** Upstream body → a short, redacted excerpt: problem `detail`/`message`/`title` when present, else compact JSON. */
export function upstreamDetail(body: unknown): string {
  const b = redacted(body);
  let s: string;
  if (typeof b === 'string') s = b;
  else if (b && typeof b === 'object') {
    const o = b as Record<string, unknown>;
    const err = o.error && typeof o.error === 'object' ? (o.error as Record<string, unknown>) : null;
    const pick = [o.detail, o.message, err?.message, o.error_description, typeof o.error === 'string' ? o.error : undefined, o.title].find((x) => typeof x === 'string' && x.trim());
    s = typeof pick === 'string' ? pick : (JSON.stringify(b) ?? '');
  } else s = b === null || b === undefined ? '' : String(b);
  return clip(s.replace(/\s+/g, ' ').trim(), BUDGET.upstreamChars);
}

/** A value as received, kept small (long strings and objects are clipped). */
function small(v: unknown): unknown {
  if (typeof v === 'string') return clip(v, 60);
  if (v === null || typeof v !== 'object') return v;
  const s = JSON.stringify(v) ?? '';
  return s.length <= 60 ? v : clip(s, 60);
}

function valueAt(args: Record<string, unknown>, path: string): unknown {
  let v: unknown = args;
  for (const seg of path.split('/').filter(Boolean)) v = v && typeof v === 'object' ? (v as Record<string, unknown>)[seg] : undefined;
  return v;
}

const dotted = (path: string): string => path.split('/').filter(Boolean).join('.');

/** Ajv failures → `fields` (every failure, `allowed` for enum/range/format/type). */
export function fieldIssues(issues: ArgIssue[], tool: ToolDef | null | undefined, args: Record<string, unknown>): FieldIssue[] {
  const props = tool ? propsOf(tool) : {};
  const out: FieldIssue[] = [];
  const seen = new Set<string>();
  for (const i of issues) {
    let f: FieldIssue;
    const field = dotted(i.path);
    const top = props[field] ?? {};
    switch (i.keyword) {
      case 'required': {
        const name = [field, String(i.params.missingProperty ?? '')].filter(Boolean).join('.');
        const p = props[name];
        f = { field: name, problem: 'required', ...(p && Array.isArray(p.enum) ? { allowed: p.enum } : {}) };
        break;
      }
      case 'enum':
        f = { field, received: small(valueAt(args, i.path)), allowed: (i.params.allowedValues as unknown[]) ?? [], problem: 'not an allowed value' };
        break;
      case 'const':
        f = { field, received: small(valueAt(args, i.path)), allowed: [i.params.allowedValue], problem: 'not the allowed value' };
        break;
      case 'minimum':
      case 'maximum':
      case 'exclusiveMinimum':
      case 'exclusiveMaximum': {
        const lo = typeof top.minimum === 'number' ? top.minimum : typeof top.exclusiveMinimum === 'number' ? `>${top.exclusiveMinimum}` : '';
        const hi = typeof top.maximum === 'number' ? top.maximum : typeof top.exclusiveMaximum === 'number' ? `<${top.exclusiveMaximum}` : '';
        f = { field, received: small(valueAt(args, i.path)), allowed: `${lo}..${hi}`, problem: 'out of range' };
        break;
      }
      case 'type':
        f = { field, received: small(valueAt(args, i.path)), allowed: String(i.params.type), problem: `must be ${String(i.params.type)}` };
        break;
      case 'format':
        f = { field, received: small(valueAt(args, i.path)), allowed: String(i.params.format), problem: `must be a ${String(i.params.format)}` };
        break;
      case 'additionalProperties': {
        const extra = String(i.params.additionalProperty ?? '');
        const near = closestNames(extra, Object.keys(props), 3, 0.5);
        f = { field: [field, extra].filter(Boolean).join('.'), received: small(valueAt(args, `${i.path}/${extra}`)), ...(near.length ? { allowed: near } : {}), problem: 'unknown argument' };
        break;
      }
      default:
        f = { field: field || '(arguments)', received: small(valueAt(args, i.path)), problem: i.message };
    }
    const k = `${f.field}|${f.problem}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return out;
}

/**
 * One corrected call (contract-v2 §2.3): received values clamped or replaced by the closest/first allowed
 * value, unknown arguments renamed to the missing one they resemble (`orderId` → `order_id`) or dropped,
 * missing required values taken from the tool's example or schema defaults. Null when nothing can be fixed.
 */
export function correctedArgs(tool: ToolDef, args: Record<string, unknown>, issues: ArgIssue[]): Record<string, unknown> | null {
  const props = propsOf(tool);
  const out: Record<string, unknown> = { ...args };
  const example = exampleArgs(tool) ?? {};
  const missing = issues.filter((i) => i.keyword === 'required' && !i.path).map((i) => String(i.params.missingProperty ?? ''));
  const extras = new Set(Object.keys(args).filter((k) => !(k in props)));
  // renames first: an unknown argument that looks like a missing required one
  for (const m of missing) {
    const best = [...extras].map((x) => ({ x, s: similarity(x, m) })).sort((a, b) => b.s - a.s)[0];
    if (best && best.s >= 0.6) {
      out[m] = args[best.x];
      delete out[best.x];
      extras.delete(best.x);
    }
  }
  for (const i of issues) {
    const name = dotted(i.path);
    if (name.includes('.')) continue; // nested values are not corrected
    const p = props[name] ?? {};
    switch (i.keyword) {
      case 'required': {
        const m = String(i.params.missingProperty ?? '');
        if (i.path || out[m] !== undefined) break;
        const v = example[m] ?? sampleValue(props[m]);
        if (v === undefined) return null;
        out[m] = v;
        break;
      }
      case 'enum': {
        const allowed = (i.params.allowedValues as unknown[]) ?? [];
        const got = String(out[name] ?? '');
        const near = closestNames(got, allowed.map(String), 1, 0.5)[0];
        out[name] = near !== undefined ? allowed.find((a) => String(a) === near) : allowed[0];
        break;
      }
      case 'minimum':
      case 'exclusiveMinimum':
        out[name] = typeof p.minimum === 'number' ? p.minimum : typeof p.exclusiveMinimum === 'number' ? p.exclusiveMinimum + 1 : out[name];
        break;
      case 'maximum':
      case 'exclusiveMaximum':
        out[name] = typeof p.maximum === 'number' ? p.maximum : typeof p.exclusiveMaximum === 'number' ? p.exclusiveMaximum - 1 : out[name];
        break;
      case 'type': {
        const t = String(i.params.type);
        const v = out[name];
        if ((t === 'integer' || t === 'number') && typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) out[name] = t === 'integer' ? Math.trunc(Number(v)) : Number(v);
        else if (t === 'string' && (typeof v === 'number' || typeof v === 'boolean')) out[name] = String(v);
        else if (t === 'boolean' && (v === 'true' || v === 'false')) out[name] = v === 'true';
        else {
          const s = example[name] ?? sampleValue(p);
          if (s === undefined) delete out[name];
          else out[name] = s;
        }
        break;
      }
      case 'additionalProperties': {
        const extra = String(i.params.additionalProperty ?? '');
        if (!i.path) delete out[extra];
        break;
      }
      default: {
        const s = example[name] ?? sampleValue(p);
        if (s !== undefined) out[name] = s;
        else if (!requiredOf(tool).includes(name)) delete out[name];
      }
    }
  }
  return out;
}

/** Neurouter-authored message per code (≤ 200 chars; what failed, and that nothing changed when true). */
function messageFor(code: EnvelopeErrorCode, spec: ErrorSpec, ec: ErrorContext, fields: FieldIssue[]): string {
  if (spec.text) return spec.text;
  const t = spec.tool;
  const name = t?.name ?? spec.name ?? 'the tool';
  const status = spec.upstream?.status;
  switch (code) {
    case 'not_found': {
      if (!spec.upstream) return clip(stripErrorId(spec.message), BUDGET.messageChars);
      const id = t ? pathId(t, spec.args ?? {}) : null;
      return id && t ? `No ${nounOf(t)} '${clip(String(id.value), 60)}' in ${ec.env}. Nothing changed.` : `The API found nothing for ${name} (${status ?? 404}) in ${ec.env}. Nothing changed.`;
    }
    case 'invalid_args': {
      if (!fields.length) return clip(stripErrorId(spec.message), BUDGET.messageChars);
      return `${fields.length} invalid argument${fields.length === 1 ? '' : 's'}; nothing was called.`;
    }
    case 'unknown_tool':
      return `No tool named '${clip(spec.name ?? name, 64)}' is available here; nothing was called.`;
    case 'upstream_auth':
      if (spec.code === 'upstream_auth_required') return clip(stripErrorId(spec.message), BUDGET.messageChars);
      return `The API refused the credential (${status ?? 'auth'}) for ${name}; nothing changed.`;
    case 'upstream_conflict':
      return `The API reported a conflict (${status ?? 409}) for ${name}; nothing changed. Re-read and retry.`;
    case 'upstream_rejected':
      return `The API rejected the ${name} request (${status ?? 400}); nothing changed. See upstream.`;
    case 'upstream_error':
      return status ? `The API failed (${status}) for ${name}; it may not have changed anything.` : clip(stripErrorId(spec.message), BUDGET.messageChars);
    case 'rate_limited':
      if (status === 429) return `The API is rate limiting ${name} (429); retry after the wait.`;
      return clip(stripErrorId(spec.message), BUDGET.messageChars);
    default:
      return clip(stripErrorId(spec.message), BUDGET.messageChars);
  }
}

function stripErrorId(m: string): string {
  return m.replace(/\s*\(error_id=[^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
}

const searchCall = (query: string): Call => ({ tool: SEARCH_TOOLS, args: { query: clip(query, 200) } });

/** Next calls per code (≥ 1 when any valid one exists). */
function nextFor(code: EnvelopeErrorCode, spec: ErrorSpec, ec: ErrorContext, corrected: Record<string, unknown> | null): Call[] {
  if (spec.next) return spec.next;
  const t = spec.tool;
  const args = spec.args ?? {};
  const extra = spec.extraArgs ?? {};
  const same: Call | null = t ? { tool: spec.name ?? t.name, args: { ...args, ...extra } } : null;
  switch (code) {
    case 'invalid_args':
      return t && corrected ? [{ tool: spec.name ?? t.name, args: { ...corrected, ...extra } }] : [];
    case 'not_found': {
      const parent = t ? parentListCall(t, args, ec.tools) : null;
      return parent ? [parent] : t ? [searchCall(t.title || t.name)] : [];
    }
    case 'unknown_tool':
      return [searchCall(spec.name ?? '')];
    case 'writes_disabled':
    case 'forbidden':
    case 'policy_denied':
    case 'confirmation_declined':
    case 'upstream_conflict': {
      const r = t && t.risk.write ? readCall(t, args, ec.tools) : null;
      return r ? [r] : [];
    }
    case 'rate_limited':
    case 'timeout':
    case 'upstream_error':
      return same ? [same] : [];
    case 'unavailable':
      return same && (spec.retry ?? mapCode(spec.code).retry) === 'after_wait' ? [same] : [];
    case 'too_large': {
      if (!t) return [];
      const limitKey = Object.keys(propsOf(t)).find((k) => isPagingArg(k) && /limit|per_page|page_size/i.test(k));
      if (!limitKey) return [];
      const cur = typeof args[limitKey] === 'number' ? (args[limitKey] as number) : 20;
      return [{ tool: t.name, args: { ...args, ...extra, [limitKey]: Math.max(1, Math.floor(cur / 2)) } }];
    }
    case 'upstream_rejected': {
      const ex = t ? exampleArgs(t) : null;
      return t && ex && JSON.stringify(ex) !== JSON.stringify(args) ? [{ tool: t.name, args: ex }] : [];
    }
    default:
      return [];
  }
}

/**
 * The error builder (contract-v2 §2.3): `{code, message, fields, retry, retry_after_ms, next, closest,
 * upstream, error_id, line}`, within 150 tokens (characters ÷ 4 ≤ 600), never with stack traces.
 */
export function buildError(spec: ErrorSpec, ec: ErrorContext): ErrorInfo {
  if (spec.info) return fitError({ ...spec.info, ...(spec.text ? { message: clip(spec.text, BUDGET.messageChars) } : {}), ...(spec.next ? { next: spec.next } : {}), ...(spec.line !== undefined ? { line: spec.line } : {}) });
  const m = mapCode(spec.code);
  const code = m.code;
  const args = spec.args ?? {};
  const fields = spec.issues?.length ? fieldIssues(spec.issues, spec.tool, args) : [];
  const corrected = code === 'invalid_args' && spec.tool && spec.issues?.length ? correctedArgs(spec.tool, args, spec.issues) : null;
  const closest = spec.closest ?? (code === 'unknown_tool' ? ec.closest : undefined);
  const info: ErrorInfo = {
    code,
    message: clip(messageFor(code, spec, ec, fields), BUDGET.messageChars),
    ...(fields.length ? { fields } : {}),
    retry: spec.retry ?? m.retry,
    ...(spec.retryAfterMs !== undefined ? { retry_after_ms: spec.retryAfterMs } : {}),
    next: nextFor(code, spec, ec, corrected),
    ...(closest?.length ? { closest: closest.slice(0, 5) } : {}),
    ...(spec.upstream ? { upstream: { status: spec.upstream.status, detail: upstreamDetail(spec.upstream.body) } } : {}),
    ...(spec.errorId ? { error_id: spec.errorId } : {}),
    ...(spec.line !== undefined ? { line: spec.line } : {}),
  };
  return fitError(info);
}

const size = (v: unknown): number => (JSON.stringify(v) ?? '').length;

/** Shrinks an error until its JSON fits the 150-token budget (characters ÷ 4 ≤ 600). */
export function fitError(e: ErrorInfo): ErrorInfo {
  const out: ErrorInfo = structuredClone(e);
  const steps: Array<(x: ErrorInfo) => void> = [
    (x) => x.fields?.forEach((f) => Array.isArray(f.allowed) && f.allowed.length > 8 && (f.allowed = [...f.allowed.slice(0, 8), '…'])),
    (x) => x.closest && (x.closest = x.closest.slice(0, 3)),
    (x) => x.upstream && (x.upstream.detail = clip(x.upstream.detail, 120)),
    (x) => x.fields && x.fields.length > 5 && (x.fields = x.fields.slice(0, 5)),
    (x) => x.fields?.forEach((f) => Array.isArray(f.allowed) && f.allowed.length > 4 && (f.allowed = [...f.allowed.slice(0, 4), '…'])),
    (x) => x.next.length > 1 && (x.next = x.next.slice(0, 1)),
    (x) => x.fields?.forEach((f) => delete f.received),
    (x) => (x.message = clip(x.message, 100)),
    (x) => x.upstream && (x.upstream.detail = clip(x.upstream.detail, 40)),
    (x) => delete x.closest,
    (x) => x.fields && x.fields.length > 2 && (x.fields = x.fields.slice(0, 2)),
    (x) => x.next[0] && size(x.next[0]) > 200 && (x.next = []),
    (x) => delete x.fields,
  ];
  for (const step of steps) {
    if (size(out) <= BUDGET.errorChars) break;
    step(out);
  }
  return out;
}
