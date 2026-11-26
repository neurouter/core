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

/** What a cursor is bound to: it only works for the same tool, arguments, contract, tenant and credential. */
export interface CursorBinding {
  tenantId: string;
  credentialKey: string;
  tool: string;
  /** the agent's arguments except the cursor itself */
  args: Record<string, unknown>;
  contract: number;
}

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
  constructor(
    private readonly key: () => Buffer,
    private readonly now: () => number,
    private readonly ttlMs = CURSOR_TTL_MS,
  ) {}

  static fromKeyring(keyring: Keyring, now: () => number): CursorCodec {
    let cached: Buffer | null = null;
    return new CursorCodec(() => (cached ??= hkdf(keyring.derivationKey(), 'neurouter-core:cursor:v1')), now);
  }

  private mac(body: string, b: CursorBinding): Buffer {
    const bind = hashCanonical({ t: b.tenantId, c: b.credentialKey, n: b.tool, a: b.args, v: b.contract });
    return hmacSha256(this.key(), `${body}|${bind}`).subarray(0, MAC_BYTES);
  }

  encode(payload: CursorPayload, b: CursorBinding): string {
    const exp = Math.ceil((this.now() + this.ttlMs) / 1000);
    const body = Buffer.from(JSON.stringify([exp, payload])).toString('base64url');
    return `${PREFIX}${body}.${this.mac(body, b).toString('base64url')}`;
  }

  /** Throws `CursorError` (malformed, mismatch = altered or other tool/arguments/credential, expired). */
  decode(cursor: string, b: CursorBinding): CursorPayload {
    const m = /^c_([A-Za-z0-9_-]{4,4096})\.([A-Za-z0-9_-]{16})$/.exec(cursor);
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
