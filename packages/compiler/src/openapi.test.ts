import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HttpBinding } from '@neurouter/shared';
import { compileFile, compileText, GITHUB_FULL, GITHUB_OVERLAY, GITHUB_SUBSET, NOTES_SPEC, PETSTORE, spec31 } from './test/fixtures.js';

describe('OpenAPI pipeline', () => {
  it('compiles the Petstore 3.0 spec to 19 tools', async () => {
    const r = await compileFile(PETSTORE, undefined, 'petstore');
    expect(r.format).toBe('openapi-3.0');
    expect(r.ok).toBe(true);
    expect(r.operationCount).toBe(19);
    expect(r.tools).toHaveLength(19);
    expect(r.title).toBe('Swagger Petstore - OpenAPI 3.0');
    const get = r.tools.find((t) => t.name === 'get_pet_by_id')!;
    expect(get.pyName).toBe('petstore.get_pet_by_id');
    expect(get.risk).toMatchObject({ readOnly: true, write: false, destructive: false });
    expect((get.binding as HttpBinding).params).toEqual([{ arg: 'pet_id', in: 'path', name: 'petId', required: true }]);
    expect(get.key).toBe('operationId:getPetById');
    const del = r.tools.find((t) => t.name === 'delete_pet')!;
    expect(del.risk).toMatchObject({ destructive: true, write: true, idempotent: true });
    expect(r.pythonStubs.petstore).toContain('def get_pet_by_id(*, pet_id: int) -> Pet:');
    expect(r.lint.score).toBeGreaterThan(50);
    expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects Swagger 2.0 with spec_unsupported', async () => {
    const r = await compileText(JSON.stringify({ swagger: '2.0', info: { title: 'x', version: '1' }, paths: {} }));
    expect(r.ok).toBe(false);
    expect(r.tools).toEqual([]);
    expect(r.diagnostics[0]).toMatchObject({ severity: 'error', code: 'spec_unsupported' });
  });

  it('reports garbage as spec_invalid without throwing', async () => {
    const r = await compileText('::: not a spec :::');
    expect(r.ok).toBe(false);
    expect(r.diagnostics.some((d) => d.code === 'spec_invalid')).toBe(true);
  });

  it('handles an OpenAPI 3.1 spec (type arrays, examples)', async () => {
    const r = await compileText(NOTES_SPEC);
    expect(r.format).toBe('openapi-3.1');
    expect(r.tools.map((t) => t.name)).toEqual(['list_notes', 'create_note', 'get_note', 'delete_note', 'update_note']);
    const list = r.tools[0]!;
    expect(list.outputSchema).toMatchObject({ type: 'object', 'x-neurouter-wrapped': 'items', properties: { items: { type: 'array' } } });
    expect((list.binding as HttpBinding).pagination).toEqual({ style: 'page', param: 'page' });
  });

  it('derives names from method + path when operationId is missing', async () => {
    const r = await compileText(spec31({ '/repos/{owner}/issues': { get: { summary: 'List issues', responses: { '200': { description: 'ok' } } } } }));
    expect(r.tools[0]!.name).toBe('get_repos_by_owner_issues');
    expect(r.tools[0]!.key).toBe('GET /repos/{owner}/issues');
  });

  it('cleans descriptions: HTML stripped, fallback to METHOD path with a diagnostic', async () => {
    const r = await compileText(
      spec31({
        '/a': { get: { operationId: 'a', summary: 'Get <b>things</b>', description: 'Line\n\n\n\nmore', responses: { '200': { description: 'ok' } } } },
        '/b': { get: { operationId: 'b', responses: { '200': { description: 'ok' } } } },
      }),
    );
    expect(r.tools[0]!.description).toBe('Get things\n\nLine\n\nmore');
    expect(r.tools[1]!.description).toBe('GET /b');
    expect(r.diagnostics.some((d) => d.code === 'description_missing')).toBe(true);
  });

  it('honours x-neurouter-risk', async () => {
    const r = await compileText(spec31({ '/search': { post: { operationId: 'search', 'x-neurouter-risk': { readOnly: true }, responses: { '200': { description: 'ok' } } } } }));
    expect(r.tools[0]!.risk).toMatchObject({ readOnly: true, write: false });
  });

  it('compiles the GitHub subset (48 ops) and the curated overlay raises the lint score', async () => {
    const raw = await compileFile(GITHUB_SUBSET, undefined, 'github');
    expect(raw.ok).toBe(true);
    expect(raw.tools).toHaveLength(48);
    const curated = await compileFile(GITHUB_SUBSET, fs.readFileSync(GITHUB_OVERLAY, 'utf8'), 'github');
    expect(curated.ok).toBe(true);
    expect(curated.orphanedOverlayKeys).toEqual([]);
    expect(curated.tools.filter((t) => !t.hidden)).toHaveLength(41);
    expect(curated.lint.score).toBeGreaterThan(raw.lint.score + 20);
    expect(curated.profiles.triage).toContain('triage_stale_issues');
  });

  it.skipIf(!fs.existsSync(GITHUB_FULL))('compiles the full GitHub spec in < 20 s with 0 errors', async () => {
    const t0 = Date.now();
    const r = await compileFile(GITHUB_FULL, undefined, 'github');
    const ms = Date.now() - t0;
    expect(ms).toBeLessThan(20_000);
    expect(r.diagnostics.filter((d) => d.severity === 'error')).toEqual([]);
    expect(r.tools.length).toBeGreaterThan(800);
    expect(r.lint.score).toBeGreaterThan(0);
  }, 30_000);
});
