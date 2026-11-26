import { Link, useRouterState } from '@tanstack/react-router';
import { cn } from '@/lib/utils';

export interface LinkTab {
  label: string;
  to: string;
  /** Exact match only (the Overview tab). */
  exact?: boolean;
  count?: number;
}

/**
 * Route tab bar (prototype: 2px primary underline on the current tab). A nav of links with
 * `aria-current="page"`, so each tab is a shareable URL. Scrolls horizontally on phones.
 */
export function LinkTabs({ tabs, label, className }: { tabs: LinkTab[]; label: string; className?: string }) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  return (
    <nav aria-label={label} className={cn('-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0', className)}>
      <ul className="flex min-w-max gap-1 border-b">
        {tabs.map((t) => {
          const on = t.exact ? pathname === t.to || pathname === `${t.to}/` : pathname === t.to || pathname.startsWith(`${t.to}/`);
          return (
            <li key={t.to}>
              <Link
                to={t.to as '/'}
                aria-current={on ? 'page' : undefined}
                className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
              >
                {t.label}
                {t.count !== undefined ? <span className={cn('rounded-full px-1.5 text-xs tabular-nums', on ? 'bg-brand-muted text-brand-strong' : 'bg-muted')}>{t.count}</span> : null}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/** In-page tab buttons (state, not routes), prototype style. */
export function ButtonTabs<V extends string>({ value, onChange, tabs, label }: { value: V; onChange: (v: V) => void; tabs: { value: V; label: string; count?: number }[]; label: string }) {
  return (
    <div role="tablist" aria-label={label} className="-mx-4 flex gap-1 overflow-x-auto border-b px-4 md:mx-0 md:px-0">
      {tabs.map((t) => {
        const on = t.value === value;
        return (
          <button
            key={t.value}
            type="button"
            role="tab"
            id={`tab-${t.value}`}
            aria-selected={on}
            aria-controls={`panel-${t.value}`}
            onClick={() => onChange(t.value)}
            className={cn('-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring', on ? 'border-primary font-semibold text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground')}
          >
            {t.label}
            {t.count !== undefined ? <span className={cn('rounded-full px-1.5 text-xs tabular-nums', on ? 'bg-brand-muted text-brand-strong' : 'bg-muted')}>{t.count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}
