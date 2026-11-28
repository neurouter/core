import { Fragment, useCallback, useState } from 'react';
import { Link, useMatches } from '@tanstack/react-router';
import { EyeIcon, SearchIcon } from 'lucide-react';
import type { Me } from '@/contract';
import { Breadcrumb, BreadcrumbItem, BreadcrumbLink, BreadcrumbList, BreadcrumbPage, BreadcrumbSeparator } from '@/components/ui/breadcrumb';
import { Kbd } from '@/components/ui/kbd';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { ThemeToggle } from '@/components/theme/theme-toggle';
import { CommandPalette, usePaletteShortcut } from '@/features/search/command-palette';
import { isViewer } from '@/lib/permissions';
import { useCrumbs } from './crumbs';
import { DemoPill, IS_DEMO } from './demo-banner';
import { ServerSwitcher } from './server-switcher';
import { UserMenu } from './user-menu';

/** Top bar (spec §5.3): trigger · breadcrumbs · server switcher · demo / read-only pills · ⌘K · theme · user. */
export function SiteHeader({ me }: { me: Me }) {
  const matches = useMatches();
  const [paletteOpen, setPaletteOpen] = useState(false);
  usePaletteShortcut(useCallback(() => setPaletteOpen(true), []));
  const staticCrumbs = [...matches].reverse().find((m) => m.staticData?.crumbs)?.staticData?.crumbs ?? [];
  const dynamic = useCrumbs();
  const crumbs: { label: string; to?: string }[] = dynamic ?? staticCrumbs.map((label) => ({ label }));
  const viewer = isViewer(me) && !me.instance.demoReadOnly && !IS_DEMO;
  return (
    <header className="sticky top-0 z-10 flex h-14 shrink-0 items-center gap-2 border-b bg-background px-3 md:px-5">
      <SidebarTrigger className="size-8 text-muted-foreground" aria-label="Toggle sidebar (Ctrl+B)" />
      <Separator orientation="vertical" className="mx-1 hidden data-[orientation=vertical]:h-4 sm:block" />
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap overflow-hidden whitespace-nowrap">
          {crumbs.map((c, i) => (
            <Fragment key={`${c.label}-${i}`}>
              <BreadcrumbItem className={i < crumbs.length - 1 ? 'hidden sm:inline-flex' : 'min-w-0'}>
                {i === crumbs.length - 1 ? <BreadcrumbPage className="truncate font-medium">{c.label}</BreadcrumbPage> : c.to ? <BreadcrumbLink render={<Link to={c.to as '/'} />}>{c.label}</BreadcrumbLink> : <span>{c.label}</span>}
              </BreadcrumbItem>
              {i < crumbs.length - 1 ? <BreadcrumbSeparator className="hidden sm:inline-flex" /> : null}
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      <ServerSwitcher />
      <DemoPill />
      {viewer ? (
        <span title="Viewer role: you can look at everything but not change it" className="inline-flex h-[22px] shrink-0 items-center gap-1 rounded-full border px-2 text-xs text-muted-foreground">
          <EyeIcon aria-hidden="true" className="size-3" />
          Viewer · read-only
        </span>
      ) : null}
      <button
        type="button"
        aria-label="Search tools, tasks and pages"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setPaletteOpen(true)}
        className="hidden h-8 w-60 items-center gap-2 rounded-lg border bg-background pr-1.5 pl-2.5 text-[13px] text-muted-foreground hover:bg-accent lg:inline-flex"
      >
        <SearchIcon className="size-4" aria-hidden="true" />
        <span className="flex-1 text-left">Search tools, tasks…</span>
        <Kbd>⌘K</Kbd>
      </button>
      <button type="button" aria-label="Search" onClick={() => setPaletteOpen(true)} className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent lg:hidden">
        <SearchIcon className="size-[18px]" aria-hidden="true" />
      </button>
      <CommandPalette me={me} open={paletteOpen} onOpenChange={setPaletteOpen} />
      <ThemeToggle />
      <UserMenu me={me} />
    </header>
  );
}
