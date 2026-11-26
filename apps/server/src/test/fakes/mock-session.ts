import { defaultScopeValue, generateValue, hashSeed, seededFaker, type MockRequest, type OpenApiMockModel } from '@neurouter/compiler';
import type { JsonSchema } from '@neurouter/shared';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function body(schema: JsonSchema | null, salt: string): Record<string, unknown> {
  if (!schema) return {};
  const defs = isObj(schema.$defs) ? (schema.$defs as Record<string, unknown>) : {};
  const v = generateValue(schema, 'body', { faker: seededFaker(hashSeed('session', salt)), defs, depth: 0, index: 1 });
  return isObj(v) ? v : {};
}

/**
 * A deterministic mock session over every operation of a model (P0b parity golden): per stateful op
 * list (plain, paged, filtered, other scope), read (hit + 404), create, update/replace, delete
 * (+ read-after-delete), then actions, an unknown path (404) and a wrong method (405).
 */
export function recordedSession(model: OpenApiMockModel): MockRequest[] {
  const out: MockRequest[] = [];
  for (const op of model.operations) {
    const r = op.resource ? model.resources[op.resource] : undefined;
    const idOf = (n: number) => (r?.idType === 'string' ? `${r.name}_${n}` : String(n));
    const path = (id: number, scopeOverride?: string) =>
      op.pathTemplate.replace(/\{([^}]+)\}/g, (_, p: string) => {
        if (p === op.idParam) return encodeURIComponent(idOf(id));
        return encodeURIComponent(scopeOverride ?? (r ? defaultScopeValue(p, r) : 'demo'));
      });
    const salt = `${op.method} ${op.pathTemplate}`;
    switch (op.kind) {
      case 'list': {
        out.push({ method: 'GET', path: path(0) });
        const q: Record<string, string> = {};
        if (op.paging.limit) q[op.paging.limit] = '5';
        if (op.paging.page) q[op.paging.page] = '2';
        else if (op.paging.offset) q[op.paging.offset] = '5';
        else if (op.paging.cursor) q[op.paging.cursor] = '5';
        if (Object.keys(q).length) out.push({ method: 'GET', path: path(0), query: q });
        for (const param of Object.keys(op.filters).slice(0, 2)) out.push({ method: 'GET', path: `${path(0)}?${param}=all` }, { method: 'GET', path: path(0), query: { [param]: 'open,closed,available,sold' } });
        if (op.scopeParams.length) out.push({ method: 'GET', path: path(0, 'other-scope') });
        break;
      }
      case 'read':
        out.push({ method: op.method, path: path(1) }, { method: op.method, path: path(999) });
        break;
      case 'create':
        out.push({ method: op.method, path: path(0), body: body(op.requestSchema, salt) });
        out.push({ method: op.method, path: path(0), body: body(op.requestSchema, `${salt}#2`) });
        if (op.requestSchema && Array.isArray(op.requestSchema.required) && op.requestSchema.required.length) out.push({ method: op.method, path: path(0), body: {} });
        break;
      case 'update':
      case 'replace': {
        const b = body(op.requestSchema, salt);
        if (op.bodyId && r) b[r.idField] = r.idType === 'integer' ? 2 : idOf(2);
        out.push({ method: op.method, path: path(2), body: b }, { method: op.method, path: path(998), body: op.bodyId && r ? { ...b, [r.idField]: r.idType === 'integer' ? 998 : idOf(998) } : b });
        break;
      }
      case 'delete':
        out.push({ method: op.method, path: path(3) }, { method: op.method, path: path(3) });
        break;
      case 'action':
        out.push({ method: op.method, path: path(1), ...(op.method !== 'GET' ? { body: body(op.requestSchema, salt) } : {}) });
        break;
    }
  }
  // read back every list after the writes
  for (const op of model.operations) if (op.kind === 'list') out.push({ method: 'GET', path: op.pathTemplate.replace(/\{([^}]+)\}/g, (_, p: string) => encodeURIComponent(defaultScopeValue(p, model.resources[op.resource!]!))), query: { per_page: '100', limit: '100' } });
  out.push({ method: 'GET', path: '/definitely/not/here' });
  const first = model.operations.find((o) => o.kind === 'list');
  if (first) out.push({ method: 'PATCH', path: first.pathTemplate.replace(/\{([^}]+)\}/g, 'x') });
  return out;
}
