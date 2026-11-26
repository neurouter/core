import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { expect } from 'vitest';

/**
 * Golden files for agent-facing MCP responses (contract v1 and v2). `UPDATE_GOLDEN=1` rewrites the file;
 * otherwise every recorded case must match byte for byte after normalization (ids, timings).
 */
export class Golden {
  private readonly cases: Record<string, unknown> = {};
  private readonly expected: Record<string, unknown> | null;

  constructor(private readonly file: string) {
    this.expected = existsSync(file) && process.env.UPDATE_GOLDEN !== '1' ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : null;
  }

  /** Records one case and asserts it against the golden file (when one exists). */
  check(name: string, value: unknown): void {
    const v = normalize(value);
    this.cases[name] = v;
    if (this.expected) expect(JSON.stringify(v, null, 1), `golden ${name}`).toBe(JSON.stringify(this.expected[name], null, 1));
  }

  /** Writes the file in update mode; otherwise asserts that no golden case went missing. */
  finish(): void {
    if (!this.expected) {
      writeFileSync(this.file, `${JSON.stringify(this.cases, null, 1)}\n`);
      return;
    }
    expect(Object.keys(this.cases).sort()).toEqual(Object.keys(this.expected).sort());
  }
}

const VOLATILE_NUMBERS = ['seconds', 'wallMs', 'duration_ms', 'durationMs', 'latencyMs', 'suspensions', 'retry_after_ms', 'retryAfterMs', 'dev.neurouter/retry-after-ms'];

/** Replaces values that differ between runs (uuids, error ids, handles, task handles, page cursors, confirm tokens, timings). */
export function normalize(value: unknown): unknown {
  let s = JSON.stringify(value);
  s = s.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>');
  s = s.replace(/err_[A-Za-z0-9]{16}/g, 'err_<id>');
  s = s.replace(/rh_[A-Za-z0-9]{22}/g, 'rh_<id>');
  // contract-2 page cursors (signed, expiring): their content is covered by the paging tests
  s = s.replace(/(?<![A-Za-z0-9_-])c_[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g, 'c_<cursor>');
  // a cursor clipped as an error field's `received` (cursors carry their bound arguments since 0.3.1)
  s = s.replace(/(?<![A-Za-z0-9_-])c_[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]*)?…/g, 'c_<cursor>…');
  s = s.replace(/(?<![A-Za-z0-9_-])ct_[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{16}(?![A-Za-z0-9_-])/g, 'ct_<token>');
  s = s.replace(/\bt_[A-Za-z0-9]{8}\b/g, 't_<id>');
  s = s.replace(/nrk_[A-Za-z0-9_]+/g, 'nrk_<key>');
  for (const k of VOLATILE_NUMBERS) s = s.replace(new RegExp(`(\\\\*"${k.replace(/[/.]/g, '\\$&')}\\\\*":)[\\d.]+`, 'g'), '$10');
  return JSON.parse(s) as unknown;
}

/** Raw JSON-RPC client for one MCP endpoint (stateless legacy era by default), returning whole JSON-RPC messages. */
export function rawMcp(url: string, token: string, opts: { headers?: Record<string, string>; protocol?: string } = {}) {
  let id = 0;
  const rpc = async (method: string, params: Record<string, unknown> = {}, extraHeaders: Record<string, string> = {}): Promise<Record<string, unknown>> => {
    id++;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}`, 'mcp-protocol-version': opts.protocol ?? '2025-11-25', ...(method === 'tools/call' ? { 'mcp-method': 'tools/call' } : {}), ...(opts.headers ?? {}), ...extraHeaders },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
    });
    const raw = await res.text();
    if (raw.trimStart().startsWith('{')) return JSON.parse(raw) as Record<string, unknown>;
    for (const line of raw.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const m = JSON.parse(line.slice(5)) as Record<string, unknown>;
      if (m.id === id) return m;
    }
    throw new Error(`no JSON-RPC answer (${res.status}): ${raw.slice(0, 500)}`);
  };
  return {
    rpc,
    initialize: (capabilities: Record<string, unknown> = {}, headers: Record<string, string> = {}) => rpc('initialize', { protocolVersion: opts.protocol ?? '2025-11-25', capabilities, clientInfo: { name: 'golden-agent', version: '1.0.0' } }, headers),
    list: async (headers: Record<string, string> = {}) => ((await rpc('tools/list', {}, headers)).result as { tools: Array<Record<string, unknown>> }).tools,
    call: (name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => rpc('tools/call', { name, arguments: args }, headers),
  };
}
