import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

export type Crumb = { label: string; to?: string };

const Ctx = createContext<{ crumbs: Crumb[] | null; set: (c: Crumb[] | null) => void }>({ crumbs: null, set: () => {} });

/** Holds breadcrumbs set by pages that know entity names (server, tool, run). */
export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[] | null>(null);
  return <Ctx.Provider value={{ crumbs, set }}>{children}</Ctx.Provider>;
}

export function useCrumbs(): Crumb[] | null {
  return useContext(Ctx).crumbs;
}

/** Sets dynamic breadcrumbs for the current page ("Servers › Acme Orders API › Tools"). */
export function useSetCrumbs(crumbs: Crumb[] | null): void {
  const { set } = useContext(Ctx);
  const key = JSON.stringify(crumbs);
  useEffect(() => {
    set(crumbs);
    return () => set(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, set]);
}
