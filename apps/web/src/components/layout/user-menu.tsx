import { Link } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { LogOutIcon, PaletteIcon } from 'lucide-react';
import { api, type Me } from '@/contract';
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { apiFetch } from '@/lib/api-client';
import { browserNavigation } from '@/lib/navigation';
import { initials } from '@/lib/initials';

const ROLE_LABEL = { admin: 'Admin', viewer: 'Viewer' } as const;

export async function signOut(queryClient: { clear: () => void }, navigate: (url: string) => void = (u) => browserNavigation.assign(u)) {
  let redirectTo = '/auth/logged-out';
  try {
    redirectTo = (await apiFetch(api.auth.logout)).endSessionUrl ?? redirectTo;
  } catch {
    // session already gone: still leave the app
  }
  queryClient.clear();
  navigate(redirectTo);
}

/** Avatar button in the top bar. */
export function UserMenu({ me }: { me: Me }) {
  const queryClient = useQueryClient();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`User menu: ${me.user.name}`}
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-semibold text-primary-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
      >
        {initials(me.user.name, me.user.email)}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex flex-col gap-0.5 font-normal">
            <span className="text-sm font-semibold text-foreground">{me.user.name || me.user.email}</span>
            <span className="truncate text-xs text-muted-foreground">{me.user.email}</span>
            <span className="text-xs text-muted-foreground">{me.user.anonymous ? 'Demo visitor' : ROLE_LABEL[me.user.role]}</span>
          </DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuItem render={<Link to="/settings/appearance" />}>
            <PaletteIcon /> Appearance
          </DropdownMenuItem>
        </DropdownMenuGroup>
        {me.user.anonymous ? null : (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void signOut(queryClient)}>
              <LogOutIcon /> Sign out
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
