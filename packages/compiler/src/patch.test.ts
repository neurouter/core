import { describe, expect, it } from 'vitest';
import { applyOverlayPatch, diffOverlays, OverlayPatchError } from './overlay/patch.js';
import { parseOverlay } from './overlay/parse.js';

const BASE = `# Curated notes overlay
overlay: 1
tools:
  # the main list tool
  "operationId:listNotes":
    name: list_notes # keep short
    hidden: false
`;

describe('applyOverlayPatch', () => {
  it('preserves comments while setting and unsetting fields', () => {
    const r = applyOverlayPatch(BASE, [
      { op: 'set', selector: 'operationId:listNotes', field: 'description', value: 'List notes.' },
      { op: 'set', selector: 'operationId:getNote', field: 'hidden', value: true },
      { op: 'unset', selector: 'operationId:listNotes', field: 'hidden' },
    ]);
    expect(r.yaml).toContain('# Curated notes overlay');
    expect(r.yaml).toContain('# the main list tool');
    expect(r.yaml).toContain('name: list_notes # keep short');
    expect(r.yaml).toContain('description: List notes.');
    expect(r.yaml).not.toMatch(/listNotes[\s\S]*hidden: false/);
    expect(r.changes.map((c) => [c.target, c.field, c.change])).toEqual([
      ['operationId:listNotes', 'description', 'added'],
      ['operationId:getNote', 'hidden', 'added'],
      ['operationId:listNotes', 'hidden', 'removed'],
    ]);
    expect(parseOverlay(r.yaml).overlay).not.toBeNull();
  });

  it('handles defaults, composites and profiles, starting from empty text', () => {
    const r = applyOverlayPatch('', [
      { op: 'set_default', field: 'hidden', value: true },
      { op: 'set_composite', name: 'do_it', value: { description: 'Do it.', script: 'return 1', inputSchema: { type: 'object' }, write: false } },
      { op: 'set_profile', name: 'ops', tools: ['a', 'b'] },
    ]);
    const parsed = parseOverlay(r.yaml).overlay!;
    expect(parsed.defaults).toEqual({ hidden: true });
    expect(parsed.composites?.do_it?.script).toBe('return 1');
    expect(parsed.profiles).toEqual({ ops: { tools: ['a', 'b'] } });
    const removed = applyOverlayPatch(r.yaml, [{ op: 'remove_composite', name: 'do_it' }, { op: 'unset', selector: 'x', field: 'name' }]);
    expect(parseOverlay(removed.yaml).overlay!.composites).toBeUndefined();
    expect(removed.changes).toHaveLength(1);
  });

  it('removes a tool entry that becomes empty', () => {
    const r = applyOverlayPatch('overlay: 1\ntools:\n  "*": { hidden: true }\n', [{ op: 'unset', selector: '*', field: 'hidden' }]);
    expect(r.yaml.trim()).toBe('overlay: 1');
  });

  it('rejects invalid ops and invalid YAML', () => {
    expect(() => applyOverlayPatch(BASE, [{ op: 'set', selector: 'x', field: 'nope', value: 1 }])).toThrow();
    expect(() => applyOverlayPatch('a: [', [])).toThrow(OverlayPatchError);
  });
});

describe('diffOverlays', () => {
  it('lists field-level changes', () => {
    const next = applyOverlayPatch(BASE, [
      { op: 'set', selector: 'operationId:listNotes', field: 'name', value: 'notes' },
      { op: 'set_default', field: 'hidden', value: true },
      { op: 'set_profile', name: 'p', tools: ['notes'] },
    ]).yaml;
    expect(diffOverlays(BASE, next).map((c) => `${c.kind}:${c.target}:${c.field}:${c.change}`)).toEqual(['default:defaults:hidden:added', 'tool:operationId:listNotes:name:changed', 'profile:p:null:added']);
    expect(diffOverlays(BASE, BASE)).toEqual([]);
  });
});
