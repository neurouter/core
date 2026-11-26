import type { LucideIcon } from 'lucide-react';
import type { NavGroupView } from '@/app/nav';

/** One selectable row of the ⌘K palette (frontend spec §5.4). */
export type PaletteItem =
  | { kind: 'page'; id: string; label: string; hint: string; to: string; icon: LucideIcon }
  | { kind: 'server'; id: string; label: string; hint: string; serverId: string }
  | { kind: 'tool'; id: string; label: string; hint: string; serverId: string; toolId: string }
  | { kind: 'task'; id: string; label: string; hint: string; taskId: string }
  | { kind: 'action'; id: string; label: string; hint: string; to: string; search?: Record<string, string> };

const norm = (s: string) => s.toLowerCase().normalize('NFKD');

/** Every word of the query must appear in `hay`. */
export function matches(hay: string, q: string): boolean {
  const words = norm(q).split(/\s+/).filter(Boolean);
  const h = norm(hay);
  return words.every((w) => h.includes(w));
}

/** Pages the user can open (the capability-filtered sidebar IA). Empty query → all pages. */
export function matchPages(groups: readonly NavGroupView[], q: string, limit = 8): PaletteItem[] {
  const out: PaletteItem[] = [];
  for (const g of groups)
    for (const it of g.items) if (matches(`${it.title} ${g.label}`, q)) out.push({ kind: 'page', id: `page:${it.id}`, label: it.title, hint: g.label, to: it.to, icon: it.icon });
  return out.slice(0, limit);
}

/** Actions (spec §5.4): import a spec, new eval run, create an API key. */
export function matchActions(q: string, can: { import: boolean; evals: boolean; keys: boolean }): PaletteItem[] {
  const all: PaletteItem[] = [];
  if (can.import) all.push({ kind: 'action', id: 'action:import', label: 'Import a spec', hint: 'Action', to: '/servers/new' });
  if (can.evals) all.push({ kind: 'action', id: 'action:eval', label: 'New eval run', hint: 'Action', to: '/evals', search: { new: '1' } });
  if (can.keys) all.push({ kind: 'action', id: 'action:key', label: 'Create API key', hint: 'Action', to: '/keys', search: { create: '1' } });
  return q.trim() ? all.filter((a) => matches(a.label, q)) : all;
}

/** Wrapping arrow-key movement; Home/End jump. Returns -1 for an empty list. */
export function moveActive(index: number, key: string, count: number): number {
  if (count === 0) return -1;
  switch (key) {
    case 'ArrowDown':
      return (index + 1 + count) % count;
    case 'ArrowUp':
      return index <= 0 ? count - 1 : index - 1;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return Math.min(Math.max(index, 0), count - 1);
  }
}

/** Is this keydown the palette shortcut (⌘K on macOS, Ctrl+K elsewhere)? */
export function isPaletteShortcut(e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): boolean {
  return (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k';
}
