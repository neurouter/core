/** OAuth scopes of Neurouter MCP endpoints (§13.3). Internal mapping: mcp:tools→tools:read, mcp:write→tools:write, mcp:code→code:run. */
export const SUPPORTED_SCOPES = ['mcp:tools', 'mcp:write', 'mcp:code'] as const;
export type McpOAuthScope = (typeof SUPPORTED_SCOPES)[number];

export const SCOPE_DESCRIPTIONS: Readonly<Record<McpOAuthScope, string>> = {
  'mcp:tools': 'Use the API tools of this environment on your behalf (read-only tools)',
  'mcp:write': 'Call tools that change data in this environment',
  'mcp:code': 'Run Python scripts (code mode) that call the API tools',
};

/** RFC 8414 authorization server metadata (§13.3; ADAPT Hub oauth/metadata.ts). */
export function authorizationServerMetadata(publicUrl: string, opts: { dcrEnabled: boolean }) {
  return {
    issuer: publicUrl,
    authorization_endpoint: `${publicUrl}/oauth/authorize`,
    token_endpoint: `${publicUrl}/oauth/token`,
    revocation_endpoint: `${publicUrl}/oauth/revoke`,
    ...(opts.dcrEnabled ? { registration_endpoint: `${publicUrl}/oauth/register` } : {}),
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_basic', 'client_secret_post'],
    scopes_supported: [...SUPPORTED_SCOPES],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${publicUrl}/connect`,
  };
}

/** Space-delimited scope → list; empty → `mcp:tools`; unknown → null. `mcp:tools` is always included. */
export function parseScope(scope: string | undefined | null): McpOAuthScope[] | null {
  const parts = (scope ?? '').split(/\s+/).filter(Boolean);
  if (parts.some((p) => !(SUPPORTED_SCOPES as readonly string[]).includes(p))) return null;
  return [...new Set(['mcp:tools', ...parts])] as McpOAuthScope[];
}
