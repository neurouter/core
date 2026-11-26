import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { context, propagation, SpanKind, trace } from '@opentelemetry/api';
import { afterEach, describe, expect, it } from 'vitest';
import { parseTraceparent, startCallTrace } from './tracing.js';

const CALLER = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
const input = { method: 'tools/call', toolName: 'list_orders', metaTraceparent: CALLER, metaTracestate: 'vendor=1', httpTraceparent: null, protocolVersion: '2026-07-28' };

describe('MCP call tracing (§10.5)', () => {
  afterEach(() => {
    trace.disable();
    context.disable();
    propagation.disable();
  });

  it('without an SDK: keeps the caller trace id, mints the gateway span id and a client span id per upstream call', async () => {
    const t = startCallTrace(input);
    expect(t.recording).toBe(false);
    expect(t.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(t.traceparent).toBe(`00-${t.traceId}-${t.spanId}-01`);
    const a = await t.upstream('list_orders', async (m) => m);
    const b = await t.upstream('list_orders', async (m) => m);
    expect(parseTraceparent(a.traceparent)!.traceId).toBe(t.traceId);
    expect(a.tracestate).toBe('vendor=1');
    expect(new Set([t.spanId, parseTraceparent(a.traceparent)!.spanId, parseTraceparent(b.traceparent)!.spanId]).size).toBe(3);
    t.end({});
  });

  it('with an SDK: a SERVER span (child of the caller) and one CLIENT span per upstream call with injected context', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
    trace.setGlobalTracerProvider(provider);
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    propagation.setGlobalPropagator(new W3CTraceContextPropagator());
    const t = startCallTrace(input);
    expect(t.recording).toBe(true);
    t.setAttribute('neurouter.script_run_id', 'run_1');
    const seen: string[] = [];
    await t.upstream('list_orders', async (m) => void seen.push(m.traceparent!));
    await expect(t.upstream('get_order', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    t.end({ error: 'tool_error' });
    await provider.forceFlush();
    const spans = exporter.getFinishedSpans();
    const server = spans.find((s) => s.kind === SpanKind.SERVER)!;
    const clients = spans.filter((s) => s.kind === SpanKind.CLIENT);
    expect(server.name).toBe('tools/call list_orders');
    expect(server.spanContext().traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    expect(server.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    expect(server.attributes).toMatchObject({ 'mcp.method.name': 'tools/call', 'gen_ai.tool.name': 'list_orders', 'gen_ai.operation.name': 'execute_tool', 'mcp.protocol.version': '2026-07-28', 'neurouter.script_run_id': 'run_1', 'error.type': 'tool_error' });
    expect(clients.map((s) => s.name)).toEqual(['tools/call list_orders', 'tools/call get_order']);
    expect(clients.every((s) => s.parentSpanContext?.spanId === server.spanContext().spanId)).toBe(true);
    expect(parseTraceparent(seen[0])!.spanId).toBe(clients[0]!.spanContext().spanId);
    expect(clients[1]!.status.code).toBe(2);
    expect(t.spanId).toBe(server.spanContext().spanId);
  });
});

describe('OTel bootstrap', () => {
  it('is off unless OTEL_SDK_DISABLED is false-ish', async () => {
    const { otelEnabled } = await import('./otel.js');
    expect(otelEnabled({})).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: 'true' })).toBe(false);
    expect(otelEnabled({ OTEL_SDK_DISABLED: 'false' })).toBe(true);
    expect(otelEnabled({ OTEL_SDK_DISABLED: 'off' })).toBe(true);
  });
});
