import { mcpUrl, resourceMetadataUrl } from '../../kernel/lib/mcp-url.js';

export { mcpResourcePath, mcpUrl, resourceMetadataUrl } from '../../kernel/lib/mcp-url.js';

export const MCP_SCOPES = ['mcp:tools', 'mcp:write', 'mcp:code'] as const;

/**
 * Protected Resource Metadata (RFC 9728). External AS passthrough lists the API's own issuer. The
 * document only echoes the URL, so an unknown tenant, server or environment gets the same shape as a
 * known one (no existence oracle before authentication).
 */
export function protectedResourceMetadata(publicUrl: string, server: string, env: string, externalIssuer?: string | null, tenant?: string | null) {
  return {
    resource: mcpUrl(publicUrl, server, env, tenant),
    authorization_servers: [externalIssuer ?? publicUrl],
    scopes_supported: [...MCP_SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: `Neurouter ${server} (${env})`,
  };
}

/** `WWW-Authenticate` for 401/403 (COPY Hub challenge.ts, per-endpoint PRM). */
export function bearerChallenge(publicUrl: string, server: string, env: string, error?: 'invalid_token' | 'insufficient_scope', description?: string, tenant?: string | null): string {
  const parts = [`resource_metadata="${resourceMetadataUrl(publicUrl, server, env, tenant)}"`, `scope="mcp:tools"`];
  if (error) parts.push(`error="${error}"`);
  if (description) parts.push(`error_description="${description.replace(/["\\]/g, '')}"`);
  return `Bearer ${parts.join(', ')}`;
}
