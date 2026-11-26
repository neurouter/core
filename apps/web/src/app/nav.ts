import type { LucideIcon } from 'lucide-react';
import { FileTextIcon, FileUpIcon, GaugeIcon, InboxIcon, KeyRoundIcon, LayoutDashboardIcon, ListTreeIcon, PlugIcon, ServerIcon, SlidersHorizontalIcon } from 'lucide-react';
import type { Capability } from '@neurouter/shared';
import type { Badges, Me } from '@/contract';
import { can, isViewer } from '@/lib/permissions';

export type BadgeKey = keyof Badges;
export type BadgeTone = 'default' | 'warning' | 'muted';

export interface NavItemDef {
  id: string;
  title: string;
  to: string;
  icon: LucideIcon;
  capability: Capability;
  badgeKey?: BadgeKey;
  badgeTone?: BadgeTone;
  /** Badge label for screen readers, e.g. "6 open". */
  badgeLabel?: string;
}

export interface NavGroupDef {
  id: string;
  label: string;
  items: NavItemDef[];
  /** Note shown next to the label: "read-only" for Viewers. */
  note?: (me: Me) => string | null;
}

const readOnlyNote = (me: Me) => (isViewer(me) ? 'read-only' : null);

/** Sidebar IA (frontend spec §5.2, prototype Sidebar.dc.html). */
export const NAV: readonly NavGroupDef[] = [
  {
    id: 'build',
    label: 'Build',
    note: readOnlyNote,
    items: [
      { id: 'overview', title: 'Overview', to: '/', icon: LayoutDashboardIcon, capability: 'servers:read' },
      { id: 'servers', title: 'Servers', to: '/servers', icon: ServerIcon, capability: 'servers:read' },
      { id: 'import', title: 'Import a spec', to: '/servers/new', icon: FileUpIcon, capability: 'servers:write' },
    ],
  },
  {
    id: 'operate',
    label: 'Operate',
    items: [
      { id: 'tasks', title: 'Tasks', to: '/tasks', icon: ListTreeIcon, capability: 'tasks:read' },
      { id: 'inbox', title: 'Inbox', to: '/inbox', icon: InboxIcon, capability: 'inbox:read', badgeKey: 'inboxOpen', badgeLabel: 'open' },
    ],
  },
  {
    id: 'evaluate',
    label: 'Evaluate',
    items: [{ id: 'evals', title: 'Evals', to: '/evals', icon: GaugeIcon, capability: 'evals:read', badgeKey: 'evalsRunning', badgeTone: 'muted', badgeLabel: 'running' }],
  },
  {
    id: 'govern',
    label: 'Govern',
    items: [
      { id: 'audit', title: 'Audit log', to: '/audit', icon: FileTextIcon, capability: 'audit:read' },
      { id: 'keys', title: 'API keys', to: '/keys', icon: KeyRoundIcon, capability: 'keys:read' },
      { id: 'connect', title: 'Connect a client', to: '/connect', icon: PlugIcon, capability: 'keys:read' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings',
    items: [{ id: 'settings', title: 'Settings', to: '/settings', icon: SlidersHorizontalIcon, capability: 'settings:read' }],
  },
];

export interface NavItemView {
  id: string;
  title: string;
  to: string;
  icon: LucideIcon;
  badge: number | null;
  badgeTone: BadgeTone;
  badgeLabel: string;
}

export interface NavGroupView {
  id: string;
  label: string;
  note: string | null;
  items: NavItemView[];
}

/** Filters the IA for a user: a group renders only if at least one item passes `can()`. */
export function buildNav(me: Me, badges?: Partial<Badges> | null, nav: readonly NavGroupDef[] = NAV): NavGroupView[] {
  const groups: NavGroupView[] = [];
  for (const g of nav) {
    const items: NavItemView[] = [];
    for (const item of g.items) {
      if (!can(me, item.capability)) continue;
      const count = item.badgeKey && badges ? (badges[item.badgeKey] ?? 0) : 0;
      items.push({
        id: item.id,
        title: item.title,
        to: item.to,
        icon: item.icon,
        badge: count > 0 ? count : null,
        badgeTone: item.badgeTone ?? 'default',
        badgeLabel: item.badgeLabel ?? 'pending',
      });
    }
    if (items.length) groups.push({ id: g.id, label: g.label, note: g.note?.(me) ?? null, items });
  }
  return groups;
}

/**
 * Active item: the longest nav target that prefixes the path. `/` only matches exactly, and
 * `/servers/new` beats `/servers`.
 */
export function activeNavId(groups: NavGroupView[], pathname: string): string | null {
  let best: { id: string; len: number } | null = null;
  for (const g of groups)
    for (const item of g.items) {
      const match = item.to === '/' ? pathname === '/' : pathname === item.to || pathname.startsWith(`${item.to}/`);
      if (match && (!best || item.to.length > best.len)) best = { id: item.id, len: item.to.length };
    }
  return best?.id ?? null;
}
