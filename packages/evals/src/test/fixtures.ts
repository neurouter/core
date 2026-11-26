import type { McpCallResult, McpSession, McpToolInfo } from '../mcp.js';
import type { AttemptRecord, EvalTask, ObservedCall, TaskRunResult } from '../types.js';

export function record(p: Partial<AttemptRecord> = {}): AttemptRecord {
  return {
    finalAnswer: '',
    agentCalls: [],
    toolCallsByAgent: 0,
    scripts: 0,
    turns: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 0,
    servedByModel: 'm',
    fallbackUsed: false,
    stopReason: 'end_turn',
    endReason: 'end_turn',
    error: null,
    transcript: [],
    neurouterTaskId: null,
    calls: [],
    ...p,
  };
}

export function call(tool: string, args: Record<string, unknown> = {}, p: Partial<ObservedCall> = {}): ObservedCall {
  return { tool, arguments: args, status: 'ok', decision: 'allowed', via: 'eval', write: false, ...p };
}

export function task(p: Partial<EvalTask> = {}): EvalTask {
  return { key: 't1', category: 'single', prompt: 'Get pet 1', rubric: '', assertions: [], referenceCalls: [], tags: [], enabled: true, ...p };
}

export function result(p: Partial<TaskRunResult> = {}): TaskRunResult {
  return {
    key: 'k',
    taskKey: 't1',
    category: 'single',
    model: 'm',
    mode: 'tool',
    attempt: 1,
    passed: true,
    framingPassed: true,
    assertionResults: [],
    judge: null,
    failureCause: null,
    primaryTool: null,
    toolCalls: 1,
    scripts: 0,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 50,
    servedByModel: 'm',
    fallbackUsed: false,
    neurouterTaskId: null,
    referenceCallCount: 1,
    endReason: 'end_turn',
    error: null,
    transcript: [],
    calls: [],
    ...p,
  };
}

/** In-memory "petstore" MCP server for runner/stub tests (stateless; records calls). */
export function fakePetstore(opts: { mode?: 'tool' | 'code'; failTool?: string } = {}): McpSession & { calls: Array<{ name: string; args: Record<string, unknown> }> } {
  const pets = [
    { id: 1, name: 'Rex', status: 'available' },
    { id: 2, name: 'Tom', status: 'sold' },
  ];
  const ops: McpToolInfo[] = [
    { name: 'neurouter_begin_task', description: 'Start a task.', inputSchema: { type: 'object', properties: { goal: { type: 'string' } }, required: ['goal'] } },
    { name: 'neurouter_end_task', description: 'End the task.', inputSchema: { type: 'object', properties: { outcome: { type: 'string' } }, required: ['outcome'] } },
    { name: 'neurouter_report_unmet_need', description: 'Report an unmet need.', inputSchema: { type: 'object', properties: { intent: { type: 'string' } }, required: ['intent'] } },
  ];
  const api: McpToolInfo[] = [
    { name: 'list_pets', description: 'List pets in the store.', inputSchema: { type: 'object', properties: { status: { type: 'string' } } } },
    { name: 'get_pet_by_id', description: 'Find a pet by its ID.', inputSchema: { type: 'object', properties: { petId: { type: 'integer' } }, required: ['petId'] } },
    { name: 'add_pet', description: 'Add a new pet to the store.', inputSchema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  ];
  const code: McpToolInfo[] = [
    { name: 'search_tools', description: 'Search tools.', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'run_script', description: 'Run a Python script that calls tools as petstore.fn(...).', inputSchema: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  ];
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ok = (v: unknown, meta = true): McpCallResult => ({ content: [{ type: 'text', text: JSON.stringify(v) }], structuredContent: v, ...(meta ? { _meta: { 'dev.neurouter/task-id': 'task_1' } } : {}) });
  const exec = (name: string, args: Record<string, unknown>): McpCallResult => {
    if (name === opts.failTool) return { content: [{ type: 'text', text: 'boom' }], isError: true };
    switch (name) {
      case 'list_pets':
        return ok({ items: pets.filter((p) => !args.status || p.status === args.status) });
      case 'get_pet_by_id': {
        const p = pets.find((x) => x.id === Number(args.petId));
        return p ? ok(p) : { content: [{ type: 'text', text: 'not found' }], isError: true };
      }
      case 'add_pet':
        return ok({ id: 3, name: args.name });
      default:
        return ok({ recorded: true, task_id: 'task_1' });
    }
  };
  return {
    instructions: 'This MCP server exposes the Petstore API. Use petstore.list_pets(...) in scripts.',
    calls,
    async listTools() {
      return opts.mode === 'code' ? [...ops, ...code] : [...ops, ...api];
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === opts.failTool) return { content: [{ type: 'text', text: 'boom' }], isError: true };
      if (name === 'search_tools') {
        const q = String(args.query).toLowerCase();
        const hits = api.filter((t) => q.split(/\W+/).some((w) => w.length > 2 && (t.name.includes(w.replace(/s$/, '')) || (t.description ?? '').toLowerCase().includes(w))));
        return ok({ tools: hits.map((t) => ({ ...t, pyName: `petstore.${t.name}` })) });
      }
      if (name === 'run_script') {
        const out: Record<string, unknown> = {};
        for (const m of String(args.code).matchAll(/(r\d+) = petstore\.(\w+)\(([^)]*)\)/g)) {
          const a: Record<string, unknown> = {};
          for (const kv of m[3]!.split(',').filter(Boolean)) {
            const [k, v] = kv.split('=').map((s) => s.trim());
            a[k!] = JSON.parse(v!.replace(/^True$/, 'true').replace(/^False$/, 'false'));
          }
          calls.push({ name: m[2]!, args: a });
          out[m[1]!] = exec(m[2]!, a).structuredContent;
        }
        return ok({ status: 'ok', result: out });
      }
      return exec(name, args);
    },
    async close() {},
  };
}
