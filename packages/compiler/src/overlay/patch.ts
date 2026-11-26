/**
 * Structured console edits applied to overlay YAML with the `yaml` Document API, so comments and
 * formatting survive (backend spec §8.4 end, §14.6).
 */
import { isMap, parseDocument, type Document } from 'yaml';
import { Overlay, OverlayPatchOp, type OverlayChange } from '@neurouter/shared';
import { isObj, jcsHash } from '../util.js';

export interface PatchResult {
  yaml: string;
  changes: OverlayChange[];
}

export class OverlayPatchError extends Error {}

function load(text: string): Document {
  const doc = parseDocument(text.trim() ? text : 'overlay: 1\n');
  if (doc.errors.length) throw new OverlayPatchError(`overlay YAML is invalid: ${doc.errors[0]!.message.split('\n')[0]}`);
  if (!isMap(doc.contents)) throw new OverlayPatchError('overlay YAML must be a mapping');
  if (!doc.has('overlay')) doc.set('overlay', 1);
  return doc;
}

function pruneEmpty(doc: Document, path: string[]): void {
  for (let n = path.length; n >= 1; n--) {
    const node = doc.getIn(path.slice(0, n), true);
    if (isMap(node) && node.items.length === 0) doc.deleteIn(path.slice(0, n));
    else break;
  }
}

/** Applies console patch operations; returns the new YAML and one change record per op. */
export function applyOverlayPatch(yamlText: string, ops: unknown[]): PatchResult {
  const doc = load(yamlText);
  const changes: OverlayChange[] = [];
  for (const raw of ops) {
    const op = OverlayPatchOp.parse(raw);
    switch (op.op) {
      case 'set': {
        const path = ['tools', op.selector, op.field];
        const before = doc.getIn(path);
        doc.setIn(path, doc.createNode(op.value));
        changes.push({ kind: 'tool', target: op.selector, field: op.field, change: before === undefined ? 'added' : 'changed', before: toJs(before), after: op.value });
        break;
      }
      case 'unset': {
        const path = ['tools', op.selector, op.field];
        const before = doc.getIn(path);
        if (before === undefined) break;
        doc.deleteIn(path);
        pruneEmpty(doc, ['tools', op.selector]);
        pruneEmpty(doc, ['tools']);
        changes.push({ kind: 'tool', target: op.selector, field: op.field, change: 'removed', before: toJs(before) });
        break;
      }
      case 'set_default': {
        const before = doc.getIn(['defaults', 'hidden']);
        doc.setIn(['defaults', 'hidden'], op.value);
        changes.push({ kind: 'default', target: 'defaults', field: 'hidden', change: before === undefined ? 'added' : 'changed', before: toJs(before), after: op.value });
        break;
      }
      case 'set_composite': {
        const before = doc.getIn(['composites', op.name]);
        doc.setIn(['composites', op.name], doc.createNode(op.value));
        changes.push({ kind: 'composite', target: op.name, field: null, change: before === undefined ? 'added' : 'changed', before: toJs(before), after: op.value });
        break;
      }
      case 'remove_composite': {
        const before = doc.getIn(['composites', op.name]);
        if (before === undefined) break;
        doc.deleteIn(['composites', op.name]);
        pruneEmpty(doc, ['composites']);
        changes.push({ kind: 'composite', target: op.name, field: null, change: 'removed', before: toJs(before) });
        break;
      }
      case 'set_profile': {
        const before = doc.getIn(['profiles', op.name]);
        doc.setIn(['profiles', op.name], doc.createNode({ tools: op.tools }));
        changes.push({ kind: 'profile', target: op.name, field: 'tools', change: before === undefined ? 'added' : 'changed', before: toJs(before), after: { tools: op.tools } });
        break;
      }
    }
  }
  return { yaml: doc.toString({ lineWidth: 0 }), changes };
}

function toJs(v: unknown): unknown {
  if (v && typeof v === 'object' && 'toJSON' in v && typeof (v as { toJSON: unknown }).toJSON === 'function') return (v as { toJSON: () => unknown }).toJSON();
  return v;
}

function parseLoose(text: string): Overlay {
  if (!text.trim()) return { overlay: 1 };
  const js = parseDocument(text).toJS() as unknown;
  const r = Overlay.safeParse(js);
  return r.success ? r.data : ((isObj(js) ? js : { overlay: 1 }) as Overlay);
}

/** Field-level changes between two overlay versions (draft change counts, version diffs). */
export function diffOverlays(fromYaml: string, toYaml: string): OverlayChange[] {
  const a = parseLoose(fromYaml);
  const b = parseLoose(toYaml);
  const out: OverlayChange[] = [];
  const same = (x: unknown, y: unknown) => jcsHash(x ?? null) === jcsHash(y ?? null);
  if (!same(a.defaults?.hidden, b.defaults?.hidden)) out.push({ kind: 'default', target: 'defaults', field: 'hidden', change: a.defaults?.hidden === undefined ? 'added' : b.defaults?.hidden === undefined ? 'removed' : 'changed', before: a.defaults?.hidden, after: b.defaults?.hidden });
  const sels = new Set([...Object.keys(a.tools ?? {}), ...Object.keys(b.tools ?? {})]);
  for (const sel of sels) {
    const ea = (a.tools?.[sel] ?? {}) as Record<string, unknown>;
    const eb = (b.tools?.[sel] ?? {}) as Record<string, unknown>;
    for (const f of new Set([...Object.keys(ea), ...Object.keys(eb)])) {
      if (same(ea[f], eb[f])) continue;
      out.push({ kind: 'tool', target: sel, field: f, change: ea[f] === undefined ? 'added' : eb[f] === undefined ? 'removed' : 'changed', before: ea[f], after: eb[f] });
    }
  }
  for (const [kind, ma, mb] of [
    ['composite', a.composites ?? {}, b.composites ?? {}],
    ['profile', a.profiles ?? {}, b.profiles ?? {}],
  ] as const) {
    for (const k of new Set([...Object.keys(ma), ...Object.keys(mb)])) {
      const x = (ma as Record<string, unknown>)[k];
      const y = (mb as Record<string, unknown>)[k];
      if (same(x, y)) continue;
      out.push({ kind, target: k, field: null, change: x === undefined ? 'added' : y === undefined ? 'removed' : 'changed', before: x, after: y });
    }
  }
  return out;
}
