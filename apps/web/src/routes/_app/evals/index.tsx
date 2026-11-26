import { useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { GaugeIcon, PlayIcon } from 'lucide-react';
import type { RowSelectionState } from '@tanstack/react-table';
import type { EvalRunRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton } from '@/components/app/gated';
import { runLabel } from '@/components/app/labels';
import { DataTable, type ColumnSpec } from '@/components/data-table/data-table';
import { EmptyState } from '@/components/feedback/states';
import { PageHeader } from '@/components/layout/page-header';
import { rememberedServer } from '@/components/layout/server-switcher';
import { ModeBadge, Pill } from '@/components/status/status';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { environmentsQuery } from '@/features/environments/queries';
import { runsQuery, suitesQuery, useCreateRun } from '@/features/evals/queries';
import { formatScoreDelta } from '@/features/readiness/score';
import { ScoreBadge } from '@/features/readiness/score-ring';
import { serversQuery } from '@/features/servers/queries';
import { availableModels } from '@/features/settings/models';
import { settingsQuery } from '@/features/settings/queries';
import { compactDuration } from '@/features/tasks/timeline';
import { useMe } from '@/hooks/use-me';
import { ApiError } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { notifySuccess } from '@/lib/notify';

const search = z.object({ server: z.string().optional().catch(undefined), new: z.coerce.string().optional().catch(undefined) });

export const Route = createFileRoute('/_app/evals/')({
  validateSearch: search,
  beforeLoad: guard(['evals:read']),
  staticData: { crumbs: ['Evals'] },
  component: EvalsPage,
});

const STATUS_TONE = { queued: 'muted', running: 'info', succeeded: 'ok', failed: 'err', cancelled: 'outline' } as const;
const TRIGGER = { console: 'Console', cli: 'CLI', ci: 'GitHub Action', suggestion_verify: 'Fix verify' } as const;

function EvalsPage() {
  const f = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const server = f.server ?? rememberedServer();
  const runs = useQuery(runsQuery(server ? { serverId: server } : {}));
  const [selected, setSelected] = useState<RowSelectionState>({});
  const picked = Object.keys(selected).filter((k) => selected[k]);
  const rows = runs.data?.items ?? [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const deltaOf = (r: EvalRunRow) => {
    const base = r.baseRunId ? byId.get(r.baseRunId) : undefined;
    return r.headline !== null && base?.headline != null ? r.headline - base.headline : null;
  };
  const columns: ColumnSpec<EvalRunRow>[] = [
    {
      id: 'run',
      header: 'Run',
      priority: 1,
      cell: (r) => (
        <Link to="/evals/runs/$runId" params={{ runId: r.id }} className="font-medium hover:underline">
          Run {runLabel(r)}
        </Link>
      ),
    },
    { id: 'started', header: 'Started', priority: 2, cell: (r) => <span className="text-[13px] text-muted-foreground">{formatRelative(r.createdAt)}</span> },
    { id: 'server', header: 'Server', cell: (r) => r.server.name },
    { id: 'suite', header: 'Suite', cell: (r) => <span className="text-[13px]">v{r.suite.version}</span> },
    { id: 'env', header: 'Target', cell: (r) => <span className="font-mono text-[13px]">{r.environment.slug}</span> },
    { id: 'models', header: 'Models', cell: (r) => <span className="text-[13px]">{r.models.join(', ')}</span> },
    { id: 'modes', header: 'Modes', cell: (r) => <ModeBadge mode={r.modes.length === 2 ? 'both' : (r.modes[0] ?? 'tool')} /> },
    { id: 'n', header: 'N', align: 'right', cell: (r) => <span className="tabular-nums">{r.repeats}</span> },
    {
      id: 'status',
      header: 'Status',
      priority: 1,
      cell: (r) =>
        r.status === 'running' ? (
          <div className="flex w-28 flex-col gap-1">
            <span className="text-xs">running {Math.round((r.progress.done / Math.max(1, r.progress.total)) * 100)}%</span>
            <Progress value={(r.progress.done / Math.max(1, r.progress.total)) * 100} aria-label={`Run ${runLabel(r)} progress`} />
          </div>
        ) : (
          <Pill tone={STATUS_TONE[r.status]}>{r.status}</Pill>
        ),
    },
    {
      id: 'score',
      header: 'Score',
      priority: 1,
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <ScoreBadge score={r.headline} />
          {deltaOf(r) !== null ? <span className={`text-xs font-semibold tabular-nums ${deltaOf(r)! > 0 ? 'text-success' : deltaOf(r)! < 0 ? 'text-destructive' : 'text-muted-foreground'}`}>{formatScoreDelta(deltaOf(r)!)}</span> : null}
        </span>
      ),
    },
    { id: 'trigger', header: 'Trigger', cell: (r) => <span className="text-[13px] text-muted-foreground">{TRIGGER[r.trigger]}</span> },
    { id: 'duration', header: 'Duration', align: 'right', cell: (r) => <span className="text-muted-foreground tabular-nums">{r.startedAt && r.endedAt ? compactDuration(Date.parse(r.endedAt) - Date.parse(r.startedAt)) : '—'}</span> },
  ];
  const canCompare = picked.length === 2 && byId.get(picked[0]!)?.server.id === byId.get(picked[1]!)?.server.id;
  const sorted = picked.map((id) => byId.get(id)!).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return (
    <>
      <PageHeader
        title="Evals"
        description="Generated tasks × models × tool and code mode, scored 0–100. Runs use your own OpenAI, Anthropic or Gemini key."
        actions={
          <>
            <Button variant="outline" disabled={!canCompare} render={canCompare ? <Link to="/evals/compare" search={{ base: sorted[0]!.id, head: sorted[1]!.id }} /> : undefined} nativeButton={!canCompare}>
              Compare {picked.length === 2 ? '' : '(select 2)'}
            </Button>
            <GatedButton cap="evals:run" onClick={() => void navigate({ search: (p) => ({ ...p, new: '1' }) })}>
              <PlayIcon /> New run
            </GatedButton>
          </>
        }
      />
      <DataTable
        label="Eval runs"
        columns={columns}
        rows={runs.data?.items}
        loading={runs.isPending}
        error={runs.error}
        onRetry={() => void runs.refetch()}
        getRowId={(r) => r.id}
        selection={{ selected, onChange: setSelected, rowLabel: (r) => `Run ${runLabel(r)}`, canSelect: (r) => r.status === 'succeeded' }}
        empty={<EmptyState icon={GaugeIcon} title="Run your first eval" description="Neurouter generates about 40 tasks from your spec and measures how agents do." action={<GatedButton cap="evals:run" onClick={() => void navigate({ search: (p) => ({ ...p, new: '1' }) })}>New run</GatedButton>} />}
      />
      <p className="text-[12.5px] text-muted-foreground">The open-source server keeps the last 50 runs per server.</p>
      {f.new ? <NewRunDialog defaultServer={server} onClose={() => void navigate({ search: (p) => ({ ...p, new: undefined }) })} /> : null}
    </>
  );
}

/** New run (spec §9.14, §17.2): suite version, target (prod refused), models, modes, repeats. */
function NewRunDialog({ defaultServer, onClose }: { defaultServer?: string | undefined; onClose: () => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const servers = useQuery(serversQuery());
  const [serverId, setServerId] = useState(defaultServer ?? '');
  const sid = serverId || servers.data?.items[0]?.id || '';
  const envs = useQuery({ ...environmentsQuery(sid), enabled: !!sid });
  const suites = useQuery({ ...suitesQuery(sid), enabled: !!sid });
  const settings = useQuery({ ...settingsQuery(), retry: false });
  const [env, setEnv] = useState('');
  const [suite, setSuite] = useState('');
  const [picked, setModels] = useState<string[] | null>(null);
  const [modes, setModes] = useState<('tool' | 'code')[]>(['tool', 'code']);
  const [repeats, setRepeats] = useState(3);
  const [error, setError] = useState<string | null>(null);
  const create = useCreateRun();
  const envList = envs.data?.items ?? [];
  const envId = env || envList.find((e) => e.isMock)?.id || '';
  const suiteList = suites.data?.items ?? [];
  const suiteId = suite || suiteList.find((s) => s.status === 'frozen')?.id || suiteList[0]?.id || '';
  const taskCount = suiteList.find((s) => s.id === suiteId)?.taskCount ?? 40;
  const MODEL_LIST = availableModels(settings.data);
  const models = picked ?? MODEL_LIST.slice(0, 1);
  const calls = taskCount * models.length * modes.length * repeats;
  if (!me.features.evals)
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>No model provider</DialogTitle>
          </DialogHeader>
          <Alert>
            <AlertTitle>Evals need a model provider key (OpenAI, Anthropic or Gemini)</AlertTitle>
            <AlertDescription>
              <Link to="/settings" search={{ tab: 'models' }} className="font-medium text-primary underline">
                Add it in Settings › Models
              </Link>
            </AlertDescription>
          </Alert>
        </DialogContent>
      </Dialog>
    );
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New eval run</DialogTitle>
          <DialogDescription>~{calls.toLocaleString()} model conversations on your own API key.</DialogDescription>
        </DialogHeader>
        <form
          id="new-run"
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            create.mutate(
              { serverId: sid, environmentId: envId, ...(suiteId ? { suiteId } : {}), models, modes, repeats },
              {
                onSuccess: (run) => {
                  notifySuccess('Eval run started');
                  void navigate({ to: '/evals/runs/$runId', params: { runId: run.id } });
                },
                onError: (err) => setError(err instanceof ApiError ? (err.detail ?? err.title) : 'Could not start the run'),
              },
            );
          }}
        >
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="nr-server">Server</Label>
            <select id="nr-server" className="h-9 rounded-lg border bg-background px-2 text-sm" value={sid} onChange={(e) => (setServerId(e.target.value), setEnv(''), setSuite(''))}>
              {servers.data?.items.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nr-suite">Suite</Label>
              <select id="nr-suite" className="h-9 rounded-lg border bg-background px-2 text-sm" value={suiteId} onChange={(e) => setSuite(e.target.value)}>
                {suiteList.map((s) => (
                  <option key={s.id} value={s.id}>
                    v{s.version} · {s.taskCount} tasks{s.status === 'frozen' ? ' (frozen)' : ''}
                  </option>
                ))}
                {!suiteList.length ? <option value="">Generate a new suite</option> : null}
              </select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="nr-env">Target environment</Label>
              <select id="nr-env" className="h-9 rounded-lg border bg-background px-2 text-sm" value={envId} onChange={(e) => setEnv(e.target.value)}>
                {envList.map((e) => (
                  <option key={e.id} value={e.id} disabled={e.kind === 'prod'}>
                    {e.slug}
                    {e.kind === 'prod' ? ' (evals never run against prod)' : e.isMock ? ' (built-in mock)' : ''}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Models</legend>
            <div className="flex flex-wrap gap-3">
              {MODEL_LIST.map((m) => (
                <label key={m} className="inline-flex items-center gap-1.5 font-mono text-[13px]">
                  <Checkbox checked={models.includes(m)} onCheckedChange={(v) => setModels(v ? [...models, m] : models.filter((x) => x !== m))} /> {m}
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="flex flex-col gap-1.5">
            <legend className="mb-1 text-sm font-medium">Modes</legend>
            <div className="flex gap-4">
              {(['tool', 'code'] as const).map((m) => (
                <label key={m} className="inline-flex items-center gap-1.5 text-[13.5px]">
                  <Checkbox checked={modes.includes(m)} onCheckedChange={(v) => setModes(v ? [...modes, m] : modes.filter((x) => x !== m))} /> {m === 'tool' ? 'Tool mode' : 'Code mode'}
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex items-center gap-2">
            <Label htmlFor="nr-n">Repetitions</Label>
            <select id="nr-n" className="h-9 rounded-lg border bg-background px-2 text-sm" value={repeats} onChange={(e) => setRepeats(Number(e.target.value))}>
              {[1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  N = {n}
                </option>
              ))}
            </select>
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
          <GatedButton cap="evals:run" type="submit" form="new-run" disabled={!models.length || !modes.length || !sid || create.isPending}>
            Start run
          </GatedButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
