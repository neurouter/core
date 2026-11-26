import type { FastifyRequest } from 'fastify';
import { AppError } from '../../kernel/lib/errors.js';
import { envRefDenialMessage, type EnvRefGate } from '../../kernel/secrets/env-refs.js';
import { requireTenant } from '../auth/guards.js';

/** Every `env:NAME` reference in a request body fragment (auth descriptors, header refs), with its JSON path. */
export function envRefsIn(value: unknown, path: Array<string | number> = []): Array<{ name: string; path: Array<string | number> }> {
  if (typeof value === 'string') return value.startsWith('env:') ? [{ name: value.slice(4), path }] : [];
  if (Array.isArray(value)) return value.flatMap((v, i) => envRefsIn(v, [...path, i]));
  if (value && typeof value === 'object') return Object.entries(value).flatMap(([k, v]) => envRefsIn(v, [...path, k]));
  return [];
}

/**
 * Write-time check of `env:NAME` references (multi-tenancy spec §4.9 G12): 422 `unsupported_ref` when
 * the tenant may not use env references at all, or the name is a gateway-internal variable or outside
 * the operator allow-list. Resolve time refuses them again (they read as missing).
 */
export async function assertEnvRefsAllowed(gate: Pick<EnvRefGate, 'denial'>, req: FastifyRequest, value: unknown, basePath: Array<string | number>): Promise<void> {
  const tenant = requireTenant(req).tenant;
  for (const r of envRefsIn(value)) {
    const d = await gate.denial(tenant, r.name);
    if (d) throw AppError.validation(envRefDenialMessage(r.name, d), [{ path: [...basePath, ...r.path].map(String), message: envRefDenialMessage(r.name, d), code: 'unsupported_ref' }]);
  }
}
