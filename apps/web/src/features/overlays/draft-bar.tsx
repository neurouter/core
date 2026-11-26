import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { GatedButton } from '@/components/app/gated';
import { draftQuery, useDiscardDraft } from '@/features/tools/queries';
import { environmentsQuery } from '@/features/environments/queries';
import { plural } from '@/lib/format';
import { notifySuccess } from '@/lib/notify';

/**
 * Sticky draft bar (prototype ToolOverlay): "3 unpublished changes · Review & publish". Publishing
 * pins the new build to the non-prod environments by default.
 */
export function OverlayDraftBar({ serverId }: { serverId: string }) {
  const draft = useQuery(draftQuery(serverId));
  const envs = useQuery(environmentsQuery(serverId));
  const discard = useDiscardDraft(serverId);
  const n = draft.data?.changeCount ?? 0;
  if (!n) return null;
  const next = (draft.data?.basedOnRev ?? 0) + 1;
  const pins = envs.data?.items.filter((e) => e.kind !== 'prod' && !e.isMock).map((e) => e.slug) ?? ['dev', 'qa'];
  const prod = envs.data?.items.some((e) => e.kind === 'prod');
  return (
    <div role="region" aria-label="Unpublished overlay changes" className="sticky bottom-0 z-[5] -mx-4 mt-auto flex flex-wrap items-center gap-3 border-t border-brand-border bg-brand-muted px-4 py-3 md:-mx-8 md:px-8">
      <span className="font-semibold" aria-live="polite">
        {plural(n, 'unpublished change')}
      </span>
      <span className="flex-1 text-[13px] text-muted-foreground">
        Publishing creates overlay v{next} and pins it to {pins.join(' and ') || 'the non-prod environments'}.{prod ? ` Prod stays on v${draft.data?.basedOnRev ?? '–'} until you promote it.` : ''}
      </span>
      <GatedButton cap="overlays:write" variant="outline" size="lg" className="bg-card" disabled={discard.isPending} onClick={() => discard.mutate(undefined, { onSuccess: () => notifySuccess('Draft discarded') })}>
        Discard
      </GatedButton>
      <GatedButton cap="overlays:write" demoOp="overlays.updateDraft" size="lg" render={<Link to="/servers/$serverId/overlay" params={{ serverId }} search={{ publish: '1' }} />} nativeButton={false}>
        Review &amp; publish
      </GatedButton>
    </div>
  );
}
