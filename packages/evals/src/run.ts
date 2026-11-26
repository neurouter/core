import { agentSystemPrompt } from './prompts.js';
import { checkAttempt, primaryTool, workCalls } from './check.js';
import { judgeAttempt, needsJudge } from './judge.js';
import { fallbackUsed, LlmKeyError, LlmRateLimitError, type LlmClient, type LlmMessageParam, type LlmRequest, type LlmResponse, type LlmToolResultBlock, type LlmToolUseBlock } from './llm/types.js';
import { resultText, taskIdFromResult, type McpSession } from './mcp.js';
import type { StateReader } from './check.js';
import type { AgentCall, AttemptRecord, AttemptRun, EndReason, EvalMode, EvalTask, ObservedCall, TaskRunResult, TranscriptItem } from './types.js';

export interface RunSettings {
  effort: 'low' | 'medium' | 'high';
  /** Server-side refusal fallbacks (`fallbacks: "default"` on the beta endpoint). */
  fallbacks: boolean;
  maxTokens?: number;
  cache?: boolean;
  /**
   * Max characters kept per transcript item (user/assistant text, tool result, error). `null` keeps
   * everything (`eval --transcripts`); default `TRANSCRIPT_ITEM_MAX` (what the console stores).
   */
  transcriptMaxChars?: number | null;
}

export interface RunLimits {
  maxTurns: number;
  maxToolCalls: number;
  maxTotalTokens: number;
  wallMs: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxTurns: 25, maxToolCalls: 60, maxTotalTokens: 200_000, wallMs: 5 * 60_000 };
export const DEFAULT_SETTINGS: RunSettings = { effort: 'medium', fallbacks: true };
export const TRANSCRIPT_ITEM_MAX = 4096;

export interface RunAttemptOptions {
  llm: LlmClient;
  mcp: McpSession;
  prompt: string;
  model: string;
  mode: EvalMode;
  settings?: Partial<RunSettings>;
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
  /** Injectable for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const isOps = (n: string) => n.startsWith('neurouter_');

/** Trims a transcript text to `max` characters (`null`: untrimmed). */
export function cutTranscript(s: string, max: number | null = TRANSCRIPT_ITEM_MAX): string {
  return max !== null && s.length > max ? `${s.slice(0, max)}… [${s.length - max} more characters trimmed]` : s;
}

/** The agent loop (§15.4 step 3): MCP tools 1:1 as LLM tools (each provider adapter maps them), tool_choice auto, parallel tool_use blocks. */
export async function runAttempt(opts: RunAttemptOptions): Promise<AttemptRun> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  const settings = { ...DEFAULT_SETTINGS, ...(opts.settings ?? {}) };
  const limits = { ...DEFAULT_LIMITS, ...(opts.limits ?? {}) };
  const started = now();
  const maxChars = settings.transcriptMaxChars === undefined ? TRANSCRIPT_ITEM_MAX : settings.transcriptMaxChars;
  const cut = (s: string) => cutTranscript(s, maxChars);
  const transcript: TranscriptItem[] = [{ kind: 'user', text: cut(opts.prompt) }];
  const agentCalls: AgentCall[] = [];
  const out: AttemptRun = {
    finalAnswer: '',
    agentCalls,
    toolCallsByAgent: 0,
    scripts: 0,
    turns: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    latencyMs: 0,
    servedByModel: null,
    fallbackUsed: false,
    stopReason: null,
    endReason: 'end_turn',
    error: null,
    transcript,
    neurouterTaskId: null,
  };
  const finish = (reason: EndReason, error: string | null = null): AttemptRun => {
    out.endReason = reason;
    out.error = error;
    out.latencyMs = now() - started;
    if (error) transcript.push({ kind: 'error', text: cut(error) });
    return out;
  };

  const tools = (await opts.mcp.listTools()).map((t) => ({ name: t.name, ...(t.description ? { description: t.description } : {}), input_schema: t.inputSchema }));
  const messages: LlmMessageParam[] = [{ role: 'user', content: opts.prompt }];
  const system = agentSystemPrompt(opts.mcp.instructions);
  let totalCalls = 0;

  for (;;) {
    if (opts.signal?.aborted) return finish('cancelled', 'cancelled');
    if (out.turns >= limits.maxTurns) return finish('max_turns');
    if (now() - started > limits.wallMs) return finish('timeout');
    if (out.inputTokens + out.outputTokens > limits.maxTotalTokens) return finish('over_budget');
    const req: LlmRequest = {
      model: opts.model,
      max_tokens: settings.maxTokens ?? 16000,
      system,
      messages,
      tools,
      tool_choice: { type: 'auto' },
      output_config: { effort: settings.effort },
      ...(settings.cache !== false ? { cache_control: { type: 'ephemeral' as const } } : {}),
      ...(settings.fallbacks ? { fallbacks: 'default' as const } : {}),
    };
    let res: LlmResponse;
    try {
      res = await createWithRetry(opts.llm, req, { sleep, random, ...(opts.signal ? { signal: opts.signal } : {}) });
    } catch (err) {
      if (err instanceof LlmKeyError) throw err;
      if (opts.signal?.aborted) return finish('cancelled', 'cancelled');
      return finish('error', (err as Error).message);
    }
    out.turns++;
    // Anthropic's input_tokens excludes cache writes as well as reads; cache writes are billed input
    out.inputTokens += (res.usage.input_tokens ?? 0) + (res.usage.cache_creation_input_tokens ?? 0);
    out.outputTokens += res.usage.output_tokens ?? 0;
    out.cacheReadTokens += res.usage.cache_read_input_tokens ?? 0;
    out.cacheWriteTokens += res.usage.cache_creation_input_tokens ?? 0;
    out.servedByModel = res.model;
    if (fallbackUsed(res)) {
      out.fallbackUsed = true;
      const fb = (res.usage.iterations ?? []).filter((i) => i.type === 'fallback_message').pop();
      if (fb?.model) out.servedByModel = fb.model;
    }
    out.stopReason = res.stop_reason;
    const text = res.content
      .filter((b) => b.type === 'text')
      .map((b) => String((b as { text: string }).text))
      .join('');
    if (text) transcript.push({ kind: 'assistant', text: cut(text) });
    if (res.stop_reason === 'refusal') return finish('refusal', 'model refused');
    const uses = res.content.filter((b): b is LlmToolUseBlock => b.type === 'tool_use');
    messages.push({ role: 'assistant', content: res.content as LlmMessageParam['content'] });
    if (!uses.length) {
      out.finalAnswer = text;
      if (res.stop_reason === 'max_tokens') return finish('max_tokens');
      return finish('end_turn');
    }
    if (totalCalls + uses.length > limits.maxToolCalls) {
      out.finalAnswer = text;
      return finish('max_tool_calls');
    }
    totalCalls += uses.length;
    const results: LlmToolResultBlock[] = await Promise.all(
      uses.map(async (u) => {
        const args = (u.input && typeof u.input === 'object' ? u.input : {}) as Record<string, unknown>;
        transcript.push({ kind: 'tool_call', id: u.id, name: u.name, arguments: args });
        const t0 = now();
        let isError: boolean;
        let content: string;
        try {
          const r = await opts.mcp.callTool(u.name, args, opts.signal);
          isError = !!r.isError;
          content = resultText(r);
          out.neurouterTaskId ??= taskIdFromResult(r);
        } catch (err) {
          isError = true;
          content = `MCP error: ${(err as Error).message}`;
        }
        agentCalls.push({ name: u.name, arguments: args, isError, latencyMs: now() - t0 });
        if (!isOps(u.name)) out.toolCallsByAgent++;
        if (u.name === 'run_script') out.scripts++;
        transcript.push({ kind: 'tool_result', id: u.id, name: u.name, isError, text: cut(content) });
        return { type: 'tool_result' as const, tool_use_id: u.id, content: content || '(empty result)', ...(isError ? { is_error: true } : {}) };
      }),
    );
    messages.push({ role: 'user', content: results });
  }
}

/** RateLimitError → backoff and retry 3× with jitter (on top of the SDK's own retries). */
export async function createWithRetry(llm: LlmClient, req: LlmRequest, o: { sleep: (ms: number) => Promise<void>; random: () => number; signal?: AbortSignal; retries?: number }): Promise<LlmResponse> {
  const retries = o.retries ?? 3;
  for (let i = 0; ; i++) {
    try {
      return await llm.create(req, o.signal ? { signal: o.signal } : {});
    } catch (err) {
      if (!(err instanceof LlmRateLimitError) || i >= retries) throw err;
      const base = err.retryAfterMs ?? 1000 * 2 ** i;
      await o.sleep(base + Math.floor(o.random() * 500));
    }
  }
}

/** When the server cannot supply audit calls: the agent's own MCP calls (call_tool unwrapped). Inner script calls are invisible here. */
export function callsFromAgent(calls: AgentCall[]): ObservedCall[] {
  return calls.map((c) => {
    if (c.name === 'call_tool' && typeof c.arguments.name === 'string') {
      return { tool: c.arguments.name, arguments: (c.arguments.arguments as Record<string, unknown>) ?? {}, status: c.isError ? 'tool_error' : 'ok', decision: 'allowed', via: 'call_tool', write: false };
    }
    return { tool: c.name, arguments: c.arguments, status: c.isError ? 'tool_error' : 'ok', decision: 'allowed', via: 'direct', write: false };
  });
}

/* ------------------------------------------------------------------ suite orchestration */

export interface AttemptContext {
  task: EvalTask;
  model: string;
  mode: EvalMode;
  attempt: number;
  /** `${taskKey}|${model}|${mode}|${attempt}` — the resumability key. */
  key: string;
}

/** A per-attempt MCP session (fresh mock namespace `eval:<runId>:<taskRunId>`, exposure for the mode). */
export interface AttemptSession {
  mcp: McpSession;
  /** Audit-log calls of the attempt's Neurouter task (incl. inner script calls). Defaults to the agent's calls. */
  collectCalls?: (run: AttemptRun) => Promise<ObservedCall[]>;
  stateReader?: StateReader;
  close?: () => Promise<void>;
}

export interface RunSuiteOptions {
  llm: LlmClient;
  tasks: EvalTask[];
  models: string[];
  modes: EvalMode[];
  repeats: number;
  openSession: (ctx: AttemptContext) => Promise<AttemptSession>;
  judgeModel?: string;
  judgeLlm?: LlmClient;
  settings?: Partial<RunSettings>;
  limits?: Partial<RunLimits>;
  concurrency?: number;
  signal?: AbortSignal;
  /** Skip attempts already stored (resume). */
  hasResult?: (key: string) => boolean | Promise<boolean>;
  onResult?: (r: TaskRunResult) => void | Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

export function attemptKey(taskKey: string, model: string, mode: EvalMode, attempt: number): string {
  return `${taskKey}|${model}|${mode}|${attempt}`;
}

/** Runs task × model × mode × attempt with bounded concurrency (default 4). Returns the new results. */
export async function runSuite(opts: RunSuiteOptions): Promise<TaskRunResult[]> {
  const jobs: AttemptContext[] = [];
  for (const task of opts.tasks.filter((t) => t.enabled !== false))
    for (const model of opts.models) for (const mode of opts.modes) for (let attempt = 1; attempt <= opts.repeats; attempt++) jobs.push({ task, model, mode, attempt, key: attemptKey(task.key, model, mode, attempt) });
  const total = jobs.length;
  let done = 0;
  const results: TaskRunResult[] = [];
  let fatal: unknown = null;
  let next = 0;
  const worker = async () => {
    for (;;) {
      if (fatal || opts.signal?.aborted) return;
      const job = jobs[next++];
      if (!job) return;
      if (opts.hasResult && (await opts.hasResult(job.key))) {
        opts.onProgress?.(++done, total);
        continue;
      }
      try {
        const r = await runOne(opts, job);
        results.push(r);
        await opts.onResult?.(r);
      } catch (err) {
        if (err instanceof LlmKeyError) {
          fatal = err;
          return;
        }
        throw err;
      }
      opts.onProgress?.(++done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 4, total || 1)) }, worker));
  if (fatal) throw fatal;
  return results;
}

async function runOne(opts: RunSuiteOptions, job: AttemptContext): Promise<TaskRunResult> {
  const session = await opts.openSession(job);
  try {
    const run = await runAttempt({
      llm: opts.llm,
      mcp: session.mcp,
      prompt: job.task.prompt,
      model: job.model,
      mode: job.mode,
      ...(opts.settings ? { settings: opts.settings } : {}),
      ...(opts.limits ? { limits: opts.limits } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    const calls = session.collectCalls ? await session.collectCalls(run) : callsFromAgent(run.agentCalls);
    const record: AttemptRecord = { ...run, calls };
    let judge = null;
    if (needsJudge(job.task) && run.endReason !== 'error' && run.endReason !== 'refusal') {
      try {
        judge = await judgeAttempt({ llm: opts.judgeLlm ?? opts.llm, model: opts.judgeModel ?? job.model, task: job.task, record, ...(opts.signal ? { signal: opts.signal } : {}) });
      } catch (err) {
        if (err instanceof LlmKeyError) throw err;
        judge = { score: 0, verdict: 'fail' as const, reasons: [`judge failed: ${(err as Error).message}`] };
      }
    }
    const check = await checkAttempt(job.task, record, { ...(session.stateReader ? { stateReader: session.stateReader } : {}), judge });
    return {
      key: job.key,
      taskKey: job.task.key,
      category: job.task.category,
      model: job.model,
      mode: job.mode,
      attempt: job.attempt,
      passed: check.passed,
      framingPassed: check.framingPassed,
      assertionResults: check.results,
      judge: check.judge,
      failureCause: check.failureCause,
      primaryTool: check.passed ? null : primaryTool(job.task, record, check),
      // efficiency counts work calls: discovery (search_tools) is excluded, as for max_calls
      toolCalls: workCalls(run),
      scripts: run.scripts,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cacheReadTokens: run.cacheReadTokens,
      cacheWriteTokens: run.cacheWriteTokens,
      latencyMs: run.latencyMs,
      servedByModel: run.servedByModel,
      fallbackUsed: run.fallbackUsed,
      neurouterTaskId: run.neurouterTaskId,
      referenceCallCount: job.task.referenceCalls.length,
      endReason: run.endReason,
      error: run.error,
      transcript: run.transcript,
      calls,
    };
  } finally {
    await session.close?.().catch(() => {});
  }
}
