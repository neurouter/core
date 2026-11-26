export * from './types.js';
export { SingleTenantResolver } from './single.js';

/**
 * Scope id for instance-level rows that are not owned by any tenant: instance settings (spec §4.6)
 * and platform audit events (§4.5). Not a row in `tenants`.
 */
export const INSTANCE_SCOPE_ID = '00000000-0000-7000-8000-000000000000';
