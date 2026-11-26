import * as z from 'zod';

/**
 * Secret references (backend §6.2, §13.5): `env:NAME` (read from the process env at call time) or
 * `secret:NAME` (stored encrypted in the DB, set via the console). Literal secrets are rejected.
 */
export const SECRET_REF_RE = /^(env:[A-Za-z_][A-Za-z0-9_]{0,127}|secret:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/;
export const LITERAL_SECRET_MESSAGE = 'Literal secrets are not allowed; use env:NAME or secret:NAME';

export const SecretRefString = z.string().regex(SECRET_REF_RE, LITERAL_SECRET_MESSAGE);
export type SecretRefString = z.infer<typeof SecretRefString>;

export type ParsedSecretRef = { kind: 'env'; name: string } | { kind: 'secret'; name: string };

/** Parses `env:NAME` / `secret:NAME`; null for anything else. */
export function parseSecretRef(ref: string): ParsedSecretRef | null {
  if (!SECRET_REF_RE.test(ref)) return null;
  const i = ref.indexOf(':');
  const kind = ref.slice(0, i) as 'env' | 'secret';
  return { kind, name: ref.slice(i + 1) };
}

/** Stored secret names (`PUT /api/environments/:id/secrets/:name`). */
export const SecretName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/);
