import { describe, expect, it } from 'vitest';
import { encodeFrame, FrameDecoder, FrameError, MAX_FRAME_BYTES, parseFrame, ToExecutorFrame, ToServerFrame } from './frames.js';

describe('frame codec', () => {
  it('round-trips frames split across arbitrary chunks', () => {
    const frames = [{ type: 'ping', t: 1 }, { type: 'cancel', runId: 'r1', reason: 'user' }, { type: 'pong' }];
    const bytes = Buffer.concat(frames.map((f) => encodeFrame(f)));
    const dec = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < bytes.length; i += 3) out.push(...dec.push(bytes.subarray(i, i + 3)));
    expect(out).toEqual(frames);
    expect(dec.pendingBytes).toBe(0);
  });

  it('uses a 4-byte big-endian length prefix', () => {
    const buf = encodeFrame({ type: 'ping' });
    expect(buf.readUInt32BE(0)).toBe(buf.length - 4);
    expect(JSON.parse(buf.subarray(4).toString('utf8'))).toEqual({ type: 'ping' });
  });

  it('refuses to encode frames over 2 MiB', () => {
    expect(() => encodeFrame({ type: 'print', runId: 'r', text: 'x'.repeat(MAX_FRAME_BYTES) })).toThrow(FrameError);
  });

  it('rejects an oversize length prefix before buffering the body', () => {
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => new FrameDecoder().push(header)).toThrow(/too large/);
  });

  it('rejects malformed JSON and invalid UTF-8', () => {
    const bad = Buffer.from('{not json');
    const h = Buffer.alloc(4);
    h.writeUInt32BE(bad.length, 0);
    expect(() => new FrameDecoder().push(Buffer.concat([h, bad]))).toThrow(/malformed/);
    const invalid = Buffer.from([0xff, 0xfe]);
    h.writeUInt32BE(invalid.length, 0);
    expect(() => new FrameDecoder().push(Buffer.concat([h, invalid]))).toThrow(/malformed/);
  });

  it('validates frames against the schema (untrusted executor frames)', () => {
    expect(() => parseFrame(ToServerFrame, { type: 'call', runId: 'r', callId: -1, fn: 'x.y', kwargs: {}, capability: 'c' })).toThrow(/invalid frame/);
    expect(() => parseFrame(ToServerFrame, { type: 'run' })).toThrow(FrameError);
    expect(() => parseFrame(ToServerFrame, { type: 'done', runId: 'r', status: 'pwned', valueBytes: 0, stats: { wallMs: 1, suspensions: 0, toolCalls: 0 }, stdout: '' })).toThrow();
    const ok = parseFrame(ToServerFrame, { type: 'call', runId: 'r', callId: 1, fn: 'github.list_issues', kwargs: { owner: 'a' }, capability: 'rc_x' });
    expect(ok.type).toBe('call');
  });

  it('rejects run frames with invalid namespaces or limits', () => {
    const base = {
      type: 'run',
      runId: 'r1',
      capability: 'rc_x',
      code: 'x',
      modules: { github: { functions: ['list_issues'], stubs: '' } },
      inputs: {},
      limits: { cpuTimeSec: 10, wallTimeSec: 30, maxMemoryMb: 64, maxToolCalls: 200, maxConcurrentCalls: 8, maxResultBytes: 1024 },
      osPolicy: { datetime: '2026-01-01T00:00:00Z', seed: 1 },
    };
    expect(parseFrame(ToExecutorFrame, base).type).toBe('run');
    expect(() => parseFrame(ToExecutorFrame, { ...base, modules: { 'bad-ns': { functions: [], stubs: '' } } })).toThrow();
    expect(() => parseFrame(ToExecutorFrame, { ...base, modules: { github: { functions: ['__import__('], stubs: '' } } })).toThrow();
    expect(() => parseFrame(ToExecutorFrame, { ...base, limits: { ...base.limits, maxMemoryMb: -1 } })).toThrow();
  });
});
