import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { DownloadIcon, RefreshCwIcon } from 'lucide-react';
import { api, type SpecChangeSummary as Summary } from '@/contract';
import { GatedButton } from '@/components/app/gated';
import { keyName } from '@/components/app/labels';
import { FileDrop } from '@/components/code/file-drop';
import { ErrorState } from '@/components/feedback/states';
import { EnvBadge, Pill, specFormatLabel } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { environmentsQuery, usePinBuild } from '@/features/environments/queries';
import { buildsQuery, serverQuery, specQuery, specsQuery } from '@/features/servers/queries';
import { apiFetch } from '@/lib/api-client';
import { specDownloadUrl } from '@/lib/download';
import { formatBytes, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const search = z.object({ reimport: z.coerce.string().optional().catch(undefined), rev: z.string().optional().catch(undefined) });

export const Route = createFileRoute('/_app/servers/$serverId/spec')({
  validateSearch: search,
  component: SpecPage,
});

/** Groups a change summary into the three lists the dialog shows (spec §14 unit test). */
export function summarize(s: Summary): { label: string; tone: 'ok' | 'err' | 'warn'; items: string[] }[] {
  return [
    { label: `Added (${s.added.length})`, tone: 'ok' as const, items: s.added.map((o) => `${o.method ?? ''} ${o.path ?? keyName(o.key)}`.trim()) },
    { label: `Removed (${s.removed.length})`, tone: 'err' as const, items: s.removed.map((o) => `${o.method ?? ''} ${o.path ?? keyName(o.key)}`.trim()) },
    { label: `Changed (${s.changed.length})`, tone: 'warn' as const, items: s.changed.map((c) => `${c.op.method ?? ''} ${c.op.path ?? keyName(c.op.key)}: ${c.fields.join(', ')}`.trim()) },
  ];
}

export function SpecChangeSummary({ summary }: { summary: Summary }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-3">
        {summarize(summary).map((g) => (
          <section key={g.label} className="rounded-xl border p-3">
            <h3 className="mb-1.5">
              <Pill tone={g.tone}>{g.label}</Pill>
            </h3>
            <ul className="flex flex-col gap-1 font-mono text-[12.5px]">
              {g.items.map((i) => (
                <li key={i}>{i}</li>
              ))}
              {!g.items.length ? <li className="font-sans text-muted-foreground">None</li> : null}
            </ul>
          </section>
        ))}
      </div>
      {summary.orphanedOverlayKeys.length ? (
        <div role="note" className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-[13.5px]">
          <strong>{summary.orphanedOverlayKeys.length} overlay entries are orphaned</strong> (their operation disappeared): <span className="font-mono">{summary.orphanedOverlayKeys.map(keyName).join(', ')}</span>. Remove or remap them on the Overlay tab.
        </div>
      ) : null}
    </div>
  );
}

function SpecPage() {
  const { serverId } = Route.useParams();
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const server = useQuery(serverQuery(serverId));
  const specs = useQuery(specsQuery(serverId));
  const builds = useQuery(buildsQuery(serverId));
  const current = specs.data?.items[0];
  const selected = s.rev ?? current?.id;
  const detail = useQuery({ ...specQuery(selected ?? ''), enabled: !!selected });
  if (specs.isError) return <ErrorState error={specs.error} onRetry={() => void specs.refetch()} />;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        <p className="flex-1 text-[13.5px] text-muted-foreground">
          {server.data?.specSource.url ? <>Source <span className="font-mono">{server.data.specSource.url}</span></> : server.data?.specSource.path ? <>Source file <span className="font-mono">{server.data.specSource.path}</span> (neurouter.yaml)</> : 'Uploaded spec'}
        </p>
        {current ? (
          <Button variant="outline" render={<a href={specDownloadUrl(current.id)} download />} nativeButton={false}>
            <DownloadIcon /> Download spec
          </Button>
        ) : null}
        <GatedButton cap="servers:write" onClick={() => void navigate({ search: (p) => ({ ...p, reimport: '1' }) })}>
          <RefreshCwIcon /> Re-import
        </GatedButton>
      </div>
      <section aria-labelledby="revs-title" className="overflow-hidden rounded-xl border bg-card">
        <h2 id="revs-title" className="px-4 py-3 text-base font-semibold">
          Spec versions
        </h2>
        <div className="overflow-x-auto">
          <table className="w-full text-[13.5px]">
            <thead>
              <tr className="bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="px-4 py-2 font-medium">Version</th>
                <th scope="col" className="px-2 py-2 font-medium">Format</th>
                <th scope="col" className="px-2 py-2 text-right font-medium">Operations</th>
                <th scope="col" className="px-2 py-2 font-medium">Imported</th>
                <th scope="col" className="px-4 py-2 font-medium">Size</th>
              </tr>
            </thead>
            <tbody>
              {specs.data?.items.map((r) => (
                <tr key={r.id} className={`border-t ${r.id === selected ? 'bg-brand-muted' : ''}`}>
                  <td className="px-4 py-2.5">
                    <button type="button" className="font-medium text-primary hover:underline" onClick={() => void navigate({ search: (p) => ({ ...p, rev: r.id }) })} aria-pressed={r.id === selected}>
                      v{r.rev}
                    </button>{' '}
                    <span className="text-muted-foreground">{r.apiVersion ? `API ${r.apiVersion}` : ''}</span>
                  </td>
                  <td className="px-2 py-2.5">{specFormatLabel(r.format)}</td>
                  <td className="px-2 py-2.5 text-right tabular-nums">{r.operationCount}</td>
                  <td className="px-2 py-2.5 text-muted-foreground">
                    {formatRelative(r.createdAt)} by {r.createdBy?.name ?? 'neurouter.yaml'}
                  </td>
                  <td className="px-4 py-2.5 text-muted-foreground">{formatBytes(r.contentBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section aria-labelledby="change-title" className="flex flex-col gap-2">
        <h2 id="change-title" className="text-base font-semibold">
          Changes in {detail.data ? `v${detail.data.rev}` : 'this version'}
        </h2>
        {detail.data ? <SpecChangeSummary summary={detail.data.summary} /> : <Skeleton className="h-24" />}
      </section>
      <section aria-labelledby="builds-title" className="overflow-hidden rounded-xl border bg-card">
        <h2 id="builds-title" className="px-4 py-3 text-base font-semibold">
          Builds
        </h2>
        <ul className="divide-y">
          {builds.data?.items.map((b) => (
            <li key={b.id} className="flex flex-wrap items-center gap-2.5 px-4 py-2.5 text-[13.5px]">
              <span className="font-mono text-xs">{b.hash.slice(0, 8)}</span>
              <span>
                spec v{b.specRev} · overlay v{b.overlayRev ?? '–'}
              </span>
              <span className="text-muted-foreground">
                {b.visibleCount} visible · {b.writeCount} write · lint {b.lintScore}
              </span>
              <span className="flex-1" />
              {b.environments.map((e) => (
                <EnvBadge key={e} slug={e} />
              ))}
            </li>
          ))}
        </ul>
      </section>
      {s.reimport ? <ReimportDialog serverId={serverId} onClose={() => void navigate({ search: (p) => ({ ...p, reimport: undefined }) })} /> : null}
    </div>
  );
}

/**
 * Re-import (spec §17.2): the backend commits a new revision + build and keeps environments on
 * their old build, so the summary is shown after the job, with "Pin new build to dev".
 */
function ReimportDialog({ serverId, onClose }: { serverId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const envs = useQuery(environmentsQuery(serverId));
  const pin = usePinBuild(serverId);
  const reimport = useMutation({
    mutationFn: () => apiFetch(api.specs.reimport, { params: { id: serverId }, body: file ? { source: { content: file.content, filename: file.name } } : url ? { source: { url } } : {} }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['servers', 'detail', serverId] }),
    onError: (e) => notifyError(e, 'Could not re-import'),
  });
  const specs = useQuery({ ...specsQuery(serverId), enabled: reimport.isSuccess });
  const latest = specs.data?.items[0];
  const detail = useQuery({ ...specQuery(latest?.id ?? ''), enabled: !!latest && reimport.isSuccess });
  const builds = useQuery({ ...buildsQuery(serverId), enabled: reimport.isSuccess });
  const dev = envs.data?.items.find((e) => e.kind === 'dev' && !e.isMock);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Re-import the spec</DialogTitle>
          <DialogDescription>Your overlay is preserved. Environments stay on their current build until you pin the new one.</DialogDescription>
        </DialogHeader>
        {!reimport.isSuccess ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="ri-url">New URL (leave empty to refetch the stored URL)</Label>
              <Input id="ri-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…/openapi.yaml" />
            </div>
            <FileDrop accept=".yaml,.yml,.json,.graphql,.gql" maxBytes={10 * 1024 * 1024} file={file} onFile={setFile} onError={setError} />
            {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
          </div>
        ) : detail.data ? (
          <div className="flex flex-col gap-3">
            <p className="text-[13.5px]">
              Spec v{detail.data.rev} imported. {detail.data.summary.orphanedOverlayKeys.length ? `${detail.data.summary.orphanedOverlayKeys.length} overlay entries are orphaned; the rest still apply.` : 'Every overlay entry still applies.'}
            </p>
            <SpecChangeSummary summary={detail.data.summary} />
          </div>
        ) : (
          <Skeleton className="h-32" />
        )}
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {reimport.isSuccess ? 'Close' : 'Cancel'}
          </Button>
          {!reimport.isSuccess ? (
            <GatedButton cap="servers:write" disabled={reimport.isPending} onClick={() => reimport.mutate()}>
              Re-import
            </GatedButton>
          ) : dev && builds.data?.items[0] ? (
            <GatedButton
              cap="environments:write"
              disabled={pin.isPending}
              onClick={() =>
                pin.mutate(
                  { id: dev.id, buildId: builds.data!.items[0]!.id },
                  {
                    onSuccess: () => {
                      notifySuccess(`New build pinned to ${dev.slug}`);
                      onClose();
                    },
                    onError: (e) => notifyError(e),
                  },
                )
              }
            >
              Pin new build to {dev.slug}
            </GatedButton>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
