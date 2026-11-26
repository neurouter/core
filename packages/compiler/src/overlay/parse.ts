import { isMap, isSeq, LineCounter, parseDocument, type Document } from 'yaml';
import { Overlay, type Diagnostic } from '@neurouter/shared';
import { validatePaths } from './paths.js';

export interface ParsedOverlay {
  overlay: Overlay | null;
  diagnostics: Diagnostic[];
}

function lineOf(doc: Document, lc: LineCounter, path: Array<string | number>): { line?: number; col?: number } {
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n), true);
    const range = (node as { range?: [number, number, number] } | undefined)?.range;
    if (range) {
      const pos = lc.linePos(range[0]);
      return { line: pos.line, col: pos.col };
    }
  }
  return {};
}

function overlayPath(path: Array<string | number>): string {
  return path.map((p, i) => (typeof p === 'number' ? `[${p}]` : i === 0 ? p : /^[A-Za-z_][A-Za-z0-9_]*$/.test(p) ? `.${p}` : `[${JSON.stringify(p)}]`)).join('');
}

/** Parses and validates overlay YAML; diagnostics carry `line`/`col` (1-based) and `overlayPath`. */
export function parseOverlay(text: string): ParsedOverlay {
  const diagnostics: Diagnostic[] = [];
  if (!text.trim()) return { overlay: { overlay: 1 }, diagnostics };
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: false, uniqueKeys: true });
  for (const e of doc.errors) {
    const pos = e.linePos?.[0];
    diagnostics.push({ severity: 'error', code: 'overlay_yaml', message: e.message.split('\n')[0]!, ...(pos ? { line: pos.line, col: pos.col } : {}) });
  }
  if (doc.errors.length) return { overlay: null, diagnostics };
  const raw = doc.toJS({ maxAliasCount: 50 }) as unknown;
  const res = Overlay.safeParse(raw);
  if (!res.success) {
    for (const issue of res.error.issues) {
      const path = issue.path.filter((p): p is string | number => typeof p === 'string' || typeof p === 'number');
      diagnostics.push({ severity: 'error', code: 'overlay_invalid', message: `${overlayPath(path) || '(root)'}: ${issue.message}`, overlayPath: overlayPath(path), ...lineOf(doc, lc, path) });
    }
    return { overlay: null, diagnostics };
  }
  const overlay = res.data;
  // path syntax for response fields
  for (const [sel, entry] of Object.entries(overlay.tools ?? {})) {
    const r = entry.response;
    if (!r) continue;
    const paths = [...(r.include ?? []), ...(r.exclude ?? []), ...(r.redact ?? []), ...Object.keys(r.flatten ?? {})];
    for (const err of validatePaths(paths)) {
      const p = ['tools', sel, 'response'];
      diagnostics.push({ severity: 'error', code: 'overlay_path', message: `tools["${sel}"].response: ${err}`, overlayPath: overlayPath(p), ...lineOf(doc, lc, p) });
    }
  }
  return { overlay: diagnostics.some((d) => d.severity === 'error') ? null : overlay, diagnostics };
}

/** Line of a selector in overlay YAML (for diagnostics produced while applying it). */
export function selectorLine(text: string, selector: string): number | undefined {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc });
  const tools = doc.get('tools', true);
  if (!isMap(tools)) return undefined;
  for (const item of tools.items) {
    const k = item.key as { value?: unknown; range?: [number, number, number] };
    if (k?.value === selector && k.range) return lc.linePos(k.range[0]).line;
  }
  return undefined;
}

export { isMap, isSeq };
