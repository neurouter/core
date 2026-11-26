import { useRef, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { CircleIcon, ListTreeIcon, XIcon } from 'lucide-react';
import type { TimelineItem } from '@/contract';
import { guard } from '@/app/route-guards';
import { ButtonTabs } from '@/components/app/link-tabs';
import { EmptyState, ErrorState, PageSkeleton } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { PageHeader } from '@/components/layout/page-header';
import { DecisionBadge, EnvBadge, OutcomeBadge, Pill } from '@/components/status/status';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { settingsQuery } from '@/features/settings/queries';
import { CallPanel, DecisionDetail, ScriptBlock } from '@/features/tasks/components';
import { callQuery, taskQuery } from '@/features/tasks/queries';
import { buildRows, compactDuration, decisions, writeCalls } from '@/features/tasks/timeline';
import { useMinWidth } from '@/hooks/use-min-width';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatNumber, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';

const search = z.object({ call: z.string().optional().catch(undefined), rail: z.enum(['decisions', 'writes', 'related']).optional().catch(undefined) });

export const Route = createFileRoute('/_app/tasks/$taskId')({
  validateSearch: search,
  beforeLoad: guard(['tasks:read']),
  component: TaskPage,
});

const FRAMING = { explicit: 'Framed by agent', script: 'Script run', inferred: 'Inferred' } as const;

/** Task detail (spec §9.12, prototype Task): header, identity chain, timeline, right rail, call drawer. */
function TaskPage() {
  const { taskId } = Route.useParams();
  const { call, rail = 'decisions' } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const wide = useMinWidth(1280);
  const task = useQuery(taskQuery(taskId));
  const settings = useQuery({ ...settingsQuery(), retry: false });
  const lastTrigger = useRef<HTMLElement | null>(null);
  const [, force] = useState(0);
  useSetCrumbs([{ label: 'Tasks', to: '/tasks' }, { label: task.data?.goal ?? task.data?.inferredLabel?.goal ?? taskId }]);
  if (task.isPending) return <PageSkeleton />;
  if (task.isError) {
    if (task.error instanceof ApiError && (task.error.status === 404 || task.error.status === 410)) return <EmptyState icon={ListTreeIcon} title={task.error.status === 410 ? 'Removed by the 30-day retention' : 'Task not found'} description={task.error.detail} action={<Link to="/tasks" className="text-primary hover:underline">All tasks</Link>} />;
    return <ErrorState error={task.error} onRetry={() => void task.refetch()} />;
  }
  const t = task.data;
  const rows = buildRows(t.timeline, t.startedAt);
  const writes = writeCalls(t.timeline);
  const decs = decisions(t.timeline);
  const limits = settings.data?.codeMode.defaults;
  const open = (auditId: string, el: HTMLElement) => {
    lastTrigger.current = el;
    void navigate({ search: (p) => ({ ...p, call: auditId }), replace: true });
  };
  const close = () => {
    void navigate({ search: (p) => ({ ...p, call: undefined }), replace: true });
    // return focus to the item that opened the drawer (spec §11)
    setTimeout(() => lastTrigger.current?.focus(), 0);
    force((n) => n + 1);
  };
  const scripts = t.timeline.filter((i) => i.kind === 'script');
  const followUpOf = (i: TimelineItem) => (i.dryRun ? scripts.find((x) => !x.dryRun && Date.parse(x.ts) > Date.parse(i.ts)) : null);
  const goal = t.goal ?? t.inferredLabel?.goal ?? 'Inferred task';
  const railBody = (
    <RailSections rail={wide ? null : rail} decs={decs} writes={writes} task={t} onCall={open} />
  );
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <PageHeader
          title={goal}
          leading={null}
          description={
            <span className="flex flex-wrap items-center gap-2">
              <OutcomeBadge outcome={t.outcome} status={t.status} framing={t.framing} />
              <Pill tone="muted">{t.framing === 'inferred' ? `Inferred from ${t.callCount} calls over ${compactDuration(t.durationMs)}` : FRAMING[t.framing]}</Pill>
              {t.status === 'open' ? (
                <span className="inline-flex items-center gap-1 text-xs text-info">
                  <CircleIcon aria-hidden="true" className="size-2 animate-pulse fill-current" /> live
                </span>
              ) : null}
              {t.origin === 'eval' ? <Pill tone="outline">eval traffic</Pill> : null}
            </span>
          }
        />
        <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[13px] text-muted-foreground" aria-label="Who and where">
          <span>
            Key <span className="font-mono text-foreground">{t.principal.name}</span>
          </span>
          <span>{t.client.name ?? 'unknown client'}</span>
          <span className="inline-flex items-center gap-1">
            {t.server.name} · <EnvBadge slug={t.environment.slug} kind={t.environment.kind} />
          </span>
          <span>
            {formatDateTime(t.startedAt)} · {compactDuration(t.durationMs)}
          </span>
          <span>
            {formatNumber(t.callCount)} calls · {t.scriptCount} {t.scriptCount === 1 ? 'script' : 'scripts'} · {t.errorCount} errors
          </span>
        </div>
        {t.notes ? <p className="text-[13.5px]">“{t.notes}”</p> : null}
      </div>
      {!wide ? (
        <ButtonTabs
          label="Task sections"
          value={rail}
          onChange={(v) => void navigate({ search: (p) => ({ ...p, rail: v }), replace: true })}
          tabs={[
            { value: 'decisions', label: 'Decisions', count: decs.length },
            { value: 'writes', label: 'Writes', count: writes.length },
            { value: 'related', label: 'Related' },
          ]}
        />
      ) : null}
      {!wide ? <div className="flex flex-col gap-3">{railBody}</div> : null}
      <div className="flex flex-wrap items-start gap-5">
        <ol aria-label="Task timeline" className="flex min-w-0 flex-[999_1_640px] flex-col gap-3">
          {t.truncated ? <li className="text-[13px] text-warning">Timeline truncated: showing the first items only.</li> : null}
          {rows.map((r) =>
            r.type === 'gap' ? (
              <li key={r.id} className="flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                idle {compactDuration(r.ms)}
                <span className="h-px flex-1 bg-border" />
              </li>
            ) : (
              <li key={r.item.id} className="flex items-start gap-3">
                <span className="w-[58px] shrink-0 pt-0.5 font-mono text-xs text-muted-foreground" title={`+${compactDuration(r.offsetMs)} from the start`}>
                  {formatTime(r.item.ts)}
                </span>
                <TimelineEntry item={r.item} latencyPct={r.latencyPct} onCall={open} limits={limits} followUp={followUpOf(r.item)} active={call === r.item.auditId} evalTraffic={t.origin === 'eval'} />
              </li>
            ),
          )}
        </ol>
        {wide ? (
          <aside aria-label="Task details" className="flex min-w-[260px] flex-[1_1_300px] flex-col gap-3.5">
            {call ? (
              <section aria-labelledby="call-title" className="flex flex-col gap-2.5 rounded-xl border border-brand-border bg-card p-4">
                <div className="flex items-center">
                  <h2 id="call-title" className="flex-1 font-mono text-[15px] font-semibold">
                    Call details
                  </h2>
                  <button type="button" onClick={close} aria-label="Close call details" className="rounded p-1 text-muted-foreground hover:bg-muted">
                    <XIcon className="size-4" />
                  </button>
                </div>
                <CallPanel auditId={call} />
              </section>
            ) : null}
            {railBody}
          </aside>
        ) : null}
      </div>
      {!wide ? (
        <Sheet open={!!call} onOpenChange={(o) => !o && close()}>
          <SheetContent className="w-full overflow-y-auto sm:max-w-md">
            <SheetHeader>
              <SheetTitle>Call details</SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-6">{call ? <CallPanel auditId={call} /> : null}</div>
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function TimelineEntry({ item, latencyPct, onCall, limits, followUp, active, evalTraffic }: { item: TimelineItem; latencyPct: number; onCall: (id: string, el: HTMLElement) => void; limits?: { maxToolCalls: number; cpuTimeSec: number } | undefined; followUp: TimelineItem | null | undefined; active: boolean; evalTraffic: boolean }) {
  if (item.kind === 'script') return <ScriptBlock item={item} limits={limits} onCall={onCall} followUp={followUp ?? null} />;
  const box = 'flex-1 rounded-[10px] border px-3.5 py-2.5';
  if (item.kind === 'task_begin')
    return (
      <div className={box}>
        <span className="font-mono text-[13px] font-medium">{item.tool ?? 'neurouter_begin_task'}</span>
        <span className="text-muted-foreground"> · goal: “{item.summary}”</span>
      </div>
    );
  if (item.kind === 'task_end')
    return (
      <div className={cn(box, item.summary === 'success' ? 'border-success/30 bg-success-muted' : item.summary === 'failure' ? 'border-destructive/30 bg-destructive-muted' : '')}>
        <span className="font-mono text-[13px] font-medium">{item.tool ?? 'neurouter_end_task'}</span> · <strong className={item.summary === 'success' ? 'text-success' : ''}>{item.summary}</strong>
        {item.auditId ? <EndNote auditId={item.auditId} /> : null}
      </div>
    );
  if (item.kind === 'decision')
    return (
      <div className={cn(box, 'flex flex-col gap-1')}>
        <span>
          <span className="font-mono text-[13px] font-medium">{item.tool ?? 'neurouter_log_decision'}</span> · “{item.summary}”
        </span>
        {item.auditId ? <DecisionDetail auditId={item.auditId} /> : null}
      </div>
    );
  if (item.kind === 'unmet_need' || item.kind === 'issue' || item.kind === 'ops')
    return (
      <div className={cn(box, 'border-brand-border bg-brand-muted')}>
        <span className="font-mono text-[13px] font-medium">{item.tool}</span> · {item.summary}{' '}
        {item.kind !== 'ops' && evalTraffic ? <span className="text-xs text-muted-foreground">(eval traffic: not sent to the inbox)</span> : null}
        {item.kind !== 'ops' && !evalTraffic ? (
          <Link to="/inbox" search={{ tab: item.kind === 'issue' ? 'issues' : 'needs' }} className="text-primary hover:underline">
            Open in inbox
          </Link>
        ) : null}
      </div>
    );
  const blocked = item.decision?.startsWith('denied_');
  return (
    <button
      type="button"
      onClick={(e) => item.auditId && onCall(item.auditId, e.currentTarget)}
      aria-pressed={active}
      className={cn(box, 'flex flex-col gap-1.5 text-left outline-none hover:border-primary/60 focus-visible:ring-2 focus-visible:ring-ring', active && 'border-brand-border bg-brand-muted', blocked && 'border-destructive/30')}
    >
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-[13px] font-medium">{item.tool}</span>
        {item.decision ? <DecisionBadge decision={item.decision} /> : null}
        {item.write ? <Pill tone="warn">write</Pill> : null}
        <span className="text-[13px] text-muted-foreground">{item.summary}</span>
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">{compactDuration(item.durationMs)}</span>
      </span>
      <span aria-hidden="true" className="h-1 overflow-hidden rounded-full bg-muted">
        <span className={cn('block h-full rounded-full', blocked ? 'bg-destructive' : 'bg-mode-tool')} style={{ width: `${Math.max(2, latencyPct)}%` }} />
      </span>
    </button>
  );
}

function EndNote({ auditId }: { auditId: string }) {
  const call = useQuery(callQuery(auditId));
  const notes = (call.data?.arguments as { notes?: string } | undefined)?.notes;
  return notes ? <span> · “{notes}”</span> : null;
}

function RailSections({ rail, decs, writes, task, onCall }: { rail: 'decisions' | 'writes' | 'related' | null; decs: TimelineItem[]; writes: TimelineItem[]; task: { unmetNeeds: { id: string; groupId: string; intent: string }[]; issues: { id: string; problem: string }[]; evalRunId: string | null }; onCall: (id: string, el: HTMLElement) => void }) {
  const show = (r: 'decisions' | 'writes' | 'related') => rail === null || rail === r;
  const card = 'flex flex-col gap-1.5 rounded-xl border bg-card px-4 py-3.5';
  return (
    <>
      {show('decisions') ? (
        <section className={card} aria-label="Decisions">
          <span className="font-semibold">Decisions ({decs.length})</span>
          {decs.map((d) => (
            <span key={d.id} className="text-[13px]">
              {d.summary}
            </span>
          ))}
          {!decs.length ? <span className="text-[13px] text-muted-foreground">The agent logged no decisions.</span> : null}
        </section>
      ) : null}
      {show('writes') ? (
        <section className={card} aria-label="Writes">
          <span className="font-semibold">Writes ({writes.length})</span>
          {writes.length ? (
            <>
              <span className="text-[13px]">
                {Object.entries(writes.reduce<Record<string, number>>((a, w) => ({ ...a, [w.tool ?? '']: (a[w.tool ?? ''] ?? 0) + 1 }), {}))
                  .map(([tool, n]) => `${tool} × ${n}`)
                  .join(', ')}{' '}
                · all audited
              </span>
              <ul className="flex flex-col gap-1">
                {writes.slice(0, 3).map((w) => (
                  <li key={w.id}>
                    <button type="button" className="flex items-center gap-2 text-[12.5px] hover:underline" onClick={(e) => w.auditId && onCall(w.auditId, e.currentTarget)}>
                      <span className="font-mono">{w.tool}</span>
                      {w.decision ? <DecisionBadge decision={w.decision} /> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <span className="text-[13px] text-muted-foreground">No writes.</span>
          )}
        </section>
      ) : null}
      {show('related') ? (
        <section className={card} aria-label="Related">
          <span className="font-semibold">Related</span>
          {task.unmetNeeds.map((n) => (
            <Link key={n.id} to="/inbox/needs/$groupId" params={{ groupId: n.groupId }} className="text-[13px] text-primary hover:underline">
              Unmet need: {n.intent}
            </Link>
          ))}
          {task.issues.map((i) => (
            <Link key={i.id} to="/inbox/issues/$issueId" params={{ issueId: i.id }} className="text-[13px] text-primary hover:underline">
              Issue: {i.problem}
            </Link>
          ))}
          {task.evalRunId ? (
            <Link to="/evals/runs/$runId" params={{ runId: task.evalRunId }} className="text-[13px] text-primary hover:underline">
              From an eval run
            </Link>
          ) : null}
          {!task.unmetNeeds.length && !task.issues.length && !task.evalRunId ? <span className="text-[13px] text-muted-foreground">No unmet needs or issues reported.</span> : null}
        </section>
      ) : null}
    </>
  );
}
