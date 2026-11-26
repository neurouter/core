import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { DownloadIcon, LoaderCircleIcon, RefreshCwIcon } from 'lucide-react';
import { LLM_PROVIDER_KINDS, PROVIDER_ENV_KEYS, PROVIDER_LABELS, type KeyStatus, type KillSwitchRow, type LlmProviderKind } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton, useGate } from '@/components/app/gated';
import { ButtonTabs } from '@/components/app/link-tabs';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { Pill } from '@/components/status/status';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { configStatusQuery, killSwitchesQuery, settingsQuery, systemInfoQuery, useClearKillSwitch, useReloadConfig, useSetKillSwitch, useTestProvider, useTestTelemetry, useUpdateSettings, useUpdateUser, usersQuery } from '@/features/settings/queries';
import { modelGroups } from '@/features/settings/models';
import { useMe } from '@/hooks/use-me';
import { configExportUrl } from '@/lib/download';
import { formatBytes, formatDuration, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

const TABS = ['general', 'models', 'members', 'config', 'kill-switches', 'code-mode', 'retention', 'telemetry'] as const;
const LABEL: Record<(typeof TABS)[number], string> = { general: 'General', models: 'Models', members: 'Members', config: 'Config', 'kill-switches': 'Kill switches', 'code-mode': 'Code mode', retention: 'Retention', telemetry: 'Telemetry' };
const search = z.object({ tab: z.enum(TABS).optional().catch(undefined) });

export const Route = createFileRoute('/_app/settings/')({
  validateSearch: search,
  beforeLoad: guard(['settings:read']),
  staticData: { crumbs: ['Settings'] },
  component: SettingsPage,
});

/** Instance settings (spec §9.17). */
function SettingsPage() {
  const { tab = 'general' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const settings = useQuery(settingsQuery());
  return (
    <>
      <PageHeader title="Settings" description="Instance-wide settings. Fields set in neurouter.yaml are read-only here." actions={<Link to="/settings/appearance" className="text-[13px] text-primary hover:underline">Appearance</Link>} />
      <ButtonTabs label="Settings sections" value={tab} onChange={(v) => void navigate({ search: { tab: v }, replace: true })} tabs={TABS.map((t) => ({ value: t, label: LABEL[t] }))} />
      {settings.isError ? <ErrorState error={settings.error} onRetry={() => void settings.refetch()} /> : !settings.data ? <PageSkeleton /> : (
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex max-w-3xl flex-col gap-5">
          {tab === 'general' ? <General /> : null}
          {tab === 'models' ? <Models /> : null}
          {tab === 'members' ? <Members /> : null}
          {tab === 'config' ? <Config /> : null}
          {tab === 'kill-switches' ? <KillSwitches /> : null}
          {tab === 'code-mode' ? <CodeMode /> : null}
          {tab === 'retention' ? <Retention /> : null}
          {tab === 'telemetry' ? <Telemetry /> : null}
        </div>
      )}
    </>
  );
}

const card = 'flex flex-col gap-3 rounded-xl border bg-card p-5';

function General() {
  const s = useQuery(settingsQuery()).data!;
  const sys = useQuery(systemInfoQuery());
  const update = useUpdateSettings();
  const gate = useGate('settings:write');
  const [org, setOrg] = useState(s.general.orgName);
  return (
    <>
      <section className={card} aria-labelledby="g-title">
        <h2 id="g-title" className="text-base font-semibold">
          Instance
        </h2>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="g-org">Instance name</Label>
          <div className="flex gap-2">
            <Input id="g-org" value={org} disabled={gate.disabled} onChange={(e) => setOrg(e.target.value)} className="max-w-sm" />
            <GatedButton cap="settings:write" variant="outline" disabled={org === s.general.orgName} onClick={() => update.mutate({ general: { orgName: org } }, { onSuccess: () => notifySuccess('Saved'), onError: (e) => notifyError(e) })}>
              Save
            </GatedButton>
          </div>
        </div>
        <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-[13.5px]">
          <dt className="text-muted-foreground">Public URL</dt>
          <dd className="font-mono">
            {s.general.publicUrl} {s.fileManaged.includes('general.publicUrl') ? <Pill tone="outline">neurouter.yaml</Pill> : null}
          </dd>
          <dt className="text-muted-foreground">Version</dt>
          <dd>
            {sys.data ? `${sys.data.version} (${sys.data.commit ?? 'dev'}) · Node ${sys.data.nodeVersion} · ${sys.data.db.dialect}` : '…'}
          </dd>
          <dt className="text-muted-foreground">MCP protocol</dt>
          <dd>{sys.data?.protocolVersions.join(', ') ?? '…'}</dd>
        </dl>
        <a href={configExportUrl()} download="neurouter.yaml" className="inline-flex items-center gap-1.5 self-start text-[13.5px] text-primary hover:underline">
          <DownloadIcon aria-hidden="true" className="size-4" /> Download effective config (YAML, secrets as references)
        </a>
      </section>
    </>
  );
}

const KEY_PLACEHOLDER: Record<LlmProviderKind, string> = { openai: 'sk-…', anthropic: 'sk-ant-…', gemini: 'AIza…' };

function ProviderKey({ kind, status }: { kind: LlmProviderKind; status: KeyStatus }) {
  const update = useUpdateSettings();
  const test = useTestProvider();
  const gate = useGate('settings:write');
  const [key, setKey] = useState('');
  const label = PROVIDER_LABELS[kind];
  return (
    <li className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0" aria-label={`${label} key`}>
      <div className="flex flex-wrap items-center gap-2 text-[13.5px]">
        <span className="w-20 font-medium">{label}</span>
        {status.configured ? <Pill tone="ok">Configured · {status.source === 'env' ? `from ${PROVIDER_ENV_KEYS[kind]}` : 'stored'} · …{status.last4}</Pill> : <Pill tone="muted">No key</Pill>}
        <GatedButton cap="settings:write" variant="outline" size="sm" disabled={!status.configured || test.isPending} onClick={() => test.mutate(`${kind}-${status.source ?? 'stored'}`, { onSuccess: (r) => (r.ok ? notifySuccess(`${r.model} answered in ${formatDuration(r.latencyMs)}`) : notifyError(new Error(r.error ?? 'Failed'), 'Test failed')), onError: (e) => notifyError(e) })}>
          {test.isPending ? <LoaderCircleIcon className="animate-spin" /> : null} Test
        </GatedButton>
      </div>
      {status.source !== 'env' ? (
        <div className="flex gap-2">
          <Input type="password" aria-label={`${label} API key`} autoComplete="off" placeholder={status.configured ? 'Replace the key' : KEY_PLACEHOLDER[kind]} value={key} disabled={gate.disabled} onChange={(e) => setKey(e.target.value)} className="max-w-sm" />
          <GatedButton cap="settings:write" disabled={key.length < 8} onClick={() => update.mutate({ models: { apiKeys: { [kind]: { value: key } } } }, { onSuccess: () => (setKey(''), notifySuccess(`${label} key saved`)), onError: (e) => notifyError(e) })}>
            Save key
          </GatedButton>
          {status.configured ? (
            <GatedButton cap="settings:write" variant="ghost" onClick={() => update.mutate({ models: { apiKeys: { [kind]: { clear: true } } } })}>
              Remove
            </GatedButton>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Models() {
  const s = useQuery(settingsQuery()).data!;
  const update = useUpdateSettings();
  const gate = useGate('settings:write');
  const keys = s.models.keys;
  const select = (id: string, field: 'evalModel' | 'judgeModel' | 'generatorModel', label: string) => (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <select id={id} className="h-9 rounded-lg border bg-background px-2 font-mono text-sm" disabled={gate.disabled} value={s.models[field]} onChange={(e) => update.mutate({ models: { [field]: e.target.value } }, { onError: (err) => notifyError(err) })}>
        {modelGroups(s.models[field]).map((g) => (
          <optgroup key={g.kind ?? 'other'} label={g.kind ? `${PROVIDER_LABELS[g.kind]}${keys[g.kind].configured ? '' : ' (no key)'}` : 'Other'}>
            {g.models.map((m) => (
              <option key={m}>{m}</option>
            ))}
          </optgroup>
        ))}
      </select>
    </div>
  );
  return (
    <section className={card} aria-labelledby="m-title">
      <h2 id="m-title" className="text-base font-semibold">
        Model providers
      </h2>
      <p className="text-[13px] text-muted-foreground">
        Evals run on your own keys. Each model goes to its provider (gpt-* → OpenAI, claude-* → Anthropic, gemini-* → Gemini). Keys are write-only: Neurouter shows only their source and last four characters; an environment variable wins over a stored key.
      </p>
      <ul className="divide-y">
        {LLM_PROVIDER_KINDS.map((k) => (
          <ProviderKey key={k} kind={k} status={keys[k]} />
        ))}
      </ul>
      <div className="grid gap-3 sm:grid-cols-3">
        {select('m-eval', 'evalModel', 'Eval model')}
        {select('m-judge', 'judgeModel', 'Judge model')}
        {select('m-gen', 'generatorModel', 'Task generator')}
      </div>
    </section>
  );
}

function Members() {
  const users = useQuery(usersQuery());
  const update = useUpdateUser();
  const gate = useGate('settings:write');
  const me = useMe();
  return (
    <section className="overflow-hidden rounded-xl border bg-card" aria-labelledby="mem-title">
      <h2 id="mem-title" className="px-5 pt-4 pb-2 text-base font-semibold">
        Members
      </h2>
      <p className="px-5 pb-3 text-[13px] text-muted-foreground">Admins change everything; Viewers see everything read-only. The last admin cannot be demoted.</p>
      <ul className="divide-y border-t">
        {users.data?.items.map((u) => (
          <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-2.5 text-[13.5px]">
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="font-medium">
                {u.name} {u.id === me.user.id ? <span className="text-xs text-muted-foreground">(you)</span> : null}
              </span>
              <span className="text-xs text-muted-foreground">
                {u.email} · {u.roleSource} · last sign-in {formatRelative(u.lastLoginAt)}
              </span>
            </span>
            <select aria-label={`Role of ${u.name}`} className="h-8 rounded-lg border bg-background px-2 text-[13px]" disabled={gate.disabled} value={u.role} onChange={(e) => update.mutate({ id: u.id, role: e.target.value as 'admin' | 'viewer' }, { onSuccess: () => notifySuccess('Role changed'), onError: (err) => notifyError(err, 'Could not change the role') })}>
              <option value="admin">Admin</option>
              <option value="viewer">Viewer</option>
            </select>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Config() {
  const cfg = useQuery(configStatusQuery());
  const reload = useReloadConfig();
  const c = cfg.data;
  return (
    <section className={card} aria-labelledby="c-title">
      <h2 id="c-title" className="text-base font-semibold">
        neurouter.yaml
      </h2>
      {c ? (
        <>
          <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-[13.5px]">
            <dt className="text-muted-foreground">Mode</dt>
            <dd>{c.mode === 'hybrid' ? 'Hybrid: the file wins for what it defines' : c.mode === 'file' ? 'File only' : 'Console only'}</dd>
            <dt className="text-muted-foreground">Path</dt>
            <dd className="font-mono">{c.path ?? '—'}</dd>
            <dt className="text-muted-foreground">Applied</dt>
            <dd>
              {formatRelative(c.appliedAt)} · hash <span className="font-mono">{c.hash}</span>
            </dd>
            <dt className="text-muted-foreground">Manages</dt>
            <dd>
              {c.managed.servers} servers, {c.managed.environments} environments
            </dd>
          </dl>
          {c.diagnostics.map((d, i) => (
            <p key={i} className="text-[13px]">
              <Pill tone={d.severity === 'error' ? 'err' : 'muted'}>{d.severity}</Pill> {d.message}
              {d.line ? ` (line ${d.line})` : ''}
            </p>
          ))}
          <div className="flex gap-2">
            <GatedButton cap="settings:write" variant="outline" disabled={reload.isPending} onClick={() => reload.mutate(undefined, { onSuccess: () => notifySuccess('neurouter.yaml reloaded'), onError: (e) => notifyError(e, 'Reload failed') })}>
              <RefreshCwIcon /> Reload neurouter.yaml
            </GatedButton>
            <a href={configExportUrl()} download="neurouter.yaml" className="inline-flex items-center gap-1.5 text-[13.5px] text-primary hover:underline">
              <DownloadIcon aria-hidden="true" className="size-4" /> Export
            </a>
          </div>
        </>
      ) : (
        <PageSkeleton />
      )}
    </section>
  );
}

function KillSwitches() {
  const ks = useQuery(killSwitchesQuery());
  const set = useSetKillSwitch();
  const clear = useClearKillSwitch();
  const gate = useGate('settings:write');
  const [reason, setReason] = useState('');
  const [kind, setKind] = useState<KillSwitchRow['kind']>('code_mode');
  return (
    <section className={card} aria-labelledby="k-title">
      <h2 id="k-title" className="text-base font-semibold">
        Kill switches
      </h2>
      <p className="text-[13px] text-muted-foreground">Stop code mode, writes or everything, instantly, with a reason. They apply on the next call.</p>
      <ul className="flex flex-col divide-y">
        {ks.data?.items.map((k) => (
          <li key={`${k.scope}-${k.target}-${k.kind}`} className="flex flex-wrap items-center gap-2 py-2.5 text-[13.5px]">
            <Pill tone="err">{k.kind.replace('_', ' ')} off</Pill>
            <span className="font-mono">
              {k.scope}: {k.target}
            </span>
            <span className="flex-1 text-muted-foreground">
              “{k.reason}” · {k.createdBy?.name ?? 'neurouter.yaml'} · {formatRelative(k.createdAt)}
            </span>
            <GatedButton cap="settings:write" variant="outline" size="xs" onClick={() => clear.mutate({ scope: k.scope, target: k.target, kind: k.kind }, { onSuccess: () => notifySuccess('Kill switch cleared') })}>
              Clear
            </GatedButton>
          </li>
        ))}
        {ks.data && !ks.data.items.length ? <li className="py-2 text-[13.5px] text-muted-foreground">No kill switch is set.</li> : null}
      </ul>
      <form
        className="flex flex-wrap items-end gap-2 border-t pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          set.mutate({ scope: 'global', target: '*', kind, reason }, { onSuccess: () => (setReason(''), notifySuccess('Kill switch set')), onError: (err) => notifyError(err) });
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="k-kind">Stop</Label>
          <select id="k-kind" className="h-9 rounded-lg border bg-background px-2 text-sm" value={kind} disabled={gate.disabled} onChange={(e) => setKind(e.target.value as KillSwitchRow['kind'])}>
            <option value="code_mode">Code mode, everywhere</option>
            <option value="writes">Writes, everywhere</option>
            <option value="all">All tool calls, everywhere</option>
          </select>
        </div>
        <div className="flex min-w-56 flex-1 flex-col gap-1.5">
          <Label htmlFor="k-reason">Reason</Label>
          <Input id="k-reason" required value={reason} disabled={gate.disabled} onChange={(e) => setReason(e.target.value)} placeholder="Investigating INC-1234" />
        </div>
        <GatedButton cap="settings:write" type="submit" variant="destructive" disabled={!reason}>
          Set kill switch
        </GatedButton>
      </form>
    </section>
  );
}

function CodeMode() {
  const s = useQuery(settingsQuery()).data!;
  const update = useUpdateSettings();
  const gate = useGate('settings:write');
  const d = s.codeMode.defaults;
  const ex = s.codeMode.executor;
  return (
    <section className={card} aria-labelledby="cm-title">
      <h2 id="cm-title" className="text-base font-semibold">
        Code mode
      </h2>
      <label className="flex items-center gap-2.5 text-[13.5px]">
        <Switch checked={s.codeMode.enabled} disabled={gate.disabled} onCheckedChange={(v) => update.mutate({ codeMode: { enabled: v } }, { onSuccess: () => notifySuccess(v ? 'Code mode on' : 'Code mode off everywhere') })} /> Code mode on (global kill switch when off)
      </label>
      <p className="text-[13.5px]">
        Default limits per script: {d.maxToolCalls} tool calls · {d.wallTimeSec} s wall · {d.cpuTimeSec} s CPU · {d.maxMemoryMb} MB · {d.maxConcurrentCalls} concurrent calls · {formatBytes(d.maxResultBytes)} result. Environments can lower them.
      </p>
      <p className="text-[13.5px]">
        Executor: <Pill tone={ex.ok ? 'ok' : 'err'}>{ex.ok ? 'healthy' : 'unavailable'}</Pill> {ex.mode} · Monty {ex.montyVersion ?? '—'} · {ex.busy} of {ex.poolMax} workers busy
      </p>
    </section>
  );
}

function Retention() {
  const s = useQuery(settingsQuery()).data!;
  const update = useUpdateSettings();
  const gate = useGate('settings:write');
  const [tasks, setTasks] = useState(String(s.retention.taskDays));
  const [audit, setAudit] = useState(String(s.retention.auditDays));
  return (
    <section className={card} aria-labelledby="r-title">
      <h2 id="r-title" className="text-base font-semibold">
        Retention
      </h2>
      <div className="flex flex-wrap gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="r-tasks">Tasks and traces (days)</Label>
          <Input id="r-tasks" inputMode="numeric" className="w-28" value={tasks} disabled={gate.disabled} onChange={(e) => setTasks(e.target.value.replace(/\D/g, ''))} />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="r-audit">Audit log (days)</Label>
          <Input id="r-audit" inputMode="numeric" className="w-28" value={audit} disabled={gate.disabled} onChange={(e) => setAudit(e.target.value.replace(/\D/g, ''))} />
        </div>
      </div>
      <p className="text-[13px] text-muted-foreground">Eval runs: the last 50 per server. Longer history is part of Neurouter Cloud.</p>
      <GatedButton cap="settings:write" className="self-start" onClick={() => update.mutate({ retention: { taskDays: Number(tasks), auditDays: Number(audit) } }, { onSuccess: () => notifySuccess('Retention saved'), onError: (e) => notifyError(e) })}>
        Save
      </GatedButton>
    </section>
  );
}

function Telemetry() {
  const s = useQuery(settingsQuery()).data!;
  const test = useTestTelemetry();
  return (
    <section className={card} aria-labelledby="t-title">
      <h2 id="t-title" className="text-base font-semibold">
        Telemetry
      </h2>
      <dl className="grid grid-cols-[10rem_1fr] gap-y-1.5 text-[13.5px]">
        <dt className="text-muted-foreground">OpenTelemetry</dt>
        <dd>{s.telemetry.otelEnabled ? 'on' : 'off'}</dd>
        <dt className="text-muted-foreground">OTLP endpoint</dt>
        <dd className="font-mono">{s.telemetry.otlpEndpoint ?? '—'}</dd>
        <dt className="text-muted-foreground">Prometheus /metrics</dt>
        <dd>{s.telemetry.metricsEnabled ? 'on' : 'off'}</dd>
      </dl>
      <p className="text-[12.5px] text-muted-foreground">Set in neurouter.yaml or the environment; read-only here.</p>
      <GatedButton cap="settings:write" demoOp="telemetry.test" variant="outline" className="self-start" disabled={test.isPending} onClick={() => test.mutate(undefined, { onSuccess: (r) => (r.ok ? notifySuccess('Test span sent', r.detail) : notifyError(new Error(r.detail), 'Telemetry test failed')) })}>
        Send a test span
      </GatedButton>
    </section>
  );
}
