import { cn } from '@/lib/utils';

/** Neurouter mark: the N path with a 270° score arc around it (frontend spec §6, prototype Sidebar). */
export function BrandMark({ className, arc = true }: { className?: string; arc?: boolean }) {
  return (
    <span className={cn('flex size-[34px] shrink-0 items-center justify-center rounded-[9px] bg-[#4338ca]', className)}>
      <svg viewBox="0 0 24 24" aria-hidden="true" className="size-6">
        <path d="M7 17V7l10 10V7" fill="none" stroke="#ffffff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
        {arc ? <path d="M12 2.5a9.5 9.5 0 1 1-9.5 9.5" fill="none" stroke="#a5b4fc" strokeWidth="1.6" strokeLinecap="round" /> : null}
      </svg>
    </span>
  );
}
