/** RFC 9728 PRM location for one MCP endpoint `/mcp/{server}/{env}` (§9.1). */
export function resourceMetadataUrl(publicUrl: string, server: string, env: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp/${server}/${env}`;
}

export const MCP_SCOPES = ['mcp:tools', 'mcp:write', 'mcp:code'] as const;

/** Protected Resource Metadata (RFC 9728). External AS passthrough lists the API's own issuer. */
export function protectedResourceMetadata(publicUrl: string, server: string, env: string, externalIssuer?: string | null) {
  return {
    resource: `${publicUrl}/mcp/${server}/${env}`,
    authorization_servers: [externalIssuer ?? publicUrl],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: `Neurouter ${server} (${env})`,
  };
}

/** `WWW-Authenticate` for 401/403 (COPY Hub challenge.ts, per-endpoint PRM). */
export function bearerChallenge(publicUrl: string, server: string, env: string, error?: 'invalid_token' | 'insufficient_scope', description?: string): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(publicUrl, server, env)}"`, `scope="mcp:tools"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/["\\]/g, '')}"`);
  return `Bearer ${parts.join(', ')}`;
}
