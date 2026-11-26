import { describe, expect, it } from 'vitest';
import { isVerb, nameFromMethodPath, pyIdent, pyNamespace, snakeCase, toToolName, uniquify } from './naming.js';

describe('naming', () => {
  it('snake_cases operation ids', () => {
    expect(toToolName('findPetsByStatus')).toBe('find_pets_by_status');
    expect(toToolName('issues/list-for-repo')).toBe('issues_list_for_repo');
    expect(toToolName('getHTTPResponse')).toBe('get_http_response');
    expect(toToolName('__weird__name__')).toBe('weird_name');
    expect(toToolName('123start')).toBe('start');
    expect(toToolName('---')).toBe('op');
    expect(toToolName('x'.repeat(100))).toHaveLength(64);
    expect(snakeCase('Already_snake')).toBe('already_snake');
  });

  it('builds method + path names with by_param', () => {
    expect(nameFromMethodPath('get', '/repos/{owner}/{repo}/issues')).toBe('get_repos_by_owner_by_repo_issues');
    expect(nameFromMethodPath('delete', '/items/{itemId}')).toBe('delete_items_by_item_id');
  });

  it('suffixes collisions in document order', () => {
    expect(uniquify(['a', 'b', 'a', 'a'])).toEqual({ names: ['a', 'b', 'a_2', 'a_3'], collided: [2, 3] });
    expect(uniquify(['a', 'a', 'a_2']).names).toEqual(['a', 'a_3', 'a_2']);
  });

  it('escapes Python keywords and namespaces', () => {
    expect(pyIdent('from')).toBe('from_');
    expect(pyIdent('class')).toBe('class_');
    expect(pyIdent('x-rate')).toBe('x_rate');
    expect(pyIdent('1st')).toBe('_1st');
    expect(pyIdent('type')).toBe('type');
    expect(pyNamespace('my-api')).toBe('my_api');
  });

  it('recognises verbs and their forms', () => {
    for (const w of ['list', 'Lists', 'creates', 'updated', 'deleting', 'queries', 'get']) expect(isVerb(w)).toBe(true);
    for (const w of ['issues', 'pet', 'the']) expect(isVerb(w)).toBe(false);
  });
});
