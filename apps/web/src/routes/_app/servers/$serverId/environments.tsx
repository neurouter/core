import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { LoaderCircleIcon, PlusIcon } from 'lucide-react';
import type { EnvironmentDetail, UpstreamAuthIn, WriteSwitchMatrix } from '@/contract';
import { GatedButton, WithReason, useGate } from '@/components/app/gated';
import { ConfirmDialog } from '@/components/feedback/confirm-dialog';
import { ErrorState } from '@/components/feedback/states';
import { EnvBadge, FileManagedNote, HealthText, Pill } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { environmentsQuery, needsProdConfirm, useCreateEnvironment, useDeleteEnvironment, useSetSecret, useSetToolWrite, useSetWrites, useTestEnvironment, useUpdateEnvironment, writeSwitchesQuery } from '@/features/environments/queries';
import { envBadgeKind } from '@/features/servers/env-summary';
import { ApiError } from '@/lib/api-client';
import { formatDuration, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/utils';

const search = z.object({ env: z.string().optional().catch(undefined) });

export const Route = createFileRoute('/_app/servers/$serverId/environments')({
  validateSearch: search,
  component: EnvironmentsPage,
});

/** "API key · env:ACME_DEV_TOKEN", "OAuth passthrough (user token)", … (never a secret value). */
export function credentialLabel(e: Pick<EnvironmentDetail, 'auth' | 'isMock'>): string {
  const a = e.auth;
  if (e.isMock) return 'none (simulated data)';
  switch (a.type) {
    case 'none':
      return 'None';
    case 'header':
      return `API key · ${a.secretRef}`;
    case 'bearer':
      return `Bearer · ${a.secretRef}`;
    case 'query':
      return `Query key · ${a.secretRef}`;
    case 'basic':
      return `Basic · ${a.username} · ${a.secretRef}`;
    case 'oauth_client_credentials':
      return `Service account · ${a.clientSecretRef}`;
    case 'oauth_passthrough':
      return 'OAuth passthrough (user token)';
  }
}

function EnvironmentsPage() {
  const { serverId } = Route.useParams();
  const { env: open } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const envs = useQuery(environmentsQuery(serverId));
  const [adding, setAdding] = useState(false);
  const addGate = useGate('environments:write');
  if (envs.isError) return <ErrorState error={envs.error} onRetry={() => void envs.refetch()} />;
  const list = envs.data?.items ?? [];
  const selected = list.find((e) => e.slug === open);
  return (
    <div className="flex flex-col gap-5">
      <p className="text-muted-foreground">One server definition, several places to run it. Every agent key is bound to exactly one environment.</p>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {!envs.data ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-48 rounded-xl" />) : null}
        {list.map((e) => (
          <button
            key={e.id}
            type="button"
            onClick={() => void navigate({ search: { env: e.slug } })}
            className="flex min-w-0 flex-col gap-2 rounded-xl border bg-card p-4 text-left outline-none hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`${e.slug} environment: edit`}
          >
            <div className="flex items-center gap-2">
              <EnvBadge slug={e.slug} kind={envBadgeKind(e)} />
              {e.managedBy === 'file' ? <Pill tone="outline">neurouter.yaml</Pill> : null}
              <span className="flex-1" />
              <HealthText status={e.health.status} latencyMs={e.health.latencyMs} />
            </div>
            <span className="text-[12.5px] text-muted-foreground">Base URL</span>
            <span className="font-mono text-xs [overflow-wrap:anywhere]">{e.isMock ? 'built-in · used by evals' : e.baseUrl}</span>
            <span className="text-[12.5px] text-muted-foreground">Credentials</span>
            <span className="font-mono text-xs">{credentialLabel(e)}</span>
            {e.health.status === 'down' && e.health.error ? <span className="text-xs text-destructive">{e.health.error}</span> : null}
            <span className="border-t pt-2 text-[12.5px] text-muted-foreground">
              Checked {formatRelative(e.health.checkedAt)} · overlay {e.build?.overlayRev ? `v${e.build.overlayRev}` : '—'} · code mode {e.codeMode ? 'on' : 'off'}
            </span>
          </button>
        ))}
        {envs.data ? (
          <WithReason reason={addGate.reason}>
            <button type="button" disabled={addGate.disabled} onClick={() => setAdding(true)} className="flex min-h-40 flex-col items-center justify-center gap-1 rounded-xl border border-dashed text-[13.5px] text-primary hover:bg-brand-muted disabled:opacity-50">
              <PlusIcon aria-hidden="true" className="size-4" /> Add environment
            </button>
          </WithReason>
        ) : null}
      </div>
      <WriteSwitches serverId={serverId} envs={list} />
      <EnvironmentSheet serverId={serverId} env={selected ?? null} onClose={() => void navigate({ search: {} })} />
      <AddEnvironmentDialog serverId={serverId} open={adding} onClose={() => setAdding(false)} taken={list.map((e) => e.slug)} />
    </div>
  );
}

/* ================================================================== write switches */

function WriteSwitches({ serverId, envs }: { serverId: string; envs: EnvironmentDetail[] }) {
  const matrix = useQuery(writeSwitchesQuery(serverId));
  const setCell = useSetToolWrite(serverId);
  const setWrites = useSetWrites(serverId);
  const gate = useGate('writes:enable');
  const [confirm, setConfirm] = useState<{ tool: string; env: WriteSwitchMatrix['environments'][number] } | null>(null);
  const flip = (tool: string, env: WriteSwitchMatrix['environments'][number], enabled: boolean) => {
    if (needsProdConfirm(env, enabled)) return setConfirm({ tool, env });
    setCell.mutate({ env, toolName: tool, enabled }, { onError: (e) => notifyError(e, 'Could not change the write switch') });
  };
  const m = matrix.data;
  const devLike = m?.environments.filter((e) => e.kind !== 'prod' && !envs.find((x) => x.id === e.id)?.isMock) ?? [];
  return (
    <section aria-labelledby="writes-title" className="overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-5 py-4">
        <h2 id="writes-title" className="text-base font-semibold">
          Write switches
        </h2>
        <span className="flex-1 text-[13px] text-muted-foreground">Read-only by default. Prod writes always need confirmation at call time.</span>
        {devLike.map((e) => (
          <GatedButton key={e.id} cap="writes:enable" variant="outline" size="sm" disabled={setWrites.isPending} onClick={() => setWrites.mutate({ id: e.id, enabled: true }, { onSuccess: () => notifySuccess(`All writes on in ${e.slug}`), onError: (err) => notifyError(err) })}>
            Enable all writes in {e.slug}
          </GatedButton>
        ))}
      </div>
      {!m ? (
        <Skeleton className="mx-5 mb-4 h-40" />
      ) : !m.tools.length ? (
        <p className="px-5 pb-4 text-[13.5px] text-muted-foreground">This server has no write tools.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-[13.5px]">
            <caption className="sr-only">Write tools by environment</caption>
            <thead>
              <tr className="bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="px-5 py-2 font-medium">Write tool</th>
                {m.environments.map((e) => (
                  <th key={e.id} scope="col" className="px-2 py-2 text-center font-medium">
                    {e.slug}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {m.tools.map((t) => (
                <tr key={t.name} className="border-t">
                  <th scope="row" className="px-5 py-2 text-left font-mono text-[13px] font-normal">
                    {t.name} {t.destructive ? <Pill tone="err">destructive</Pill> : null}
                  </th>
                  {m.environments.map((e) => {
                    const mock = envs.find((x) => x.id === e.id)?.isMock;
                    const on = mock ? true : !!t.cells[e.slug];
                    const fileManaged = e.managedBy === 'file';
                    const reason = mock ? 'The mock environment simulates writes' : fileManaged ? 'Defined in neurouter.yaml' : gate.reason;
                    return (
                      <td key={e.id} className="px-2 py-2 text-center">
                        <WithReason reason={reason}>
                          <Switch checked={on} disabled={!!reason || setCell.isPending} aria-label={`${t.name} in ${e.slug}`} onCheckedChange={(v) => flip(t.name, e, v)} />
                        </WithReason>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirm ? (
        <ProdWriteConfirmDialog
          tool={confirm.tool}
          env={confirm.env}
          host={envs.find((x) => x.id === confirm.env.id)?.baseUrl ?? ''}
          pending={setCell.isPending}
          onCancel={() => setConfirm(null)}
          onConfirm={(slug) =>
            setCell.mutate(
              { env: confirm.env, toolName: confirm.tool, enabled: true, confirmSlug: slug },
              {
                onSuccess: () => {
                  notifySuccess(`${confirm.tool} enabled in ${confirm.env.slug}`);
                  setConfirm(null);
                },
                onError: (e) => notifyError(e, 'Could not enable the write'),
              },
            )
          }
        />
      ) : null}
    </section>
  );
}

/** Prod write confirmation (spec §9.8): the user must type the environment slug. */
export function ProdWriteConfirmDialog({ tool, env, host, onCancel, onConfirm, pending }: { tool: string; env: { slug: string }; host: string; onCancel: () => void; onConfirm: (typed: string) => void; pending?: boolean }) {
  const [typed, setTyped] = useState('');
  const [touched, setTouched] = useState(false);
  const ok = typed === env.slug;
  return (
    <Dialog open onOpenChange={(o) => !o && onCancel()}>
      <DialogContent className="sm:max-w-[480px]">
        <DialogHeader>
          <DialogTitle>
            Enable <span className="font-mono">{tool}</span> in {env.slug}?
          </DialogTitle>
          <DialogDescription>
            Agents with {env.slug} keys will be able to call this write tool against <span className="font-mono">{host.replace(/^https?:\/\//, '')}</span>. Each call still asks the user to confirm in their client, and every call is audited.
          </DialogDescription>
        </DialogHeader>
        <form
          id="prod-confirm"
          onSubmit={(e) => {
            e.preventDefault();
            setTouched(true);
            if (ok) onConfirm(typed);
          }}
          className="flex flex-col gap-1.5"
        >
          <Label htmlFor="prod-typed">
            Type <span className="rounded bg-env-prod-muted px-1 font-mono text-env-prod">{env.slug}</span> to confirm
          </Label>
          <Input id="prod-typed" autoComplete="off" placeholder={env.slug} value={typed} onChange={(e) => setTyped(e.target.value)} className="font-mono" aria-invalid={touched && !ok ? true : undefined} aria-describedby="prod-typed-error" />
          <span id="prod-typed-error" role="alert" className="min-h-4 text-xs text-destructive">
            {touched && !ok ? `Type ${env.slug} exactly to enable the write.` : ''}
          </span>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" form="prod-confirm" disabled={pending} className="bg-env-prod text-white hover:bg-env-prod/90">
            Enable in {env.slug}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ================================================================== environment sheet */

type AuthKind = 'none' | 'header' | 'bearer' | 'oauth_passthrough';
const AUTH_LABEL: Record<AuthKind, string> = { none: 'None', header: 'API key header', bearer: 'Bearer token', oauth_passthrough: "OAuth passthrough (the user's own token)" };

function EnvironmentSheet({ serverId, env, onClose }: { serverId: string; env: EnvironmentDetail | null; onClose: () => void }) {
  return (
    <Sheet open={!!env} onOpenChange={(o) => !o && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">{env ? <EnvironmentForm key={env.id} serverId={serverId} env={env} onClose={onClose} /> : null}</SheetContent>
    </Sheet>
  );
}

function EnvironmentForm({ serverId, env, onClose }: { serverId: string; env: EnvironmentDetail; onClose: () => void }) {
  const update = useUpdateEnvironment(serverId);
  const test = useTestEnvironment();
  const del = useDeleteEnvironment(serverId);
  const secret = useSetSecret(serverId);
  const gate = useGate('environments:write');
  const fileManaged = env.managedBy === 'file';
  const locked = gate.disabled || fileManaged || env.isMock;
  const a = env.auth;
  const [baseUrl, setBaseUrl] = useState(env.baseUrl);
  const [authType, setAuthType] = useState<AuthKind>(a.type === 'header' || a.type === 'bearer' || a.type === 'oauth_passthrough' ? a.type : 'none');
  const [headerName, setHeaderName] = useState(a.type === 'header' ? a.headerName : 'X-Api-Key');
  const [ref, setRef] = useState('secretRef' in a ? a.secretRef : '');
  const [secretValue, setSecretValue] = useState('');
  const [rate, setRate] = useState(String(env.limits.rateLimit.perMinute));
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refOk = authType === 'none' || authType === 'oauth_passthrough' || /^(env:[A-Za-z_][A-Za-z0-9_]{0,127}|secret:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.test(ref);
  const auth = (): UpstreamAuthIn => (authType === 'none' ? { type: 'none' } : authType === 'bearer' ? { type: 'bearer', secretRef: ref } : authType === 'header' ? { type: 'header', headerName, secretRef: ref } : { type: 'oauth_passthrough', mode: 'broker', scopes: [] });
  const save = () => {
    setError(null);
    if (!refOk) return setError('The credential must be a reference: env:NAME or secret:NAME.');
    update.mutate(
      { id: env.id, body: { baseUrl, auth: auth(), limits: { rateLimit: { perMinute: Number(rate) || env.limits.rateLimit.perMinute, burst: env.limits.rateLimit.burst } } } },
      { onSuccess: () => notifySuccess(`${env.slug} saved`), onError: (e) => setError(e instanceof ApiError ? (e.detail ?? e.title) : 'Could not save') },
    );
  };
  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <EnvBadge slug={env.slug} kind={envBadgeKind(env)} /> environment
        </SheetTitle>
        <SheetDescription>
          MCP URL <span className="font-mono">{env.mcpUrl}</span>
        </SheetDescription>
      </SheetHeader>
      <div className="flex flex-col gap-4 px-4 pb-6">
        {fileManaged && env.config ? <FileManagedNote path={env.config.path} line={env.config.line} yaml={`environments:\n  ${env.slug}:\n    baseUrl: ${env.baseUrl}`} /> : null}
        {env.isMock ? <p className="text-[13.5px] text-muted-foreground">The built-in mock serves seeded fake data generated from the spec. Evals run here by default.</p> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="env-base">Base URL</Label>
          <Input id="env-base" value={baseUrl} disabled={locked} onChange={(e) => setBaseUrl(e.target.value)} className="font-mono" />
        </div>
        {!env.isMock ? (
          <fieldset className="flex flex-col gap-2" disabled={locked}>
            <legend className="mb-1 text-sm font-medium">Authentication</legend>
            {(Object.keys(AUTH_LABEL) as AuthKind[]).map((k) => (
              <label key={k} className="inline-flex items-center gap-2 text-[13.5px]">
                <input type="radio" name="env-auth" checked={authType === k} onChange={() => setAuthType(k)} className="accent-[var(--primary)]" />
                {AUTH_LABEL[k]}
              </label>
            ))}
            {a.type === 'oauth_client_credentials' ? <p className="text-[12.5px] text-muted-foreground">Currently a service account ({a.clientId}); edit it in neurouter.yaml.</p> : null}
          </fieldset>
        ) : null}
        {authType === 'header' && !env.isMock ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="env-hn">Header name</Label>
            <Input id="env-hn" value={headerName} disabled={locked} onChange={(e) => setHeaderName(e.target.value)} className="font-mono" />
          </div>
        ) : null}
        {(authType === 'header' || authType === 'bearer') && !env.isMock ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="env-ref2">Credential reference</Label>
            <Input id="env-ref2" value={ref} disabled={locked} onChange={(e) => setRef(e.target.value.trim())} placeholder="env:ACME_DEV_TOKEN" className="font-mono" aria-invalid={!refOk ? true : undefined} />
            <p className="text-[12.5px] text-muted-foreground">
              <code>env:NAME</code> reads the server's environment. Or store a secret below; it becomes <code>secret:NAME</code>. Values are write-only and never shown again.
            </p>
            <div className="flex gap-2">
              <Input type="password" aria-label="Secret value" placeholder="Paste a secret to store it" value={secretValue} disabled={locked} onChange={(e) => setSecretValue(e.target.value)} autoComplete="off" />
              <GatedButton
                cap="environments:write"
                variant="outline"
                disabled={!secretValue || locked}
                onClick={() => {
                  const name = `${env.serverId.replace(/^srv_/, '').toUpperCase()}_${env.slug.toUpperCase()}_TOKEN`.replace(/[^A-Za-z0-9._-]/g, '_');
                  secret.mutate(
                    { id: env.id, name, value: secretValue },
                    {
                      onSuccess: (r) => {
                        setRef(r.ref);
                        setSecretValue('');
                        notifySuccess('Secret stored', `Referenced as ${r.ref}`);
                      },
                      onError: (e) => notifyError(e),
                    },
                  );
                }}
              >
                Store a secret
              </GatedButton>
            </div>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="env-rate">Calls per minute (per key)</Label>
          <Input id="env-rate" inputMode="numeric" value={rate} disabled={locked} onChange={(e) => setRate(e.target.value.replace(/\D/g, ''))} className="w-32" />
          <p className="text-[12.5px] text-muted-foreground">
            Code mode: {env.limits.code.maxToolCalls} calls · {env.limits.code.wallTimeSec} s wall · {env.limits.code.cpuTimeSec} s CPU · {env.limits.code.maxMemoryMb} MB per script.
          </p>
        </div>
        {error ? (
          <p role="alert" className="text-[13.5px] text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {!env.isMock ? (
            <GatedButton cap="environments:write" disabled={locked || update.isPending} disabledReason={fileManaged ? 'Defined in neurouter.yaml' : null} onClick={save}>
              Save
            </GatedButton>
          ) : null}
          <GatedButton cap="environments:read" demoOp="environments.test" variant="outline" disabled={test.isPending} onClick={() => test.mutate(env.id)}>
            {test.isPending ? <LoaderCircleIcon className="animate-spin" /> : null} Test connection
          </GatedButton>
          {test.data ? (
            <span role="status" className={cn('text-[13px]', test.data.ok ? 'text-success' : 'text-destructive')}>
              {test.data.ok ? `OK in ${formatDuration(test.data.latencyMs)}` : 'Failed'}
              {test.data.detail ? ` · ${test.data.detail}` : ''}
            </span>
          ) : null}
        </div>
        {!env.builtin && !fileManaged && !gate.disabled ? (
          <div className="mt-4 flex flex-col gap-2 rounded-xl border border-destructive/40 p-3">
            <span className="text-sm font-semibold text-destructive">Danger zone</span>
            <span className="text-[13px] text-muted-foreground">Deleting an environment invalidates its MCP URL. Keys bound to it must be revoked first.</span>
            <Button variant="destructive" size="sm" className="self-start" onClick={() => setConfirmDelete(true)}>
              Delete {env.slug}
            </Button>
          </div>
        ) : null}
      </div>
      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${env.slug}?`}
        description="Agents using this environment lose access."
        confirmLabel="Delete environment"
        confirmText={env.slug}
        pending={del.isPending}
        onConfirm={() =>
          del.mutate(env, {
            onSuccess: () => {
              notifySuccess(`${env.slug} deleted`);
              setConfirmDelete(false);
              onClose();
            },
            onError: (e) => {
              setConfirmDelete(false);
              notifyError(e, 'Could not delete the environment');
            },
          })
        }
      />
    </>
  );
}

function AddEnvironmentDialog({ serverId, open, onClose, taken }: { serverId: string; open: boolean; onClose: () => void; taken: string[] }) {
  const create = useCreateEnvironment(serverId);
  const preset = (['dev', 'qa', 'prod'] as const).find((k) => !taken.includes(k)) ?? 'dev';
  const [slug, setSlug] = useState<string>(preset);
  const [kind, setKind] = useState<'dev' | 'qa' | 'prod'>(preset);
  const [baseUrl, setBaseUrl] = useState('');
  const [ref, setRef] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add an environment</DialogTitle>
          <DialogDescription>New environments are read-only: write tools stay off until you enable them.</DialogDescription>
        </DialogHeader>
        <form
          id="add-env"
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate(
              { slug, kind, baseUrl, auth: ref ? { type: 'bearer', secretRef: ref } : { type: 'none' } },
              {
                onSuccess: (env) => {
                  notifySuccess(`${env.slug} created`);
                  onClose();
                },
                onError: (err) => setError(err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.detail ?? err.title) : 'Could not create'),
              },
            );
          }}
        >
          <div className="flex gap-2">
            {(['dev', 'qa', 'prod'] as const).map((k) => (
              <Button key={k} type="button" size="sm" variant={kind === k ? 'default' : 'outline'} onClick={() => (setKind(k), setSlug(k))}>
                {k}
              </Button>
            ))}
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-slug">Name</Label>
            <Input id="ae-slug" value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} className="font-mono" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-url">Base URL</Label>
            <Input id="ae-url" type="url" required value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://qa.api.example.com" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="ae-ref">Bearer token reference (optional)</Label>
            <Input id="ae-ref" value={ref} onChange={(e) => setRef(e.target.value.trim())} placeholder="env:QA_TOKEN" className="font-mono" />
          </div>
          {error ? (
            <p role="alert" className="text-[13.5px] text-destructive">
              {error}
            </p>
          ) : null}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <GatedButton cap="environments:write" type="submit" form="add-env" disabled={!baseUrl || create.isPending}>
            Add environment
          </GatedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
