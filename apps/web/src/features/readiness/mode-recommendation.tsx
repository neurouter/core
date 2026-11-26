import { LightbulbIcon } from 'lucide-react';
type RecommendedMode = 'tool' | 'code' | 'tools' | 'both';
import { cn } from '@/lib/utils';

const MODE_WORD: Record<RecommendedMode, string> = { tool: 'tool mode', tools: 'tool mode', code: 'code mode', both: 'both modes' };

/**
 * Recommendation callout (prototype: brand-muted box with a bulb). The sentence comes from the
 * backend (`recommendation`); without one the callout names the recommended mode only.
 */
export function ModeRecommendation({ mode, text, compact = false, className }: { mode: RecommendedMode | null; text?: string | null; compact?: boolean; className?: string }) {
  if (!mode) return null;
  return (
    <div className={cn('flex items-start gap-2.5 rounded-[10px] bg-brand-muted px-3.5 py-3', compact ? 'text-[13px]' : '', className)}>
      <LightbulbIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
      {/* the backend writes the full sentence; without one, name the recommended mode */}
      <p>{text ? <ModeText text={text} /> : <>Use <strong>{MODE_WORD[mode]}</strong>.</>}</p>
    </div>
  );
}

/** Colours the words "code mode" and "tool mode" with the mode tokens (text stays the signal). */
export function ModeText({ text }: { text: string }) {
  const parts = text.split(/(code mode|tool mode|both modes)/g);
  return (
    <>
      {parts.map((p, i) =>
        p === 'code mode' ? (
          <span key={i} className="font-semibold text-mode-code">
            code mode
          </span>
        ) : p === 'tool mode' ? (
          <span key={i} className="font-semibold text-mode-tool">
            tool mode
          </span>
        ) : p === 'both modes' ? (
          <strong key={i}>both modes</strong>
        ) : (
          p
        ),
      )}
    </>
  );
}
