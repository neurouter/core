import { randomBytes } from 'node:crypto';
import { context, propagation, SpanKind, SpanStatusCode, trace, type Context, type Span } from '@opentelemetry/api';

/**
 * Trace context propagation (backend §10.5). Inbound extract order: `params._meta.traceparent`
 * (+ tracestate), then the HTTP `traceparent` header. The gateway span `tools/call {tool}`
 * (kind SERVER) is the parent of the upstream span (kind CLIENT), whose context is injected into
 * BOTH the upstream HTTP header (undici instrumentation, when the SDK runs) and
 * `params._meta.traceparent` / `tracestate` (explicitly; the spec reserves these keys).
 *
 * Attribute names follow the OTel MCP semantic conventions (semantic-conventions-genai mcp.md):
 * `mcp.method.name`, `gen_ai.tool.name`, `gen_ai.operation.name=execute_tool`,
 * `mcp.protocol.version`, `mcp.session.id`, `network.transport`, `error.type`.
 *
 * When the OTel SDK is disabled the API is a no-op; the gateway still mints its own span id so
 * the upstream sees a gateway hop with the caller's trace id (and audit rows keep trace/span ids).
 */
const TP_RE = /^([\da-f]{2})-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/;

export interface TraceParent {
  version: string;
  traceId: string;
  spanId: string;
  flags: string;
}

export function parseTraceparent(tp: string | null | undefined): TraceParent | null {
  const m = TP_RE.exec(tp?.trim().toLowerCase() ?? '');
  if (!m || m[1] === 'ff' || /^0+$/.test(m[2]!) || /^0+$/.test(m[3]!)) return null;
  return { version: m[1]!, traceId: m[2]!, spanId: m[3]!, flags: m[4]! };
}

export function formatTraceparent(t: Pick<TraceParent, 'traceId' | 'spanId' | 'flags'>): string {
  return `00-${t.traceId}-${t.spanId}-${t.flags}`;
}

const hex = (bytes: number) => {
  let s = '';
  while (!s || /^0+$/.test(s)) s = randomBytes(bytes).toString('hex');
  return s;
};

export interface CallTrace {
  traceId: string;
  /** the gateway span id (stored on the audit row) */
  spanId: string;
  /** W3C traceparent of the gateway span (what the audit row and inner calls inherit) */
  traceparent: string;
  /** true when an OTel SDK records the span (the undici instrumentation then injects the HTTP header) */
  recording: boolean;
  /**
   * Runs `fn` inside a new upstream client span (one per upstream call, so a script's inner calls get
   * one each) and hands it the `traceparent` / `tracestate` keys to forward upstream (HTTP headers
   * when the SDK does not record, `_meta` for MCP upstreams).
   */
  upstream<T>(name: string, fn: (meta: Record<string, string>) => Promise<T>): Promise<T>;
  setAttribute(key: string, value: string | number | boolean): void;
  end(outcome: { error?: string | null }): void;
}

export interface CallTraceInput {
  method: string;
  toolName: string | null;
  metaTraceparent: string | null;
  metaTracestate: string | null;
  httpTraceparent: string | null;
  protocolVersion: string | null;
}

/** Starts the gateway span for one MCP request. */
export function startCallTrace(input: CallTraceInput): CallTrace {
  const fromMeta = parseTraceparent(input.metaTraceparent);
  const carrier: Record<string, string> = {};
  if (fromMeta) {
    carrier.traceparent = input.metaTraceparent!.trim().toLowerCase();
    if (input.metaTracestate) carrier.tracestate = input.metaTracestate;
  } else if (parseTraceparent(input.httpTraceparent)) {
    carrier.traceparent = input.httpTraceparent!.trim().toLowerCase();
  }
  const parentCtx: Context = carrier.traceparent ? propagation.extract(context.active(), carrier) : context.active();
  const tracer = trace.getTracer('neurouter');
  const name = input.toolName ? `${input.method} ${input.toolName}` : input.method;
  const attributes: Record<string, string> = { 'mcp.method.name': input.method, 'network.transport': 'tcp' };
  if (input.toolName) {
    attributes['gen_ai.tool.name'] = input.toolName;
    attributes['gen_ai.operation.name'] = 'execute_tool';
  }
  if (input.protocolVersion) attributes['mcp.protocol.version'] = input.protocolVersion;
  const span: Span = tracer.startSpan(name, { kind: SpanKind.SERVER, attributes }, parentCtx);
  const recording = span.isRecording();
  const parent = parseTraceparent(carrier.traceparent);
  // without a recording SDK span, mint ids ourselves (same trace id as the caller when given)
  const traceId = recording ? span.spanContext().traceId : (parent?.traceId ?? hex(16));
  const spanId = recording ? span.spanContext().spanId : hex(8);
  const flags = recording ? (span.spanContext().traceFlags & 1 ? '01' : '00') : (parent?.flags ?? '01');
  const spanCtx = trace.setSpan(parentCtx, span);

  return {
    traceId,
    spanId,
    traceparent: formatTraceparent({ traceId, spanId, flags }),
    recording,
    async upstream<T>(name: string, fn: (meta: Record<string, string>) => Promise<T>): Promise<T> {
      if (!recording) {
        // no SDK: mint a client span id under the gateway span so the upstream sees the hop
        const meta: Record<string, string> = { traceparent: formatTraceparent({ traceId, spanId: hex(8), flags }) };
        if (carrier.tracestate) meta.tracestate = carrier.tracestate;
        return fn(meta);
      }
      const up = tracer.startSpan(`tools/call ${name}`, { kind: SpanKind.CLIENT, attributes: { 'mcp.method.name': 'tools/call', 'network.transport': 'tcp', 'gen_ai.tool.name': name } }, spanCtx);
      const upCtx = trace.setSpan(spanCtx, up);
      const meta: Record<string, string> = {};
      propagation.inject(upCtx, meta);
      try {
        return await context.with(upCtx, () => fn(meta));
      } catch (err) {
        up.setStatus({ code: SpanStatusCode.ERROR, message: (err as Error).message });
        up.setAttribute('error.type', (err as Error).name || 'Error');
        throw err;
      } finally {
        up.end();
      }
    },
    setAttribute(key, value) {
      span.setAttribute(key, value);
    },
    end(outcome) {
      if (outcome.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: outcome.error });
        span.setAttribute('error.type', outcome.error);
      }
      span.end();
    },
  };
}
