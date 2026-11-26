import { useNavigate, useRouterState } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { serversQuery } from '@/features/servers/queries';
import { readStorage, writeStorage } from '@/lib/storage';

export const SERVER_STORAGE_KEY = 'neurouter-console-server';

/** Pages whose list is filtered by `?server=` (spec §5.3). */
const FILTERED = ['/tasks', '/inbox', '/evals', '/audit'];

export function rememberedServer(): string | undefined {
  return readStorage(SERVER_STORAGE_KEY) ?? undefined;
}

/**
 * Server switcher in the top bar (spec §5.3). On a `/servers/$id/*` page it switches to the same
 * tab of another server; on Tasks, Inbox, Evals and Audit it sets `?server=`. Hidden with one
 * server (A-SWITCHER).
 */
export function ServerSwitcher() {
  const { data } = useQuery(serversQuery());
  const navigate = useNavigate();
  const loc = useRouterState({ select: (s) => s.location });
  const servers = data?.items ?? [];
  if (servers.length <= 1) return null;
  const match = loc.pathname.match(/^\/servers\/([^/]+)(\/.*)?$/);
  const onServerPage = match && match[1] !== 'new';
  const filtered = FILTERED.some((p) => loc.pathname === p);
  const search = loc.search as { server?: string };
  const currentId = onServerPage ? match![1] : filtered ? search.server : undefined;
  const current = servers.find((s) => s.id === currentId);
  if (!onServerPage && !filtered) return null;

  const pick = (id: string | undefined) => {
    if (id) writeStorage(SERVER_STORAGE_KEY, id);
    if (onServerPage && id) {
      void navigate({ to: `/servers/${id}${match![2] && !match![2].startsWith('/tools/') ? match![2] : match![2]?.startsWith('/tools/') ? '/tools' : ''}` as '/' });
    } else {
      void navigate({ to: loc.pathname as '/', search: (prev: Record<string, unknown>) => ({ ...prev, server: id, cursor: undefined }) as never });
    }
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="hidden h-8 max-w-56 items-center gap-1.5 rounded-lg border bg-background px-2.5 text-[13px] outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex" aria-label={`Server: ${current?.name ?? 'All servers'}`}>
        <span className="truncate">{current?.name ?? 'All servers'}</span>
        <ChevronDownIcon aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Server</DropdownMenuLabel>
          {!onServerPage ? (
            <DropdownMenuItem onClick={() => pick(undefined)}>
              <span className="flex-1">All servers</span>
              {!current ? <CheckIcon aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ) : null}
        </DropdownMenuGroup>
        {!onServerPage ? <DropdownMenuSeparator /> : null}
        <DropdownMenuGroup>
          {servers.map((s) => (
            <DropdownMenuItem key={s.id} onClick={() => pick(s.id)}>
              <span className="flex-1 truncate">{s.name}</span>
              {current?.id === s.id ? <CheckIcon aria-hidden="true" /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
