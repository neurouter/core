import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlertIcon } from 'lucide-react';
import type { ExposureMode } from '@/contract';
import { GatedButton, useGate } from '@/components/app/gated';
import { CopyButton } from '@/components/code/copy-button';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { FileManagedNote, Pill } from '@/components/status/status';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { ModeRecommendation } from '@/features/readiness/mode-recommendation';
import { opsToolsQuery, readinessQuery, serverQuery, useDeleteServer, useSetOpsTools, useUpdateServer } from '@/features/servers/queries';
import { formatNumber } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/servers/$serverId/settings')({
  component: ServerSettings,
});

const MODES: { value: ExposureMode; label: string; hint: string }[] = [
  { value: 'auto', label: 'Use the eval recommendation', hint: 'Follows the latest measured run.' },
  { value: 'tools', label: 'Tool mode', hint: 'Agents call one tool at a time.' },
  { value: 'code', label: 'Code mode', hint: 'Agents write a short Python script (run_script); inner calls are governed like direct calls.' },
  { value: 'both', label: 'Both', hint: 'Tools for lookups, code mode for multi-step tasks.' },
];

/** Server settings (spec §9.10): general, exposure, discovery, ops tools, public report, danger zone. */
function ServerSettings() {
  const { serverId } = Route.useParams();
  const navigate = useNavigate();
  const server = useQuery(serverQuery(serverId));
  const readiness = useQuery(readinessQuery(serverId));
  const ops = useQuery(opsToolsQuery(serverId));
  const update = useUpdateServer(serverId);
  const setOps = useSetOpsTools(serverId);
  const del = useDeleteServer(serverId);
  const gate = useGate('servers:write');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  if (server.isPending) return <PageSkeleton />;
  if (server.isError) return <ErrorState error={server.error} onRetry={() => void server.refetch()} />;
  const s = server.data;
  const fm = (f: string) => s.fileManagedFields.includes(f);
  const save = (body: Parameters<typeof update.mutate>[0], what: string) => update.mutate(body, { onSuccess: () => notifySuccess(`${what} saved`), onError: (e) => notifyError(e, `Could not save ${what.toLowerCase()}`) });
  const framingOff = ops.data?.items.some((o) => (o.name.endsWith('begin_task') || o.name.endsWith('end_task')) && !o.enabled);
  const badge = `![agent-ready](${s.publicReportUrl?.replace('/report', '/badge.svg') ?? ''})`;
  return (
    <div className="flex max-w-3xl flex-col gap-5">
      {s.config ? <FileManagedNote path={s.config.path} line={s.config.line} /> : null}
      <section aria-labelledby="gen-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 id="gen-title" className="text-base font-semibold">
          General
        </h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="s-name">Name</Label>
            <Input id="s-name" value={name ?? s.name} disabled={gate.disabled || fm('name')} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="s-slug">Slug</Label>
            <Input id="s-slug" value={s.slug} disabled className="font-mono" aria-describedby="s-slug-help" />
            <span id="s-slug-help" className="text-[12.5px] text-muted-foreground">
              Part of every MCP URL, so it cannot change.
            </span>
          </div>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="s-desc">Description</Label>
          <Textarea id="s-desc" rows={2} value={description ?? s.description} disabled={gate.disabled || fm('description')} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <GatedButton cap="servers:write" className="self-start" disabled={(name === null && description === null) || update.isPending || fm('name')} disabledReason={fm('name') ? 'Defined in neurouter.yaml' : null} onClick={() => save({ ...(name !== null ? { name } : {}), ...(description !== null ? { description } : {}) }, 'General settings')}>
          Save
        </GatedButton>
      </section>

      <section aria-labelledby="exp-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 id="exp-title" className="text-base font-semibold">
          Exposure mode
        </h2>
        {readiness.data?.recommendedMode ? <ModeRecommendation mode={readiness.data.recommendedMode} text={readiness.data.recommendation} compact /> : null}
        <div role="radiogroup" aria-label="Exposure mode" className="flex flex-col gap-2">
          {MODES.map((m) => (
            <label key={m.value} className="flex items-start gap-2.5 rounded-lg border p-3 has-[:checked]:border-primary has-[:checked]:bg-brand-muted">
              <input type="radio" name="exposure" className="mt-1 accent-[var(--primary)]" checked={s.exposure.mode === m.value} disabled={gate.disabled || fm('exposure')} onChange={() => save({ exposure: { mode: m.value } }, 'Exposure mode')} />
              <span className="flex flex-col">
                <span className="font-medium">{m.label}</span>
                <span className="text-[12.5px] text-muted-foreground">{m.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section aria-labelledby="disc-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 id="disc-title" className="text-base font-semibold">
          Discovery
        </h2>
        <label className="flex items-center gap-2.5 text-[13.5px]">
          <Switch checked={s.exposure.discovery !== 'full'} disabled={gate.disabled} onCheckedChange={(v) => save({ exposure: { discovery: v ? 'auto' : 'full' } }, 'Discovery')} />
          search_tools for long tool lists (pinned tools plus search)
        </label>
        <p className="text-[12.5px] text-muted-foreground">
          {s.exposure.pinned.length} operator-pinned tools: <span className="font-mono">{s.exposure.pinned.join(', ') || 'none'}</span>. The top 5 by usage are pinned too. Clients with native tool search get the full list.
        </p>
      </section>

      <section aria-labelledby="ops-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 id="ops-title" className="text-base font-semibold">
          Ops tools
        </h2>
        <p className="text-[12.5px] text-muted-foreground">Tools that let agents frame tasks and report what they could not do. They feed task success and the inbox.</p>
        {framingOff ? (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-[13.5px]">
            <TriangleAlertIcon aria-hidden="true" className="size-4 text-warning" /> Task success rate needs begin_task and end_task.
          </div>
        ) : null}
        <ul className="flex flex-col divide-y">
          {ops.data?.items.map((o) => (
            <li key={o.name} className="flex items-center gap-3 py-2.5">
              <Switch checked={o.enabled} disabled={gate.disabled || !o.toggleable} aria-label={`Enable ${o.name}`} onCheckedChange={(v) => setOps.mutate({ [o.name.replace(/^neurouter_/, '')]: v }, { onError: (e) => notifyError(e) })} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-mono text-[13px]">{o.name}</span>
                <span className="text-[12.5px] text-muted-foreground">{o.description}</span>
              </span>
              <Pill tone={o.visibility === 'pinned' ? 'brand' : 'muted'}>{o.visibility === 'pinned' ? 'Pinned' : o.visibility === 'hint' ? 'Hinted' : 'Discoverable'}</Pill>
              <span className="w-16 text-right text-xs text-muted-foreground tabular-nums">{formatNumber(o.calls7d)} / 7 d</span>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="pub-title" className="flex flex-col gap-3 rounded-xl border bg-card p-5">
        <h2 id="pub-title" className="text-base font-semibold">
          Public readiness report
        </h2>
        <label className="flex items-center gap-2.5 text-[13.5px]">
          <Switch checked={s.publicReport} disabled={gate.disabled} onCheckedChange={(v) => save({ publicReport: v }, 'Public report')} />
          Publish the latest measured score at a public URL with a badge
        </label>
        {s.publicReport && s.publicReportUrl ? (
          <div className="flex flex-col gap-2 text-[13px]">
            <span className="font-mono">{s.publicReportUrl}</span>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{badge}</code>
              <CopyButton value={badge} label="Copy badge Markdown" variant="outline" size="sm" />
            </div>
          </div>
        ) : null}
      </section>

      {!gate.disabled ? (
        <section aria-labelledby="danger-title" className="flex flex-col gap-2 rounded-xl border border-destructive/40 p-5">
          <h2 id="danger-title" className="text-base font-semibold text-destructive">
            Danger zone
          </h2>
          <p className="text-[13.5px] text-muted-foreground">Deleting the server removes its tools, environments, keys and history.</p>
          <GatedButton cap="servers:write" variant="destructive" className="self-start" disabled={s.managedBy === 'file'} disabledReason="Defined in neurouter.yaml" onClick={() => setConfirmDelete(true)}>
            Delete server
          </GatedButton>
        </section>
      ) : null}
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${s.name}?`}
        description="This cannot be undone."
        confirmLabel="Delete server"
        confirmText={s.slug}
        pending={del.isPending}
        onConfirm={() =>
          del.mutate(s.slug, {
            onSuccess: () => {
              notifySuccess(`${s.name} deleted`);
              void navigate({ to: '/servers' });
            },
            onError: (e) => notifyError(e),
          })
        }
      />
    </div>
  );
}
