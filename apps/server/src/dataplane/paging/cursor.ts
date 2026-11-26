import { hkdf, hmacSha256, timingSafeEqualBuf } from '../../kernel/lib/crypto.js';
import { hashCanonical } from '../../kernel/lib/jcs.js';
import type { Keyring } from '../../kernel/secrets/keyring.js';

/**
 * Where the next page starts (contract-v2 §2.1). One of:
 * - `u`: an upstream cursor / page token, or the last item id for `starting_after` APIs;
 * - `l`: the query of a `Link: rel=next` URL (validated against the environment's base URL);
 * - `p`: a page number (page/per_page APIs);
 * - `o`: an offset (offset/limit APIs);
 * - `r`: an item offset into a stored result (Neurouter cut the list), then optionally the upstream's next page.
 */
export type CursorPayload =
  | { k: 'u'; v: string }
  | { k: 'l'; q: Record<string, string | string[]> }
  | { k: 'p'; n: number }
  | { k: 'o'; n: number }
  | { k: 'r'; h: string; n: number; t?: number | null; then?: Exclude<CursorPayload, { k: 'r' }> | null };

/** What a cursor is bound to: it only works for the same tool, query arguments, contract, tenant and credential. */
export interface CursorBinding {
  tenantId: string;
  credentialKey: string;
  tool: string;
  /** the agent's query arguments: not the cursor itself, not the `fields` projection, not a default page size (`boundArgs`) */
  args: Record<string, unknown>;
  contract: number;
}

/** Bound arguments up to this size travel in the cursor, so a cursor sent with other arguments can name its own (B5). */
const MAX_EMBEDDED_ARGS = 512;

export type CursorProblem = 'malformed' | 'mismatch' | 'expired';

export class CursorError extends Error {
  constructor(readonly problem: CursorProblem) {
    super(problem === 'expired' ? 'cursor expired' : problem === 'mismatch' ? 'cursor does not belong to this tool and these arguments' : 'not a cursor from page.next_cursor');
    this.name = 'CursorError';
  }
}

/** Cursors last as long as the stored result pages they may point at (1 h). */
export const CURSOR_TTL_MS = 3_600_000;
const PREFIX = 'c_';
const MAC_BYTES = 12;

/** Cursor strings start with `c_`; anything else passed as `cursor` is an upstream value (passed through). */
export const isNeurouterCursor = (s: string): boolean => s.startsWith(PREFIX);

/**
 * Opaque, signed page cursors: `c_<base64url(payload)>.<base64url(HMAC-SHA256 truncated to 96 bits)>`. The MAC
 * covers the payload and the binding (tenant, credential, tool, argument hash, contract), so a cursor cannot be
 * altered, replayed with other arguments or by another credential; the payload carries its expiry.
 */
export class CursorCodec {
  private readonly re: RegExp;

  constructor(
    private readonly key: () => Buffer,
    private readonly now: () => number,
    private readonly ttlMs = CURSOR_TTL_MS,
    /** `c_` page cursors; `ct_` confirm tokens use the same format with their own key */
    private readonly prefix = PREFIX,
  ) {
    this.re = new RegExp(`^${prefix}([A-Za-z0-9_-]{4,4096})\\.([A-Za-z0-9_-]{16})$`);
  }

  static fromKeyring(keyring: Keyring, now: () => number, info = 'neurouter-core:cursor:v1', ttlMs = CURSOR_TTL_MS, prefix = PREFIX): CursorCodec {
    let cached: Buffer | null = null;
    return new CursorCodec(() => (cached ??= hkdf(keyring.derivationKey(), info)), now, ttlMs, prefix);
  }

  private mac(body: string, b: CursorBinding): Buffer {
    const bind = hashCanonical({ t: b.tenantId, c: b.credentialKey, n: b.tool, a: b.args, v: b.contract });
    return hmacSha256(this.key(), `${body}|${bind}`).subarray(0, MAC_BYTES);
  }

  encode(payload: CursorPayload | Record<string, unknown>, b: CursorBinding): string {
    const exp = Math.ceil((this.now() + this.ttlMs) / 1000);
    // page cursors carry their bound arguments (when small) so a mismatch can suggest continuing with them; the MAC
    // covers them. Confirm tokens (`ct_`) do not: they stay short, and their binding is never shown back
    const args = this.prefix === PREFIX && JSON.stringify(b.args).length <= MAX_EMBEDDED_ARGS ? [b.args] : [];
    // nulls are left out (short cursors); a missing `then`/`t` reads as none
    const body = Buffer.from(JSON.stringify([exp, payload, ...args], (_k, v: unknown) => (v === null ? undefined : v))).toString('base64url');
    return `${this.prefix}${body}.${this.mac(body, b).toString('base64url')}`;
  }

  /**
   * The query arguments a cursor was issued for, when it carries them and they verify (same tool, credential, tenant;
   * unaltered, unexpired): what to send with it to continue. Null otherwise.
   */
  boundArgs(cursor: string, b: Omit<CursorBinding, 'args'>): Record<string, unknown> | null {
    const m = this.re.exec(cursor);
    if (!m) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'));
    } catch {
      return null;
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'number' || parsed[0] * 1000 <= this.now()) return null;
    const args = parsed[2];
    if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
    return timingSafeEqualBuf(this.mac(m[1]!, { ...b, args: args as Record<string, unknown> }), Buffer.from(m[2]!, 'base64url')) ? (args as Record<string, unknown>) : null;
  }

  /** Throws `CursorError` (malformed, mismatch = altered or other tool/arguments/credential, expired). */
  decode(cursor: string, b: CursorBinding): CursorPayload {
    const m = this.re.exec(cursor);
    if (!m) throw new CursorError('malformed');
    if (!timingSafeEqualBuf(this.mac(m[1]!, b), Buffer.from(m[2]!, 'base64url'))) throw new CursorError('mismatch');
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8'));
    } catch {
      throw new CursorError('malformed');
    }
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'number' || !parsed[1] || typeof parsed[1] !== 'object') throw new CursorError('malformed');
    if (parsed[0] * 1000 <= this.now()) throw new CursorError('expired');
    return parsed[1] as CursorPayload;
  }
}
