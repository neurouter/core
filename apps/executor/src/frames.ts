import * as z from 'zod';
import { HOST_ERROR_TYPES, PROTOCOL_VERSION } from './types.js';

/**
 * Executor wire protocol (§10.6): 4-byte big-endian length + UTF-8 JSON, max 2 MiB per frame.
 * Every received frame is validated; executor frames are untrusted on the server side.
 */

export const MAX_FRAME_BYTES = 2 * 1024 * 1024;

/**
 * One tool result inside a script may be larger than a frame (0.3.3, M2: full GitHub objects at per_page=100): the
 * server sends it as `call_result_part` frames that the executor joins, up to this hard limit per call. Over it the
 * call fails with `response_too_large` (the script can catch it and ask for less).
 */
export const MAX_CALL_RESULT_BYTES = 16 * 1024 * 1024;
/** Characters of the result's JSON text per part (≤ 6 bytes each once escaped in the frame: under 2 MiB). */
export const CALL_RESULT_PART_CHARS = 256 * 1024;

const RunLimitsSchema = z.object({
  cpuTimeSec: z.number().positive().max(600),
  wallTimeSec: z.number().positive().max(3600),
  maxMemoryMb: z.number().positive().max(4096),
  maxToolCalls: z.number().int().min(0).max(100_000),
  maxConcurrentCalls: z.number().int().min(1).max(64),
  maxResultBytes: z.number().int().min(0).max(MAX_FRAME_BYTES - 64 * 1024),
  maxRecursionDepth: z.number().int().min(10).max(10_000).optional(),
});

const ident = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/);
const RunId = z.string().min(1).max(128);

export const HelloFrame = z.object({ type: z.literal('hello'), protocol: z.literal(PROTOCOL_VERSION), token: z.string().max(1024) });
export const HelloAckFrame = z.object({
  type: z.literal('hello_ack'),
  protocol: z.literal(PROTOCOL_VERSION),
  executorVersion: z.string(),
  montyVersion: z.string(),
  montyBinarySha256: z.string(),
  poolMax: z.number().int(),
  /** Optional protocol features (0.3.3: `call_result_parts`); an older executor sends none. */
  features: z.array(z.string().max(64)).max(32).optional(),
});
export const RunFrame = z.object({
  type: z.literal('run'),
  runId: RunId,
  capability: z.string().min(1).max(256),
  code: z.string().max(256 * 1024),
  lineOffset: z.number().int().min(0).max(1000).optional(),
  colOffset: z.number().int().min(0).max(100).optional(),
  prelude: z.string().max(512 * 1024).optional(),
  typeStubs: z.string().max(1024 * 1024).optional(),
  modules: z.record(ident, z.object({ functions: z.array(ident).max(5000), stubs: z.string().max(4 * 1024 * 1024) })),
  inputs: z.record(z.string(), z.unknown()),
  limits: RunLimitsSchema,
  osPolicy: z.object({ datetime: z.string(), seed: z.union([z.string(), z.number()]) }),
  typeCheck: z.boolean().optional(),
});
export const CallFrame = z.object({
  type: z.literal('call'),
  runId: RunId,
  capability: z.string(),
  callId: z.number().int().nonnegative(),
  fn: z.string().max(200),
  kwargs: z.record(z.string(), z.unknown()),
});
const ToolCallErrorSchema = z.object({ code: z.string().max(200), message: z.string().max(64 * 1024), errorId: z.string().max(200).optional(), pyType: z.enum(HOST_ERROR_TYPES).optional() });
export const CallResultFrame = z.union([
  z.object({ type: z.literal('call_result'), runId: RunId, callId: z.number().int().nonnegative(), ok: z.literal(true), value: z.unknown() }),
  z.object({ type: z.literal('call_result'), runId: RunId, callId: z.number().int().nonnegative(), ok: z.literal(false), error: ToolCallErrorSchema }),
]);
/** A slice of a call result's JSON text (`{"ok":…}`) too large for one frame; `last` completes it. */
export const CallResultPartFrame = z.object({ type: z.literal('call_result_part'), runId: RunId, callId: z.number().int().nonnegative(), seq: z.number().int().nonnegative(), part: z.string().max(CALL_RESULT_PART_CHARS), last: z.boolean() });
export const PrintFrame = z.object({ type: z.literal('print'), runId: RunId, text: z.string().max(64 * 1024) });
export const CancelFrame = z.object({ type: z.literal('cancel'), runId: RunId, reason: z.string().max(500) });
export const DoneFrame = z.object({
  type: z.literal('done'),
  runId: RunId,
  status: z.enum(['ok', 'script_error', 'syntax_error', 'type_error', 'limit_exceeded', 'crashed', 'cancelled']),
  value: z.unknown().optional(),
  valueBytes: z.number().int().nonnegative(),
  truncated: z.boolean().optional(),
  preview: z.string().optional(),
  error: z
    .object({ type: z.string(), message: z.string(), line: z.number().int().optional(), col: z.number().int().optional(), traceback: z.string().optional() })
    .optional(),
  stats: z.object({ wallMs: z.number().nonnegative(), suspensions: z.number().int().nonnegative(), toolCalls: z.number().int().nonnegative() }),
  stdout: z.string(),
});
export const PingFrame = z.object({ type: z.literal('ping'), t: z.number().optional() });
export const PongFrame = z.object({ type: z.literal('pong'), t: z.number().optional() });
export const ErrorFrame = z.object({ type: z.literal('error'), message: z.string().max(4096) });

/** Frames the executor accepts (server → executor). */
export const ToExecutorFrame = z.union([z.discriminatedUnion('type', [HelloFrame, RunFrame, CancelFrame, PingFrame, PongFrame, CallResultPartFrame]), CallResultFrame]);
/** Frames the server accepts (executor → server). */
export const ToServerFrame = z.discriminatedUnion('type', [HelloAckFrame, CallFrame, PrintFrame, DoneFrame, PingFrame, PongFrame, ErrorFrame]);

export type HelloFrame = z.infer<typeof HelloFrame>;
export type HelloAckFrame = z.infer<typeof HelloAckFrame>;
export type RunFrame = z.infer<typeof RunFrame>;
export type CallFrame = z.infer<typeof CallFrame>;
export type CallResultFrame = z.infer<typeof CallResultFrame>;
export type CallResultPartFrame = z.infer<typeof CallResultPartFrame>;

/** Splits a JSON text into part frames (never between the two halves of a surrogate pair). */
export function callResultParts(runId: string, callId: number, json: string, size = CALL_RESULT_PART_CHARS): CallResultPartFrame[] {
  const out: CallResultPartFrame[] = [];
  for (let i = 0, seq = 0; i < json.length; seq++) {
    let end = Math.min(json.length, i + size);
    const c = json.charCodeAt(end - 1);
    if (end < json.length && c >= 0xd800 && c <= 0xdbff) end--;
    out.push({ type: 'call_result_part', runId, callId, seq, part: json.slice(i, end), last: end >= json.length });
    i = end;
  }
  return out;
}
export type DoneFrame = z.infer<typeof DoneFrame>;
export type ToExecutorFrame = z.infer<typeof ToExecutorFrame>;
export type ToServerFrame = z.infer<typeof ToServerFrame>;

export class FrameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameError';
  }
}

/** Encodes one frame. Throws `FrameError` when the payload exceeds the frame limit. */
export function encodeFrame(frame: object, maxBytes = MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(frame), 'utf8');
  if (body.length > maxBytes) throw new FrameError(`frame too large: ${body.length} > ${maxBytes} bytes`);
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32BE(body.length, 0);
  body.copy(out, 4);
  return out;
}

/**
 * Incremental decoder: `push(chunk)` returns the complete raw JSON values received so far.
 * Throws `FrameError` on an oversize length prefix or malformed JSON (the caller must close the connection).
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);
  constructor(private readonly maxBytes = MAX_FRAME_BYTES) {}

  push(chunk: Buffer): unknown[] {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out: unknown[] = [];
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (len > this.maxBytes) throw new FrameError(`frame too large: ${len} > ${this.maxBytes} bytes`);
      if (this.buf.length < 4 + len) break;
      const body = this.buf.subarray(4, 4 + len);
      this.buf = this.buf.subarray(4 + len);
      let value: unknown;
      try {
        value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
      } catch {
        throw new FrameError('malformed frame (invalid UTF-8 or JSON)');
      }
      out.push(value);
    }
    return out;
  }

  get pendingBytes(): number {
    return this.buf.length;
  }
}

/** Validates a decoded frame against `schema`; throws `FrameError` with the first issue. */
export function parseFrame<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(raw);
  if (!r.success) {
    const issue = r.error.issues[0];
    throw new FrameError(`invalid frame: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'unknown'}`);
  }
  return r.data;
}
