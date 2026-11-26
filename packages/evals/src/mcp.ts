import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { META_TASK_ID } from '@neurouter/shared';

export interface McpToolInfo {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export interface McpCallResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  structuredContent?: unknown;
  _meta?: Record<string, unknown>;
}

/** What the runner needs from an MCP connection (tests use an in-memory fake). */
export interface McpSession {
  instructions: string | null;
  listTools(): Promise<McpToolInfo[]>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallResult>;
  close(): Promise<void>;
}

export const EVAL_CLIENT_INFO = { name: 'neurouter-eval', version: '0.1.0' } as const;

/**
 * Streamable-HTTP MCP client (`@modelcontextprotocol/client` 2.4.0) to a Neurouter endpoint, as a
 * real client connects: Bearer eval API key plus the eval-only headers (mock state namespace,
 * exposure). Version negotiation is automatic (2026-07-28 with the 2025-11-25 fallback).
 */
export async function createMcpHttpClient(opts: { url: string; apiKey: string; headers?: Record<string, string>; timeoutMs?: number; fetch?: typeof fetch }): Promise<McpSession> {
  const timeout = opts.timeoutMs ?? 60_000;
  const client = new Client(EVAL_CLIENT_INFO, { capabilities: {}, versionNegotiation: { mode: 'auto', probe: { timeoutMs: Math.min(timeout, 10_000) } } } as never);
  const transport = new StreamableHTTPClientTransport(new URL(opts.url), {
    requestInit: { headers: { authorization: `Bearer ${opts.apiKey}`, ...(opts.headers ?? {}) } },
    ...(opts.fetch ? { fetch: opts.fetch } : {}),
  } as never);
  await client.connect(transport, { timeout } as never);
  return {
    instructions: client.getInstructions() ?? null,
    async listTools() {
      const out: McpToolInfo[] = [];
      let cursor: string | undefined;
      do {
        const res = await client.listTools(cursor ? { cursor } : undefined, { timeout } as never);
        for (const t of res.tools) out.push({ name: t.name, ...(t.title ? { title: t.title } : {}), ...(t.description ? { description: t.description } : {}), inputSchema: t.inputSchema as Record<string, unknown> });
        cursor = res.nextCursor ?? undefined;
      } while (cursor);
      return out;
    },
    async callTool(name, args, signal) {
      const res = await client.callTool({ name, arguments: args }, { timeout, ...(signal ? { signal } : {}) } as never);
      return res as unknown as McpCallResult;
    },
    close: () => client.close(),
  };
}

export function taskIdFromResult(res: McpCallResult): string | null {
  const v = res._meta?.[META_TASK_ID];
  return typeof v === 'string' ? v : null;
}

export function resultText(res: McpCallResult): string {
  const t = res.content
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text!)
    .join('\n');
  if (t) return t;
  return res.structuredContent !== undefined ? JSON.stringify(res.structuredContent) : '';
}
