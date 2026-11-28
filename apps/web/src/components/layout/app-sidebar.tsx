import { Link, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '@/contract';
import {
  Sidebar, SidebarContent, SidebarGroup, SidebarGroupContent, SidebarGroupLabel, SidebarHeader, SidebarMenu, SidebarMenuBadge,
  SidebarMenuButton, SidebarMenuItem, SidebarRail, useSidebar,
} from '@/components/ui/sidebar';
import { activeNavId, buildNav, type BadgeTone } from '@/app/nav';
import { badgesQueryOptions } from '@/features/auth/queries';
import { cn } from '@/lib/utils';
import { BrandMark } from './brand-mark';
import { TenantSwitcher } from './tenant-switcher';

// The shadcn badge switches its text to sidebar-accent-foreground when the item is hovered or
// active; keep each tone's own text colour there too, or the count vanishes.
const BADGE_TONE: Record<BadgeTone, string> = {
  default: 'bg-primary text-primary-foreground peer-hover/menu-button:text-primary-foreground peer-data-active/menu-button:text-primary-foreground',
  warning: 'border border-warning/40 bg-warning-muted text-warning peer-hover/menu-button:text-warning peer-data-active/menu-button:text-warning',
  muted: 'bg-muted text-muted-foreground peer-hover/menu-button:text-muted-foreground peer-data-active/menu-button:text-muted-foreground',
};

export { activeNavId };

/** Sidebar (prototype Sidebar.dc.html): mark + product + instance name + version, grouped nav with badges. */
export function AppSidebar({ me }: { me: Me }) {
  const { data: badges } = useQuery(badgesQueryOptions());
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { isMobile, setOpenMobile } = useSidebar();
  const closeOnPhone = () => {
    if (isMobile) setOpenMobile(false);
  };
  const groups = buildNav(me, badges ?? me.badges);
  const active = activeNavId(groups, pathname);
  return (
    <Sidebar collapsible="icon">
      <nav aria-label="Main navigation" className="flex min-h-0 flex-1 flex-col">
        <SidebarHeader className="h-16 justify-center">
          {/* the slot under the product name: the instance name, or the organization switcher on a multi-tenant deployment */}
          <div className="flex items-center gap-2.5 px-1 group-data-[collapsible=icon]:px-0">
            <BrandMark className="group-data-[collapsible=icon]:size-8" />
            <div className="flex min-w-0 flex-1 flex-col leading-tight group-data-[collapsible=icon]:hidden">
              <span className="text-sm font-semibold">Neurouter</span>
              {me.tenancy.multi ? <TenantSwitcher me={me} /> : <span className="truncate text-[12.5px] text-muted-foreground">{me.instance.name}</span>}
            </div>
            <span className="rounded-full border px-1.5 py-px font-mono text-[11px] text-muted-foreground group-data-[collapsible=icon]:hidden">v{me.instance.version}</span>
          </div>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((g) => (
            <SidebarGroup key={g.id} role="group" aria-label={g.label}>
              <SidebarGroupLabel className="flex gap-1.5">
                <span className="flex-1">{g.label}</span>
                {g.note ? <span className="text-[11px] font-medium">{g.note}</span> : null}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {g.items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={active === item.id}
                        tooltip={item.title}
                        className="data-active:font-semibold"
                        render={<Link to={item.to} onClick={closeOnPhone} activeOptions={{ exact: true, includeSearch: false }} aria-current={active === item.id ? 'page' : undefined} />}
                      >
                        <item.icon />
                        <span>{item.title}</span>
                      </SidebarMenuButton>
                      {item.badge !== null ? (
                        <SidebarMenuBadge className={cn('rounded-full px-1.5 text-[11px] font-semibold tabular-nums', BADGE_TONE[item.badgeTone])} aria-label={`${item.badge} ${item.badgeLabel}`}>
                          {item.badge}
                        </SidebarMenuBadge>
                      ) : null}
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
      </nav>
      <SidebarRail />
    </Sidebar>
  );
}
