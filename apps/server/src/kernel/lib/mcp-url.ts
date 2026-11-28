/**
 * MCP endpoint URLs (multi-tenancy spec §3.2): `PUBLIC_URL/mcp/{server}/{env}` on a single-tenant
 * deployment, `PUBLIC_URL/mcp/{tenant}/{server}/{env}` on a multi-tenant one. Shared by the data
 * plane (resource URIs, PRM, challenges) and the control plane (console views, connect snippets, evals).
 */

/** The path after `/mcp/`: `{server}/{env}`, or `{tenant}/{server}/{env}` when a tenant slug is given. */
export function mcpResourcePath(server: string, env: string, tenant?: string | null): string {
  return tenant ? `${tenant}/${server}/${env}` : `${server}/${env}`;
}

/** The MCP endpoint URL (= its RFC 8707 resource). */
export function mcpUrl(publicUrl: string, server: string, env: string, tenant?: string | null): string {
  return `${publicUrl}/mcp/${mcpResourcePath(server, env, tenant)}`;
}

/** RFC 9728 PRM location for one MCP endpoint (§9.1). */
export function resourceMetadataUrl(publicUrl: string, server: string, env: string, tenant?: string | null): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp/${mcpResourcePath(server, env, tenant)}`;
}
