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

  it('clips the largest strings of oversized objects and keeps their structure (never a {$truncated} preview)', () => {
    const issue = { id: 1, number: 7, title: 'Widget fails', body: 'x'.repeat(5000), user: { login: 'octocat', bio: 'y'.repeat(800) }, labels: [{ name: 'bug' }] };
    const r = shapeResponse(issue, { maxBytes: 700 });
    const v = r.value as typeof issue;
    expect(v).not.toHaveProperty('$truncated');
    expect(Object.keys(v)).toEqual(Object.keys(issue));
    expect(v).toMatchObject({ id: 1, number: 7, title: 'Widget fails', user: { login: 'octocat' }, labels: [{ name: 'bug' }] });
    expect(v.body).toBe(`${'x'.repeat(200)}…`);
    expect(r.truncated).toMatchObject({ fields: ['body', 'user.bio'] });
    expect(r.full).toEqual(issue);
    // nested lists are halved when strings are not enough
    const many = shapeResponse({ id: 1, a: [1, 2], events: Array.from({ length: 64 }, (_, i) => ({ i, note: 'n'.repeat(30) })) }, { maxBytes: 500 });
    expect((many.value as { events: unknown[] }).events.length).toBeLessThan(64);
    expect(many.truncated!.fields).toContain('events');
    // an object that is mostly one list stays a list wrapper (cut by items, as before)
    const search = shapeResponse({ total_count: 64, items: Array.from({ length: 64 }, (_, i) => ({ i, note: 'n'.repeat(30) })) }, { maxBytes: 500 });
    expect(search.truncated).toMatchObject({ totalItems: 64 });
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

  it('limits: false (calls inside run_script) returns whole shaped values: no maxBytes, no maxItems', () => {
    const big = { id: 1, body: 'x'.repeat(5000), secret: 's' };
    const r0 = shapeResponse(big, { maxBytes: 256, exclude: ['secret'] }, { limits: false, maxBytes: 300 });
    expect(r0.value).toEqual({ id: 1, body: 'x'.repeat(5000) });
    expect(r0.truncated).toBeUndefined();
    const list = Array.from({ length: 30 }, (_, i) => ({ id: i, body: 'y'.repeat(200) }));
    const r = shapeResponse(list, { maxItems: 10, maxBytes: 300 }, { limits: false, maxBytes: 300 });
    expect((r.value as unknown[]).length).toBe(30);
  });
});

describe('fitJsonChars (H4: script values the field clip leaves over the budget)', () => {
  it('replaces the deepest bulk first, keeps the outer keys, and always fits', async () => {
    const { fitJsonChars } = await import('./shape.js');
    const repo = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`f${i}`, `v${i}`.padEnd(30, 'x')]));
    const v = Object.fromEntries(['npm', 'maven', 'docker', 'nuget', 'container', 'rubygems'].map((k) => [k, [{ id: 1, name: k, repository: repo }]]));
    const r = fitJsonChars(v, 8192);
    expect(JSON.stringify(r.value).length).toBeLessThanOrEqual(8192);
    expect(Object.keys(r.value as object)).toEqual(Object.keys(v));
    expect(r.fields.every((f) => f.endsWith('.repository'))).toBe(true);
    expect((r.value as Record<string, Array<{ name: string }>>).npm[0]!.name).toBe('npm');
    // only tiny keys: the last resort cuts the JSON text
    const flat = Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`k${i}`, i]));
    const t = fitJsonChars(flat, 500);
    expect(typeof t.value).toBe('string');
    expect(JSON.stringify(t.value).length).toBeLessThanOrEqual(500);
    expect(fitJsonChars({ a: 1 }, 500)).toEqual({ value: { a: 1 }, fields: [] });
  });
});
