import { describe, expect, it } from 'vitest';
import { buildHash } from './compile.js';
import { diffSpecs } from './diff.js';
import { compileText, NOTES_SPEC } from './test/fixtures.js';
import { COMPILER_VERSION } from './version.js';
import { sha256Hex } from './util.js';

describe('build hash and def hash', () => {
  it('is stable for the same inputs and changes with the overlay', async () => {
    const a = await compileText(NOTES_SPEC);
    const b = await compileText(NOTES_SPEC);
    expect(a.hash).toBe(b.hash);
    expect(a.hash).toBe(buildHash(sha256Hex(NOTES_SPEC), ''));
    expect(a.tools.map((t) => t.defHash)).toEqual(b.tools.map((t) => t.defHash));
    const c = await compileText(NOTES_SPEC, 'overlay: 1\ntools:\n  "operationId:getNote": { description: Get one note by id from the project. }\n');
    expect(c.hash).not.toBe(a.hash);
    expect(c.overlayHash).toMatch(/^[0-9a-f]{64}$/);
    const get = (r: typeof a) => r.tools.find((t) => t.key === 'operationId:getNote')!.defHash;
    expect(get(c)).not.toBe(get(a));
    expect(c.tools.find((t) => t.key === 'operationId:listNotes')!.defHash).toBe(a.tools.find((t) => t.key === 'operationId:listNotes')!.defHash);
    expect(COMPILER_VERSION).toBe('0.1.0');
  });
});

describe('diffSpecs', () => {
  it('reports added, removed and changed operations and orphaned overlay keys', async () => {
    const prev = await compileText(NOTES_SPEC);
    const doc = JSON.parse(NOTES_SPEC);
    delete doc.paths['/projects/{project}/notes/{note_id}'].delete;
    doc.paths['/projects/{project}/notes/{note_id}'].get.summary = 'Fetch a note';
    doc.paths['/health'] = { get: { operationId: 'health', responses: { '200': { description: 'ok' } } } };
    const next = await compileText(JSON.stringify(doc));
    const d = diffSpecs(prev.tools, next.tools, ['operationId:deleteNote', 'operationId:getNote', 'tag:notes', '*']);
    expect(d.added.map((x) => x.key)).toEqual(['operationId:health']);
    expect(d.removed).toEqual([{ key: 'operationId:deleteNote', method: 'DELETE', path: '/projects/{project}/notes/{note_id}', operationId: 'deleteNote', toolName: 'delete_note' }]);
    expect(d.changed).toEqual([{ op: expect.objectContaining({ key: 'operationId:getNote' }), fields: ['description', 'title'] }]);
    expect(d.orphanedOverlayKeys).toEqual(['operationId:deleteNote']);
    expect(diffSpecs(prev.tools, prev.tools)).toEqual({ added: [], removed: [], changed: [], orphanedOverlayKeys: [] });
  });
});
