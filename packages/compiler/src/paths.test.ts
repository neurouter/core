import { describe, expect, it } from 'vitest';
import { deleteAt, flattenAt, formatPath, getAll, includePaths, parsePath, PathSyntaxError, replaceAt } from './overlay/paths.js';

describe('JSONPath subset', () => {
  it('parses the supported forms', () => {
    expect(parsePath('a.b')).toEqual([{ kind: 'key', key: 'a' }, { kind: 'key', key: 'b' }]);
    expect(parsePath('[].x')).toEqual([{ kind: 'each' }, { kind: 'key', key: 'x' }]);
    expect(parsePath('a[].b[].c')).toEqual([{ kind: 'key', key: 'a' }, { kind: 'each' }, { kind: 'key', key: 'b' }, { kind: 'each' }, { kind: 'key', key: 'c' }]);
    expect(formatPath(parsePath('a[].b[].c'))).toBe('a[].b[].c');
    for (const bad of ['', 'a..b', '.a', 'a.', 'a[0]', 'a[]b']) expect(() => parsePath(bad), bad).toThrow(PathSyntaxError);
  });

  const data = () => ({ items: [{ id: 1, user: { login: 'a', id: 9 }, labels: [{ name: 'x', c: 1 }] }, { id: 2, user: { login: 'b' }, labels: [] }], total: 2 });

  it('gets, deletes and replaces values', () => {
    expect(getAll(data(), parsePath('items[].user.login'))).toEqual(['a', 'b']);
    expect(getAll(data(), parsePath('items[].labels[].name'))).toEqual(['x']);
    const d = data();
    deleteAt(d, parsePath('items[].user'));
    expect(d.items.every((i) => !('user' in i))).toBe(true);
    const e = data();
    replaceAt(e, parsePath('items[].user.login'), '***');
    expect(e.items.map((i) => i.user.login)).toEqual(['***', '***']);
    const arr = [1, 2, 3];
    deleteAt(arr, parsePath('[]'));
    expect(arr).toEqual([]);
  });

  it('projects includes (root arrays, nested arrays, missing keys)', () => {
    expect(includePaths(data(), ['items[].id', 'items[].labels[].name'])).toEqual({ items: [{ id: 1, labels: [{ name: 'x' }] }, { id: 2, labels: [] }] });
    expect(includePaths([{ a: 1, b: 2 }], ['[].a'])).toEqual([{ a: 1 }]);
    expect(includePaths({ a: 1 }, ['nope'])).toEqual({});
  });

  it('flattens and prunes empty parents', () => {
    const v = [{ id: 1, user: { login: 'a' } }];
    flattenAt(v, '[].user.login', 'author');
    expect(v).toEqual([{ id: 1, author: 'a' }]);
    const o = { owner: { login: 'z', id: 1 } };
    flattenAt(o, 'owner.login', 'owner_login');
    expect(o).toEqual({ owner: { id: 1 }, owner_login: 'z' });
  });
});
