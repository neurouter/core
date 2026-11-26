import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LlmError, type LlmClient, type LlmRequest, type LlmResponse } from './types.js';

/** Stable hash of the parts of a request that determine the answer (model, system, messages, tool names). */
export function promptHash(req: LlmRequest): string {
  const key = JSON.stringify({ model: req.model, system: req.system ?? null, messages: req.messages, tools: (req.tools ?? []).map((t) => t.name), format: req.output_config?.format ?? null });
  return createHash('sha256').update(key).digest('hex');
}

/**
 * Test-only fixture replay (backend §19.1): answers are `<dir>/<promptHash>.json` files holding an
 * `LlmResponse`. Enabled with `NEUROUTER_EVAL_FAKE_LLM=<dir>`; refused unless `NODE_ENV=test`.
 * With `record` set, a miss is answered by the fallback client and written to the fixture dir.
 */
export class FakeLlmClient implements LlmClient {
  readonly provider = 'fake' as const;
  constructor(
    private readonly dir: string,
    private readonly opts: { env?: string | undefined; record?: LlmClient } = {},
  ) {
    const env = opts.env ?? process.env.NODE_ENV;
    if (env !== 'test') throw new LlmError('NEUROUTER_EVAL_FAKE_LLM is only allowed when NODE_ENV=test');
  }

  async create(req: LlmRequest): Promise<LlmResponse> {
    const file = path.join(this.dir, `${promptHash(req)}.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as LlmResponse;
    if (this.opts.record) {
      const res = await this.opts.record.create(req);
      fs.mkdirSync(this.dir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(res, null, 2));
      return res;
    }
    throw new LlmError(`fake LLM: no fixture ${path.basename(file)}`);
  }
}

/** In-memory scripted client for unit tests: a queue of responses or a responder function. */
export class ScriptedLlmClient implements LlmClient {
  readonly provider = 'scripted' as const;
  readonly requests: LlmRequest[] = [];
  private readonly queue: Array<LlmResponse | Error | ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>)>;
  constructor(
    responses: Array<LlmResponse | Error | ((req: LlmRequest) => LlmResponse | Promise<LlmResponse>)> = [],
    private readonly fallback?: (req: LlmRequest, index: number) => LlmResponse | Promise<LlmResponse>,
  ) {
    this.queue = [...responses];
  }
  async create(req: LlmRequest): Promise<LlmResponse> {
    this.requests.push(structuredClone(req));
    const next = this.queue.shift();
    if (next === undefined) {
      if (this.fallback) return this.fallback(req, this.requests.length - 1);
      throw new LlmError('scripted LLM: no more responses');
    }
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next(req) : next;
  }
}

let counter = 0;
/** Builds an `LlmResponse` (tests and the stub). */
export function llmResponse(content: LlmResponse['content'], opts: { model?: string; stop?: string; input?: number; output?: number; iterations?: LlmResponse['usage']['iterations'] } = {}): LlmResponse {
  const stop = opts.stop ?? (content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn');
  return {
    id: `msg_${(++counter).toString(36)}`,
    model: opts.model ?? 'claude-sonnet-5-5',
    role: 'assistant',
    content,
    stop_reason: stop,
    usage: { input_tokens: opts.input ?? 100, output_tokens: opts.output ?? 20, cache_read_input_tokens: 0, ...(opts.iterations ? { iterations: opts.iterations } : {}) },
  };
}
