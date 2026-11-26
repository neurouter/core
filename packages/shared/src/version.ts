export const PRODUCT_NAME = 'Neurouter';
export const API_VERSION = 'v1';
export const API_BASE_PATH = '/api';
/** MCP protocol versions served (modern first; the SDK provides the 2025-11-25 legacy path). */
export const SUPPORTED_PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25'] as const;
export type SupportedProtocolVersion = (typeof SUPPORTED_PROTOCOL_VERSIONS)[number];
/** The single OSS tenant (backend spec conventions). */
export const DEFAULT_TENANT_ID = '00000000-0000-7000-8000-000000000001';
