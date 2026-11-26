import { useEffect, useId, useMemo, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CornerDownLeftIcon, ListTreeIcon, SearchIcon, ServerIcon, WrenchIcon, ZapIcon } from 'lucide-react';
import type { Me } from '@/contract';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Kbd } from '@/components/ui/kbd';
import { Spinner } from '@/components/ui/spinner';
import { buildNav } from '@/app/nav';
import { serversQuery } from '@/features/servers/queries';
import { tasksQuery } from '@/features/tasks/queries';
import { toolSearchAllQuery } from '@/features/tools/queries';
import { useDebouncedValue } from '@/hooks/use-debounced-value';
import { can } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import { isPaletteShortcut, matchActions, matchPages, matches, moveActive, type PaletteItem } from './palette';

/** Global ⌘K / Ctrl+K listener. */
export function usePaletteShortcut(onOpen: () => void): void {
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (!isPaletteShortcut(e)) return;
      e.preventDefault();
      onOpen();
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onOpen]);
}

/**
 * ⌘K palette (spec §5.4): pages, servers, tools (`server › tool`, `tools.searchAll` debounced
 * 200 ms), recent tasks by id or goal, and actions. WAI-ARIA combobox + listbox.
 */
export function CommandPalette({ me, open, onOpenChange }: { me: Me; open: boolean; onOpenChange: (o: boolean) => void }) {
  const navigate = useNavigate();
  const id = useId();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const debounced = useDebouncedValue(q.trim(), 200);
  const toolsEnabled = open && debounced.length >= 2 && can(me, 'tools:read');
  const tools = useQuery({ ...toolSearchAllQuery(debounced), enabled: toolsEnabled });
  const servers = useQuery({ ...serversQuery(), enabled: open && can(me, 'servers:read') });
  const tasks = useQuery({ ...tasksQuery({ limit: 20 }), enabled: open && can(me, 'tasks:read') });
  const groups = useMemo(() => buildNav(me), [me]);
  const items: PaletteItem[] = useMemo(() => {
    const term = q.trim();
    const pages = matchPages(groups, term, term ? 5 : 8);
    const actions = matchActions(term, { import: can(me, 'servers:write'), evals: can(me, 'evals:run'), keys: can(me, 'keys:manage') });
    const srv: PaletteItem[] = term ? (servers.data?.items ?? []).filter((s) => matches(`${s.name} ${s.slug}`, term)).slice(0, 4).map((s) => ({ kind: 'server', id: `server:${s.id}`, label: s.name, hint: 'Server', serverId: s.id })) : [];
    const tl: PaletteItem[] = toolsEnabled && debounced === term ? (tools.data?.items ?? []).map((t) => ({ kind: 'tool', id: `tool:${t.id}`, label: `${t.server.name} › ${t.name}`, hint: t.title, serverId: t.server.id, toolId: t.id })) : [];
    const tk: PaletteItem[] = term ? (tasks.data?.items ?? []).filter((t) => matches(`${t.id} ${t.goal ?? t.inferredLabel?.goal ?? ''}`, term)).slice(0, 4).map((t) => ({ kind: 'task', id: `task:${t.id}`, label: t.goal ?? t.inferredLabel?.goal ?? t.id, hint: t.id, taskId: t.id })) : [];
    return [...pages, ...srv, ...tl, ...tk, ...actions];
  }, [groups, q, me, servers.data, tools.data, tasks.data, toolsEnabled, debounced]);
  const activeIndex = moveActive(active, '', items.length);
  const activeItem = items[activeIndex];

  useEffect(() => {
    if (!activeItem) return;
    document.getElementById(`${id}-${activeItem.id}`)?.scrollIntoView({ block: 'nearest' });
  }, [activeItem, id]);

  function close() {
    onOpenChange(false);
    setQ('');
    setActive(0);
  }

  function choose(it: PaletteItem) {
    close();
    if (it.kind === 'page') void navigate({ to: it.to });
    else if (it.kind === 'server') void navigate({ to: '/servers/$serverId', params: { serverId: it.serverId } });
    else if (it.kind === 'tool') void navigate({ to: '/servers/$serverId/tools/$toolId', params: { serverId: it.serverId, toolId: it.toolId } });
    else if (it.kind === 'task') void navigate({ to: '/tasks/$taskId', params: { taskId: it.taskId } });
    else void navigate({ to: it.to, search: it.search as never });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || ((e.key === 'Home' || e.key === 'End') && e.ctrlKey)) {
      e.preventDefault();
      setActive(moveActive(activeIndex, e.key, items.length));
    } else if (e.key === 'Enter' && activeItem) {
      e.preventDefault();
      choose(activeItem);
    }
  }

  const SECTIONS: { title: string; kind: PaletteItem['kind'] }[] = [
    { title: 'Pages', kind: 'page' },
    { title: 'Servers', kind: 'server' },
    { title: 'Tools', kind: 'tool' },
    { title: 'Tasks', kind: 'task' },
    { title: 'Actions', kind: 'action' },
  ];
  const sections = SECTIONS.map((s) => ({ ...s, items: items.filter((i) => i.kind === s.kind) })).filter((s) => s.items.length);
  const searching = toolsEnabled && (tools.isFetching || debounced !== q.trim());
  const ICON = { server: ServerIcon, tool: WrenchIcon, task: ListTreeIcon, action: ZapIcon } as const;

  return (
    <Dialog open={open} onOpenChange={(o) => (o ? onOpenChange(true) : close())}>
      <DialogContent showCloseButton={false} className="top-[12vh] translate-y-0 gap-0 overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Search</DialogTitle>
        <DialogDescription className="sr-only">Type to search pages, servers, tools and tasks. Use the arrow keys to move and Enter to open.</DialogDescription>
        <div className="flex items-center gap-2 border-b px-3">
          <SearchIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <input
            role="combobox"
            aria-expanded={items.length > 0}
            aria-controls={`${id}-list`}
            aria-activedescendant={activeItem ? `${id}-${activeItem.id}` : undefined}
            aria-autocomplete="list"
            aria-label="Search tools, tasks and pages"
            autoFocus
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search tools, tasks…"
            className="h-12 min-w-0 flex-1 bg-transparent text-[15px] outline-none placeholder:text-muted-foreground"
          />
          {searching ? <Spinner className="text-muted-foreground" /> : null}
          <Kbd>Esc</Kbd>
        </div>
        <div id={`${id}-list`} role="listbox" aria-label="Results" className="max-h-[min(60vh,420px)] overflow-y-auto p-1.5">
          {sections.map((s) => (
            <div key={s.title} role="group" aria-labelledby={`${id}-g-${s.kind}`} className="pb-1">
              <div id={`${id}-g-${s.kind}`} role="presentation" className="px-2 pt-2 pb-1 text-xs font-medium text-muted-foreground">
                {s.title}
              </div>
              {s.items.map((it) => {
                const on = activeItem?.id === it.id;
                const Icon = it.kind === 'page' ? it.icon : ICON[it.kind];
                return (
                  <div
                    key={it.id}
                    id={`${id}-${it.id}`}
                    role="option"
                    aria-selected={on}
                    onMouseMove={() => setActive(items.indexOf(it))}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(it)}
                    className={cn('flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-2 text-[13.5px]', on ? 'bg-accent text-accent-foreground' : '')}
                  >
                    <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
                    <span className={cn('min-w-0 truncate', it.kind === 'tool' ? 'font-mono text-[12.5px]' : '')}>{it.label}</span>
                    <span className="ml-auto min-w-0 truncate pl-2 text-xs text-muted-foreground">{it.hint}</span>
                    {on ? <CornerDownLeftIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {!items.length ? (
            <p role="status" className="px-3 py-6 text-center text-[13px] text-muted-foreground">
              Nothing matches “{q.trim()}”.
            </p>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
