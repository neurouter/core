import { getIntrospectionQuery } from 'graphql';
import { isObj } from '../util.js';

/** The introspection query sent to a live GraphQL endpoint (CLI `--graphql-endpoint`, console import). */
export const GRAPHQL_INTROSPECTION_QUERY = getIntrospectionQuery({ descriptions: true });

/**
 * Accept header for GraphQL requests: the GraphQL-over-HTTP media type, JSON, then anything (some
 * servers answer 406 to an Accept list without a wildcard).
 */
export const GRAPHQL_ACCEPT = 'application/graphql-response+json, application/json;q=0.9, */*;q=0.8';

export type IntrospectionOutcome =
  | { ok: true; json: string }
  | { ok: false; reason: 'introspection_disabled' | 'not_graphql'; message: string };

/**
 * Checks an introspection response body: `{ data: { __schema } }` (or a bare `{ __schema }`) → the
 * introspection JSON the compiler accepts; `errors` without a schema (introspection turned off) or
 * anything else → a reason the caller can show.
 */
export function readIntrospectionResponse(text: string): IntrospectionOutcome {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not_graphql', message: 'The endpoint did not answer with JSON; is it a GraphQL endpoint?' };
  }
  if (!isObj(doc)) return { ok: false, reason: 'not_graphql', message: 'The endpoint did not answer with a GraphQL response object' };
  const schema = isObj(doc.data) ? doc.data.__schema : doc.__schema;
  if (isObj(schema)) return { ok: true, json: JSON.stringify({ __schema: schema }) };
  const errors = Array.isArray(doc.errors) ? doc.errors.map((e) => (isObj(e) && typeof e.message === 'string' ? e.message : '')).filter(Boolean) : [];
  if (errors.length) return { ok: false, reason: 'introspection_disabled', message: `The endpoint refused the introspection query: ${errors.join('; ').slice(0, 300)}` };
  return { ok: false, reason: 'not_graphql', message: 'The response has no __schema; is it a GraphQL endpoint?' };
}
