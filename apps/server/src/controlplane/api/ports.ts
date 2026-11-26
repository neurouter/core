import type { ToolDef } from '@neurouter/shared';

/**
 * Data-plane functions the console uses, injected by the composition root (`deps.ts`) so the
 * control plane never imports the data plane (A1).
 */
export interface ConsolePorts {
  /** `search_tools` as an admin principal on one environment (default: the server's mock/dev env). */
  searchTools(tenantId: string, environmentId: string, q: string, format: 'json' | 'python', limit: number): Promise<{ tools: Array<Record<string, unknown>>; totalVisible: number; hint?: string; mode?: string }>;
  /** The exact `tools/list` entry for a tool in an environment (null env = a neutral dev context). */
  agentEntry(tenantId: string, tool: ToolDef, environmentId: string | null): Promise<Record<string, unknown>>;
  /** Health probe (no tool) or one read-tool call through the full pipeline (`via: console`). */
  testEnvironment(tenantId: string, environmentId: string, toolName: string | undefined, args: Record<string, unknown> | undefined, userId: string): Promise<{ ok: boolean; latencyMs: number | null; status?: number; credential: 'ok' | 'missing' | 'rejected' | 'not_required'; detail?: string; result?: unknown }>;
  /** Mock environments: drop the environment's shared mock state (reseeded on next use, with `seed` if given). */
  resetMock(tenantId: string, environmentId: string, seed?: number): Promise<void>;
  /** Mock sample for a tool (overlay preview): runs the tool against a scratch mock namespace. */
  mockSample(tenantId: string, environmentId: string, tool: ToolDef): Promise<unknown>;
  executorStatus(): { mode: 'embedded' | 'remote' | 'local' | 'off'; ok: boolean; montyVersion: string | null; poolMax: number; busy: number; detail?: string | null };
  /** Whether the user has connected an upstream account (oauth_passthrough broker). */
  upstreamConnected?(tenantId: string, environmentId: string, userId: string): Promise<boolean>;
}
