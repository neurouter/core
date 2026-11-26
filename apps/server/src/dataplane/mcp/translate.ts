import { hkdf } from '../../kernel/lib/crypto.js';
import { open, seal } from '../../kernel/secrets/envelope.js';
import type { Keyring } from '../../kernel/secrets/keyring.js';

/** What a prod-write confirmation `requestState` binds (§9.7; Hub `wrapRequestState` pattern). */
export interface ConfirmState {
  tool: string;
  argsHash: string;
  credentialKey: string;
  /** expiry, epoch ms */
  exp: number;
}

const AAD = 'neurouter-core:confirm:v1';
const keyFor = (keyring: Keyring, kekId: string) => hkdf(keyring.derivationKey(kekId), 'neurouter-core:confirm');

/** `v1.<kekId>.<base64url(nonce‖ciphertext)>`: AES-GCM under HKDF(KEK), so the client can neither read nor forge it. */
export function wrapConfirmState(keyring: Keyring, state: ConfirmState): string {
  const kekId = keyring.activeKekId;
  const sealed = seal(keyFor(keyring, kekId), Buffer.from(JSON.stringify(state)), AAD);
  return `v1.${kekId}.${Buffer.concat([sealed.nonce, sealed.ciphertext]).toString('base64url')}`;
}

export class RequestStateError extends Error {
  constructor(reason: string) {
    super(`Invalid requestState: ${reason}`);
    this.name = 'RequestStateError';
  }
}

export function unwrapConfirmState(keyring: Keyring, token: string, now: number): ConfirmState {
  const m = /^v1\.([A-Za-z0-9_-]{1,32})\.([A-Za-z0-9_-]+)$/.exec(token);
  if (!m || !keyring.has(m[1]!)) throw new RequestStateError('malformed');
  const raw = Buffer.from(m[2]!, 'base64url');
  let st: ConfirmState;
  try {
    st = JSON.parse(open(keyFor(keyring, m[1]!), { nonce: raw.subarray(0, 12), ciphertext: raw.subarray(12) }, AAD).toString('utf8')) as ConfirmState;
  } catch {
    throw new RequestStateError('tampered or foreign');
  }
  if (st.exp <= now) throw new RequestStateError('expired');
  return st;
}
