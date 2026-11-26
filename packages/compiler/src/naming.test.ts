import { describe, expect, it } from 'vitest';
import { compileText, spec31 } from './test/fixtures.js';
import { destructiveVerb, isVerb, nameFromMethodPath, pyIdent, pyNamespace, snakeCase, toToolName, uniquify } from './naming.js';

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

describe('destructive classification', () => {
  it('finds effect verbs as whole words in names and summaries', () => {
    expect(destructiveVerb('cancel_order')).toBe('cancel');
    expect(destructiveVerb('refundCharge')).toBe('refund');
    expect(destructiveVerb('pulls/merge')).toBe('merge');
    expect(destructiveVerb('create_order', 'Revokes the token')).toBe('revoke');
    expect(destructiveVerb('get_disclosure', 'List the closest enclosures')).toBeNull();
    expect(destructiveVerb('update_order', 'Update an order')).toBeNull();
  });

  it('marks writes with destructive effects (not only DELETE); overlays override', async () => {
    const spec = spec31({
      '/orders/{id}/cancel': { post: { operationId: 'cancelOrder', summary: 'Cancel an order. Paid orders are refunded.', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
      '/orders': { post: { operationId: 'createOrder', summary: 'Create an order', responses: { '201': { description: 'ok' } } } },
      '/orders/{id}/close-preview': { get: { operationId: 'getClosePreview', summary: 'Preview closing', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }], responses: { '200': { description: 'ok' } } } },
    });
    const r = await compileText(spec);
    const risk = (n: string) => r.tools.find((t) => t.name === n)!.risk;
    expect(risk('cancel_order')).toMatchObject({ write: true, destructive: true });
    expect(risk('create_order')).toMatchObject({ write: true, destructive: false });
    expect(risk('get_close_preview')).toMatchObject({ readOnly: true, destructive: false });
    expect(r.lint.findings.some((f) => f.tool === 'cancel_order' && f.severity === 'info' && /cancels/.test(f.message))).toBe(true);
    const o = await compileText(spec, 'overlay: 1\ntools:\n  "operationId:cancelOrder": { risk: { destructive: false } }\n');
    expect(o.tools.find((t) => t.name === 'cancel_order')!.risk.destructive).toBe(false);
  });
});
