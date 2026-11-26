import { includePaths } from '@neurouter/compiler';
import { itemsOf } from './plan.js';

/**
 * `fields` projection (contract-v2 §4.5, H-03/H-08): keeps only the requested dot paths. On list tools the paths
 * are per item and the list wrapper's other keys (totals, cursors) stay; dot paths cross arrays (`items.sku` keeps
 * `sku` of every line item).
 */
export function projectFields(value: unknown, fields: string[], list: boolean): unknown {
  if (!fields.length) return value;
  if (list) {
    if (Array.isArray(value)) return includePaths(value, fields);
    const items = itemsOf(value);
    if (items && value && typeof value === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = v === items ? includePaths(v, fields) : v;
      return out;
    }
  }
  return includePaths(value, fields);
}

/** Clipped paths (`items[3].body`, `name`) as `fields` arguments (`items.body`, `name`). */
export function clippedFields(paths: string[]): string[] {
  return [...new Set(paths.map((p) => p.replace(/\[\d+\]/g, '').replace(/^\./, '')).filter(Boolean))];
}
