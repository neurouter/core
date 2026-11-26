import type { QueryClient } from '@tanstack/react-query';
import type { MockDb } from '@/mocks/db';
import { addLiveTask, addUnmetNeedReport, closeTask } from '@/mocks/fixtures';

/**
 * Demo site only (VITE_DEMO=true): makes the mock dataset look like live agent traffic
 * (frontend spec §12). Every 4–8 s an agent starts a task (about 1 in 4 includes a script); open
 * tasks finish 10–25 s later; about 1 in 10 files an unmet need. The overview KPIs, the tasks list
 * and the inbox badge refetch. Memory only: a reload starts over.
 */
export function startDemoSimulator(queryClient: QueryClient, db: MockDb, opts: { minMs?: number; maxMs?: number; random?: () => number } = {}): () => void {
  const random = opts.random ?? Math.random;
  const minMs = opts.minMs ?? 4000;
  const maxMs = opts.maxMs ?? 8000;
  let n = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const closers = new Set<ReturnType<typeof setTimeout>>();
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ['tasks'] });
    void queryClient.invalidateQueries({ queryKey: ['metrics'] });
    void queryClient.invalidateQueries({ queryKey: ['me', 'badges'] });
  };
  const tick = () => {
    const row = addLiveTask(db, n++);
    const c = setTimeout(() => {
      closers.delete(c);
      closeTask(db, row.id);
      refresh();
    }, 10_000 + random() * 15_000);
    closers.add(c);
    if (random() < 0.1) {
      addUnmetNeedReport(db);
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    }
    refresh();
    timer = setTimeout(tick, minMs + random() * (maxMs - minMs));
  };
  timer = setTimeout(tick, minMs + random() * (maxMs - minMs));
  return () => {
    clearTimeout(timer);
    for (const c of closers) clearTimeout(c);
  };
}
