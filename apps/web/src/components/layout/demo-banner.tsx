import { EyeIcon } from 'lucide-react';

/** True on the static demo site (`npm run build:demo`). */
export const IS_DEMO = import.meta.env.VITE_DEMO === 'true';

/** Public site links (frontend spec §15.2: the new site, never neurouter.com). */
export const SITE_URL = 'https://neurouter-site.web.app';

/** Strip above the top bar on the demo site: read-only, simulated data, where to get the real thing. */
export function DemoBanner() {
  if (!IS_DEMO) return null;
  return (
    <div role="note" className="flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-brand-border bg-brand-muted px-4 py-1.5 text-center text-[12.5px] text-brand-strong">
      <span className="inline-flex items-center gap-1.5 font-semibold">
        <EyeIcon className="size-3.5" aria-hidden />
        Read-only demo
      </span>
      <span>Simulated APIs, agents and traffic. Changes aren't saved.</span>
      <span className="inline-flex gap-3">
        <a className="font-medium underline underline-offset-4" href={`${SITE_URL}/docs/quickstart`}>
          Run it yourself
        </a>
        <a className="font-medium underline underline-offset-4" href={`${SITE_URL}/open-source`}>
          Open source
        </a>
      </span>
    </div>
  );
}

/** Compact label for the sticky top bar, so "read-only" stays visible after scrolling. */
export function DemoPill() {
  if (!IS_DEMO) return null;
  return (
    <span title="This is a read-only demo with simulated data" className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-brand-border bg-brand-muted px-2 text-xs font-medium text-brand-strong">
      Demo · read-only
    </span>
  );
}
