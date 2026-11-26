import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { DownloadIcon, Undo2Icon } from 'lucide-react';
import type { OverlayChange } from '@/contract';
import { GatedButton } from '@/components/app/gated';
import { describeChange, keyName } from '@/components/app/labels';
import { DiffView } from '@/components/code/diff-view';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { EmptyState, ErrorState } from '@/components/feedback/states';
import { Segmented } from '@/components/filters/segmented';
import { EnvBadge, Pill } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { environmentsQuery } from '@/features/environments/queries';
import { draftQuery, overlayDiffQuery, toolsQuery, useDiscardDraft, usePatchDraft, usePublish, useRevert, versionsQuery } from '@/features/tools/queries';
import { overlayDownloadUrl } from '@/lib/download';
import { formatRelative, plural } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const search = z.object({ publish: z.coerce.string().optional().catch(undefined), compare: z.coerce.number().optional().catch(undefined) });

export const Route = createFileRoute('/_app/servers/$serverId/overlay')({
  validateSearch: search,
  component: OverlayPage,
});

/** Groups draft changes by tool selector (overlay draft → change list, spec §14 unit test). */
export function changesByTool(changes: OverlayChange[]): { target: string; changes: OverlayChange[] }[] {
  const map = new Map<string, OverlayChange[]>();
  for (const c of changes) map.set(c.target, [...(map.get(c.target) ?? []), c]);
  return [...map.entries()].map(([target, list]) => ({ target, changes: list }));
}

/** Overlay draft, YAML diff, publish, versions and revert (spec §9.7). */
function OverlayPage() {
  const { serverId } = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const draft = useQuery(draftQuery(serverId));
  const versions = useQuery(versionsQuery(serverId));
  const tools = useQuery(toolsQuery(serverId, {}));
  const from = String(draft.data?.basedOnRev ?? 0);
  const diff = useQuery({ ...overlayDiffQuery(serverId, from, 'draft'), enabled: !!draft.data });
  const [layout, setLayout] = useState<'split' | 'unified'>('split');
  const patch = usePatchDraft(serverId);
  const discard = useDiscardDraft(serverId);
  const revert = useRevert(serverId);
  const [revertTo, setRevertTo] = useState<number | null>(null);
  const nameOf = (key: string) => tools.data?.items.find((t) => t.key === key)?.name ?? keyName(key);
  const idOf = (key: string) => tools.data?.items.find((t) => t.key === key)?.id;
  const groups = draft.data ? changesByTool(draft.data.changes) : [];
  const n = draft.data?.changeCount ?? 0;
  if (draft.isError) return <ErrorState error={draft.error} onRetry={() => void draft.refetch()} />;
  const discardOne = (c: OverlayChange) => {
    const field = (c.field ?? '').split('.')[0] as 'name';
    if (c.field?.startsWith('response.')) {
      const rest = Object.fromEntries(draft.data!.changes.filter((x) => x.target === c.target && x.field?.startsWith('response.') && x !== c).map((x) => [x.field!.slice(9), x.after]));
      return patch.mutate([Object.keys(rest).length ? { op: 'set', selector: c.target, field: 'response', value: rest } : { op: 'unset', selector: c.target, field: 'response' }]);
    }
    patch.mutate([c.before === undefined ? { op: 'unset', selector: c.target, field } : { op: 'set', selector: c.target, field, value: c.before }]);
  };
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[13.5px] text-muted-foreground">
          {n ? `${plural(n, 'unpublished change')} in the draft, based on overlay v${draft.data?.basedOnRev ?? '–'}. The draft never affects live traffic until you publish it.` : 'The draft matches the published overlay.'}
        </p>
        <Button variant="outline" render={<a href={overlayDownloadUrl(serverId)} download="overlay.yaml" />} nativeButton={false}>
          <DownloadIcon /> Download overlay.yaml
        </Button>
        <GatedButton cap="overlays:write" variant="outline" disabled={!n || discard.isPending} onClick={() => discard.mutate(undefined, { onSuccess: () => notifySuccess('Draft discarded'), onError: (e) => notifyError(e) })}>
          Discard draft
        </GatedButton>
        <GatedButton cap="overlays:write" disabled={!n || draft.data?.fileManaged} disabledReason={draft.data?.fileManaged ? 'The overlay is file-managed: download it and commit instead' : null} onClick={() => void navigate({ search: (p) => ({ ...p, publish: '1' }) })}>
          Publish
        </GatedButton>
      </div>
      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <section aria-labelledby="changes-title" className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <h2 id="changes-title" className="text-base font-semibold">
            Draft changes
          </h2>
          {!draft.data ? <Skeleton className="h-32" /> : null}
          {draft.data && !groups.length ? <EmptyState title="No changes" description="Edit a tool's name, description or response shaping on the Tools tab." /> : null}
          <ul className="flex flex-col divide-y">
            {groups.map((g) => (
              <li key={g.target} className="flex flex-col gap-1 py-2.5">
                {idOf(g.target) ? (
                  <Link to="/servers/$serverId/tools/$toolId" params={{ serverId, toolId: idOf(g.target)! }} search={{ tab: 'overlay' }} className="font-mono text-[13px] font-medium hover:underline">
                    {nameOf(g.target)}
                  </Link>
                ) : (
                  <span className="font-mono text-[13px] font-medium">{nameOf(g.target)}</span>
                )}
                <ul className="flex flex-col gap-1">
                  {g.changes.map((c, i) => (
                    <li key={i} className="flex items-center gap-2 text-[13px]">
                      <span className="flex-1">{describeChange(c)}</span>
                      <GatedButton cap="overlays:write" demoOp="overlays.updateDraft" variant="ghost" size="xs" onClick={() => discardOne(c)} aria-label={`Discard: ${describeChange(c)}`}>
                        discard
                      </GatedButton>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>
        <section aria-labelledby="yaml-title" className="flex min-w-0 flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 id="yaml-title" className="flex-1 text-base font-semibold">
              overlay.yaml: published vs draft
            </h2>
            <Segmented label="Diff layout" size="sm" value={layout} onChange={setLayout} options={[{ value: 'split', label: 'Split' }, { value: 'unified', label: 'Unified' }]} />
          </div>
          {diff.data ? <DiffView layout={layout} oldText={diff.data.fromYaml} newText={diff.data.toYaml} labels={[`v${draft.data?.basedOnRev ?? '–'} (published)`, 'Draft']} /> : <Skeleton className="h-64" />}
        </section>
      </div>
      <section aria-labelledby="versions-title" className="flex flex-col gap-2 rounded-xl border bg-card">
        <h2 id="versions-title" className="px-4 pt-4 text-base font-semibold">
          Versions
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Version</th>
                <th scope="col" className="px-2 py-2 font-medium">Note</th>
                <th scope="col" className="px-2 py-2 font-medium">Author</th>
                <th scope="col" className="px-2 py-2 font-medium">When</th>
                <th scope="col" className="px-4 py-2 text-right font-medium">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {versions.data?.items.map((v, i) => (
                <tr key={v.id} className="border-t">
                  <td className="px-4 py-2.5 font-medium">
                    v{v.rev} {i === 0 ? <Pill tone="brand">current</Pill> : null} {v.source !== 'console' ? <Pill tone="muted">{v.source}</Pill> : null}
                  </td>
                  <td className="px-2 py-2.5">{v.message}</td>
                  <td className="px-2 py-2.5 text-muted-foreground">{v.createdBy?.name ?? 'neurouter.yaml'}</td>
                  <td className="px-2 py-2.5 text-muted-foreground">{formatRelative(v.createdAt)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">
                    {v.rev > 1 ? (
                      <Button variant="ghost" size="xs" onClick={() => void navigate({ search: (p) => ({ ...p, compare: v.rev }) })}>
                        Diff vs v{v.rev - 1}
                      </Button>
                    ) : null}
                    {i > 0 ? (
                      <GatedButton cap="overlays:write" variant="ghost" size="xs" onClick={() => setRevertTo(v.rev)}>
                        <Undo2Icon /> Revert to this
                      </GatedButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      {s.compare ? <VersionDiffDialog serverId={serverId} rev={s.compare} onClose={() => void navigate({ search: (p) => ({ ...p, compare: undefined }) })} /> : null}
      <PublishDialog serverId={serverId} open={!!s.publish && n > 0} onClose={() => void navigate({ search: (p) => ({ ...p, publish: undefined }) })} changes={n} tools={groups.length} />
      <ConfirmDialog
        open={revertTo !== null}
        onOpenChange={(o) => !o && setRevertTo(null)}
        title={`Revert to v${revertTo}?`}
        description="This publishes the old overlay as a new version. The current draft is replaced."
        confirmLabel="Revert"
        onConfirm={() =>
          revert.mutate(revertTo!, {
            onSuccess: (r) => {
              notifySuccess(`Published v${r.revision.rev} (revert)`);
              setRevertTo(null);
            },
            onError: (e) => notifyError(e),
          })
        }
      />
    </div>
  );
}

function VersionDiffDialog({ serverId, rev, onClose }: { serverId: string; rev: number; onClose: () => void }) {
  const diff = useQuery(overlayDiffQuery(serverId, String(rev - 1), String(rev)));
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            v{rev - 1} → v{rev}
          </DialogTitle>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-auto">{diff.data ? <DiffView layout="unified" oldText={diff.data.fromYaml} newText={diff.data.toYaml} labels={[`v${rev - 1}`, `v${rev}`]} /> : <Skeleton className="h-40" />}</div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Publish (spec §9.7, A-OVERLAY-LIFECYCLE): change note, the YAML diff and "Pin to
 * environments" (dev and qa checked, prod unchecked by default).
 */
export function PublishDialog({ serverId, open, onClose, changes, tools }: { serverId: string; open: boolean; onClose: () => void; changes: number; tools: number }) {
  const draft = useQuery(draftQuery(serverId));
  const envs = useQuery(environmentsQuery(serverId));
  const diff = useQuery({ ...overlayDiffQuery(serverId, String(draft.data?.basedOnRev ?? 0), 'draft'), enabled: open && !!draft.data });
  const publish = usePublish(serverId);
  const [message, setMessage] = useState('');
  const [pins, setPins] = useState<Record<string, boolean> | null>(null);
  const list = envs.data?.items ?? [];
  const pinned = pins ?? Object.fromEntries(list.map((e) => [e.id, e.kind !== 'prod']));
  const next = (draft.data?.basedOnRev ?? 0) + 1;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Publish overlay v{next}</DialogTitle>
          <DialogDescription>
            {plural(changes, 'change')} to {plural(tools, 'tool')}. Agents on the pinned environments see the new definitions on their next tools/list.
          </DialogDescription>
        </DialogHeader>
        <form
          id="publish-form"
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            publish.mutate(
              { message, pinTo: Object.entries(pinned).filter(([, v]) => v).map(([k]) => k) },
              {
                onSuccess: (r) => {
                  notifySuccess(`Published overlay v${r.revision.rev}`, r.pinnedEnvironments.length ? `Pinned to ${r.pinnedEnvironments.map((p) => p.slug).join(', ')}` : 'Not pinned to any environment yet');
                  setMessage('');
                  onClose();
                },
                onError: (err) => notifyError(err, 'Could not publish'),
              },
            );
          }}
        >
          <div className="max-h-[38vh] overflow-auto">{diff.data ? <DiffView layout="unified" oldText={diff.data.fromYaml} newText={diff.data.toYaml} labels={[`v${draft.data?.basedOnRev ?? '–'} (published)`, 'Draft']} /> : <Skeleton className="h-32" />}</div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="pub-note">Change note</Label>
            <Textarea id="pub-note" rows={2} required maxLength={500} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Rewrite search_customers description; cap list sizes" />
          </div>
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-sm font-medium">Pin to environments</legend>
            <div className="flex flex-wrap gap-4">
              {list.map((e) => (
                <label key={e.id} className="inline-flex items-center gap-2 text-[13.5px]">
                  <Checkbox checked={!!pinned[e.id]} onCheckedChange={(v) => setPins({ ...pinned, [e.id]: !!v })} />
                  <EnvBadge slug={e.slug} kind={e.isMock ? 'mock' : e.kind} />
                  {e.kind === 'prod' ? <span className="text-xs text-muted-foreground">promote when ready</span> : null}
                </label>
              ))}
            </div>
          </fieldset>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GatedButton cap="overlays:write" type="submit" form="publish-form" disabled={!message.trim() || publish.isPending}>
            Publish v{next}
          </GatedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
