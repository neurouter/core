import { describe, expect, it } from 'vitest';
import { REDACTED_VALUE, shapeOutputSchema, shapeResponse, wrapStructured } from './shape.js';

const list = (n: number) => Array.from({ length: n }, (_, i) => ({ number: i + 1, title: `Issue ${i + 1}`, user: { login: `u${i}`, id: i }, reactions: { total: 1 }, token: 'secret' }));

describe('shapeResponse', () => {
  it('include → flatten → maxItems → redact, with truncation info and the full value', () => {
    const r = shapeResponse(list(100), { include: ['[].number', '[].title', '[].user.login', '[].token'], flatten: { '[].user.login': 'author' }, maxItems: 50, redact: ['[].token'] });
    const v = r.value as Array<Record<string, unknown>>;
    expect(v).toHaveLength(50);
    expect(v[0]).toEqual({ number: 1, title: 'Issue 1', token: REDACTED_VALUE, author: 'u0' });
    expect((r.full as unknown[]).length).toBe(100);
    expect(r.truncated).toMatchObject({ totalItems: 100, returnedItems: 50 });
    expect(r.truncated!.totalBytes).toBeGreaterThan(r.truncated!.returnedBytes);
  });

  it('exclude removes paths', () => {
    const r = shapeResponse(list(2), { exclude: ['[].reactions', '[].user.id'] });
    expect(r.value).toEqual([
      { number: 1, title: 'Issue 1', user: { login: 'u0' }, token: 'secret' },
      { number: 2, title: 'Issue 2', user: { login: 'u1' }, token: 'secret' },
    ]);
    expect(r.truncated).toBeUndefined();
  });

  it('maxBytes cuts lists to the largest prefix that fits', () => {
    const r = shapeResponse(list(100), { maxBytes: 2000 });
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(2000);
    expect((r.value as unknown[]).length).toBeGreaterThan(5);
    expect(r.truncated?.totalItems).toBe(100);
  });

  it('cuts the single array property of an object (search results)', () => {
    const r = shapeResponse({ total_count: 100, items: list(100) }, { maxItems: 10 });
    expect((r.value as { items: unknown[]; total_count: number }).items).toHaveLength(10);
    expect((r.value as { total_count: number }).total_count).toBe(100);
  });

  it('falls back to a preview for oversized non-list values', () => {
    const r = shapeResponse({ blob: 'x'.repeat(5000) }, { maxBytes: 300 });
    expect(r.value).toMatchObject({ $truncated: true });
    expect(r.truncated).toBeDefined();
  });

  it('applies a default byte cap from options and never mutates input', () => {
    const input = list(3);
    const copy = JSON.parse(JSON.stringify(input));
    shapeResponse(input, { include: ['[].number'] }, { maxBytes: 10_000 });
    expect(input).toEqual(copy);
  });

  it('wraps structured content', () => {
    expect(wrapStructured([1])).toEqual({ items: [1] });
    expect(wrapStructured({ a: 1 })).toEqual({ a: 1 });
    expect(wrapStructured('x')).toEqual({ data: 'x' });
  });

  it('shapes the output schema the same way', () => {
    const schema = {
      type: 'object',
      'x-neurouter-wrapped': 'items',
      properties: { items: { type: 'array', items: { type: 'object', properties: { number: { type: 'integer' }, title: { type: 'string' }, user: { type: 'object', properties: { login: { type: 'string' }, id: { type: 'integer' } } } } } } },
    };
    const out = shapeOutputSchema(schema, { include: ['[].number', '[].user.login'], flatten: { '[].user.login': 'author' } })!;
    expect((out.properties as any).items.items.properties).toEqual({ number: { type: 'integer' }, author: { type: 'string' } });
  });
});
