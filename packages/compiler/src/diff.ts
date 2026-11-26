/** Spec change summary between two builds (backend spec §14.5 `SpecChangeSummary`). */
import type { ToolDef } from '@neurouter/shared';
import { matchesSelector } from './overlay/apply.js';
import { jcsHash } from './util.js';

export interface OpRef {
  key: string;
  method?: string;
  path?: string;
  operationId?: string;
  toolName?: string;
}

export interface SpecChangeSummary {
  added: OpRef[];
  removed: OpRef[];
  changed: Array<{ op: OpRef; fields: string[] }>;
  orphanedOverlayKeys: string[];
}

function ref(t: ToolDef): OpRef {
  const s = t.sourceRef as { operationId?: string; method?: string; path?: string };
  return { key: t.key, ...(s.method ? { method: s.method } : {}), ...(s.path ? { path: s.path } : {}), ...(s.operationId ? { operationId: s.operationId } : {}), toolName: t.name };
}

const FIELDS: Array<[string, (t: ToolDef) => unknown]> = [
  ['description', (t) => t.description],
  ['title', (t) => t.title],
  ['inputSchema', (t) => t.inputSchema],
  ['outputSchema', (t) => t.outputSchema ?? null],
  ['risk', (t) => t.risk],
  ['binding', (t) => t.binding],
  ['tags', (t) => t.tags],
  ['deprecated', (t) => t.deprecated],
];

/** Compares tools by their source key (composites are ignored). `overlayKeys` = overlay selectors in use. */
export function diffSpecs(prevTools: ToolDef[], nextTools: ToolDef[], overlayKeys: string[] = []): SpecChangeSummary {
  const prev = new Map(prevTools.filter((t) => t.kind !== 'composite').map((t) => [t.key, t]));
  const next = new Map(nextTools.filter((t) => t.kind !== 'composite').map((t) => [t.key, t]));
  const added: OpRef[] = [];
  const removed: OpRef[] = [];
  const changed: Array<{ op: OpRef; fields: string[] }> = [];
  for (const [k, t] of next) if (!prev.has(k)) added.push(ref(t));
  for (const [k, t] of prev) {
    const n = next.get(k);
    if (!n) {
      removed.push(ref(t));
      continue;
    }
    const fields = FIELDS.filter(([, get]) => jcsHash(get(t)) !== jcsHash(get(n))).map(([f]) => f);
    if (fields.length) changed.push({ op: ref(n), fields });
  }
  const tools = [...next.values()];
  const orphanedOverlayKeys = overlayKeys.filter((sel) => sel !== '*' && !tools.some((t) => matchesSelector(t, sel)));
  return { added, removed, changed, orphanedOverlayKeys };
}
