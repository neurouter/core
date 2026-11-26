import type { Kysely } from 'kysely';
import type { ToolDef } from '@neurouter/shared';
import type { MainDB } from '../../kernel/db/schema.js';
import { newId } from '../../kernel/lib/ids.js';
import type { Keyring } from '../../kernel/secrets/keyring.js';
import { nounOf, pathId } from '../envelope/relations.js';
import { CursorCodec, CursorError } from '../paging/cursor.js';

/** Confirm tokens last 5 minutes (contract-v2 §4.6). */
export const CONFIRM_TOKEN_TTL_MS = 5 * 60_000;

/** What a confirm token is bound to: the exact call (tool + arguments), the environment and the principal. */
export interface ConfirmBinding {
  tenantId: string;
  environmentId: string;
  credentialKey: string;
  tool: string;
  /** the arguments without `confirm`/`dry_run` (for scripts: code, inputs and the plan hash) */
  args: Record<string, unknown>;
}

export type ConfirmProblem = 'malformed' | 'mismatch' | 'expired' | 'used';

/**
 * Confirm tokens for destructive writes outside prod (D5): `ct_<payload>.<MAC>` in the cursor format with its own
 * key, bound to tenant, environment, credential, tool and arguments, 5 minutes, single use (`confirm_nonces`, so
 * a token is spent on every instance). A token proves the agent saw the plan; it is never an approval in prod.
 */
export class ConfirmTokens {
  private readonly codec: CursorCodec;

  constructor(
    private readonly db: Kysely<MainDB>,
    keyring: Keyring,
    private readonly now: () => number,
  ) {
    this.codec = CursorCodec.fromKeyring(keyring, now, 'neurouter-core:confirm-token:v1', CONFIRM_TOKEN_TTL_MS, 'ct_');
  }

  private bind(b: ConfirmBinding) {
    return { tenantId: b.tenantId, credentialKey: b.credentialKey, tool: `${b.environmentId}|${b.tool}`, args: b.args, contract: 2 };
  }

  mint(b: ConfirmBinding): string {
    return this.codec.encode({ j: newId() }, this.bind(b));
  }

  /** Checks and spends a token; returns the problem, or null when the call may run. */
  async spend(token: string, b: ConfirmBinding): Promise<ConfirmProblem | null> {
    let payload: Record<string, unknown>;
    try {
      payload = this.codec.decode(token, this.bind(b)) as unknown as Record<string, unknown>;
    } catch (err) {
      return err instanceof CursorError ? err.problem : 'malformed';
    }
    const jti = typeof payload.j === 'string' ? payload.j : null;
    if (!jti) return 'malformed';
    const now = this.now();
    try {
      await this.db.insertInto('confirm_nonces').values({ id: jti, tenant_id: b.tenantId, expires_at: now + CONFIRM_TOKEN_TTL_MS }).execute();
    } catch {
      return 'used';
    }
    // tenant-scope: system-job (expired nonces of every tenant; cheap, indexed)
    if (Math.random() < 0.05) void this.db.deleteFrom('confirm_nonces').where('expires_at', '<', now).execute().catch(() => {});
    return null;
  }
}

/** The plan of a write (contract-v2 §3, §4.6): what it targets, how, whether it can be undone and its effect. */
export interface WritePlan {
  tool: string;
  target?: string;
  method: string;
  path: string;
  args: Record<string, unknown>;
  reversible: boolean;
  effect: string;
  /** overlay `readBack`: the target's current values (label fields and the fields the write changes) */
  before?: Record<string, unknown>;
}

/** `cancel_order(order_id=order_1)` → target `order order_1`, effect from the description (the paragraph after the title, else its first sentence). */
export function writePlan(t: ToolDef, args: Record<string, unknown>): WritePlan {
  const method = t.binding.type === 'http' ? t.binding.method : t.binding.type === 'graphql' ? 'POST' : 'SCRIPT';
  const path = t.binding.type === 'http' ? t.binding.pathTemplate : t.binding.type === 'graphql' ? `graphql:${t.binding.operationType}` : t.name;
  const id = pathId(t, args);
  const paras = t.description.split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);

  const text = (paras.length > 1 ? paras[1] : paras[0]) ?? t.title ?? t.name;
  const sentence = /^(.{10,200}?[.!?])(\s|$)/.exec(text)?.[1] ?? text.slice(0, 200);
  return { tool: t.name, ...(id ? { target: `${nounOf(t)} ${String(id.value).slice(0, 60)}` } : {}), method, path, args, reversible: !t.risk.destructive, effect: text.length <= 200 ? text : sentence };
}

const LABEL_KEYS = ['name', 'title', 'display_name', 'displayName', 'login', 'email', 'number', 'customerId', 'customer_id', 'status', 'state'];

function at(o: unknown, path: string): unknown {
  let v: unknown = o;
  for (const k of path.split('.')) v = v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined;
  return v;
}

const short = (v: unknown): string => (typeof v === 'string' ? v.slice(0, 40) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

/**
 * Overlay `readBack` (contract-v2 §4.6, P5): a human label of the write's target from its read
 * (`order order_1 (customer_3, shipped, 171.13 EUR)`) and the values an agent verifies: the label fields, the
 * fields the write's arguments name, and status/state.
 */
export function readBackView(t: ToolDef, args: Record<string, unknown>, entity: unknown, label?: string[]): { label: string; values: Record<string, unknown> } {
  const id = pathId(t, args);
  const keys = label?.length ? label : LABEL_KEYS.filter((k) => at(entity, k) !== undefined && typeof at(entity, k) !== 'object').slice(0, 3);
  const parts = keys.map((k) => short(at(entity, k))).filter(Boolean);
  const e = entity && typeof entity === 'object' && !Array.isArray(entity) ? (entity as Record<string, unknown>) : {};
  if (!label?.length && typeof e.total === 'number') parts.push(`${e.total}${typeof e.currency === 'string' ? ` ${e.currency}` : ''}`);
  const values: Record<string, unknown> = {};
  for (const k of [...keys, ...Object.keys(args), 'status', 'state']) {
    const v = at(entity, k);
    if (v !== undefined && !(k in values) && (typeof v !== 'object' || v === null || JSON.stringify(v).length <= 300)) values[k] = v;
  }
  const head = `${nounOf(t)}${id ? ` ${String(id.value).slice(0, 60)}` : ''}`;
  return { label: parts.length ? `${head} (${parts.slice(0, 4).join(', ')})` : head, values };
}
