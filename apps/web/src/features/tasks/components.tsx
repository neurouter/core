import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CheckIcon, MinusIcon, XIcon } from 'lucide-react';
import type { CallDetail, PlannedChange, PolicyStep, ScriptRunDetail, TimelineItem } from '@/contract';
import { CodeView } from '@/components/code/code-view';
import { CopyableMono } from '@/components/code/copy-button';
import { JsonViewer } from '@/components/code/json-viewer';
import { ErrorState } from '@/components/feedback/states';
import { DecisionBadge, EnvBadge, Pill } from '@/components/status/status';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDuration, formatTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { callQuery, scriptQuery } from './queries';
import { compactDuration } from './timeline';

/* ================================================================== policy trail */

const STEP_LABEL: Record<PolicyStep['step'], string> = {
  resolve: 'Resolve tool',
  kill_switch: 'Kill switch',
  acl: 'ACL',
  read_only: 'Read-only guard',
  arguments: 'Arguments',
  policy: 'Policy',
  rate_limit: 'Rate limit',
  dry_run: 'Dry run',
  confirm: 'User confirmation',
  routing: 'Routing',
  upstream: 'Upstream',
  response: 'Response shaping',
  audit: 'Audit',
};

/** Policy trail (spec §9.12): one row per pipeline step, pass / fail / skip in words and icons. */
export function PolicyTrail({ steps, showSkipped = false }: { steps: PolicyStep[]; showSkipped?: boolean }) {
  const shown = showSkipped ? steps : steps.filter((s) => s.result !== 'skip' || s.step === 'dry_run');
  return (
    <ol aria-label="Policy trail" className="flex flex-col gap-1 text-[13px]">
      {shown.map((s) => (
        <li key={s.step} className="flex gap-2">
          {s.result === 'pass' ? <CheckIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-success" /> : s.result === 'fail' ? <XIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-destructive" /> : <MinusIcon aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />}
          <span className={cn(s.result === 'skip' && 'text-muted-foreground', s.result === 'fail' && 'font-medium text-destructive')}>
            <span className="sr-only">{s.result === 'pass' ? 'passed' : s.result === 'fail' ? 'failed' : 'skipped'}: </span>
            {STEP_LABEL[s.step]}
            {s.detail ? `: ${s.detail}` : ''}
          </span>
        </li>
      ))}
    </ol>
  );
}

/* ================================================================== call detail */

/** Call drawer content (spec §9.12): arguments, the shaped result, the policy trail and trace ids. */
export function CallDetailView({ call }: { call: CallDetail }) {
  const [all, setAll] = useState(false);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <DecisionBadge decision={call.decision} />
        {call.environment ? <EnvBadge slug={call.environment.slug} kind={call.environment.kind} /> : null}
        <span className="text-xs text-muted-foreground">
          {formatTime(call.ts)} · {formatDuration(call.latencyMs)} · {call.via === 'script' ? 'inside a script' : 'direct call'}
        </span>
      </div>
      {call.error ? (
        <div className="rounded-lg border border-destructive/40 bg-destructive-muted p-2.5 text-[13px]">
          <strong>{call.error.title}</strong> <span className="font-mono text-xs">{call.errorId}</span>
          <p className="mt-1">The agent was told: {call.error.explanation}</p>
        </div>
      ) : null}
      <span className="text-[12.5px] text-muted-foreground">Arguments</span>
      <JsonViewer value={call.arguments} label="Arguments" />
      <span className="text-[12.5px] text-muted-foreground">Result (shaped, as the agent saw it)</span>
      {call.outputPreview === null ? <span className="text-[13px] text-muted-foreground">{call.dryRun ? 'Not executed (dry run).' : 'No result.'}</span> : <JsonViewer value={call.outputPreview} label="Result" collapseAfter={20} />}
      <div className="flex items-center">
        <span className="flex-1 text-[12.5px] text-muted-foreground">Policy trail</span>
        <button type="button" className="text-xs text-primary hover:underline" onClick={() => setAll(!all)} aria-pressed={all}>
          {all ? 'Hide skipped steps' : 'Show all 13 steps'}
        </button>
      </div>
      <PolicyTrail steps={call.policyTrail} showSkipped={all} />
      <div className="flex flex-col gap-1 border-t pt-2 text-[12.5px]">
        {call.traceId ? (
          <span className="flex items-center gap-2">
            <span className="w-14 text-muted-foreground">Trace</span>
            <CopyableMono value={call.traceId} display={`${call.traceId.slice(0, 12)}…`} ariaLabel="Copy the OpenTelemetry trace id" />
          </span>
        ) : null}
        {call.spanId ? (
          <span className="flex items-center gap-2">
            <span className="w-14 text-muted-foreground">Span</span>
            <CopyableMono value={call.spanId} ariaLabel="Copy the span id" />
          </span>
        ) : null}
        <span className="flex items-center gap-2">
          <span className="w-14 text-muted-foreground">Audit</span>
          <Link to="/audit" search={{ event: call.auditId }} className="font-mono text-primary hover:underline">
            {call.auditId}
          </Link>
        </span>
      </div>
    </div>
  );
}

export function CallPanel({ auditId }: { auditId: string }) {
  const call = useQuery(callQuery(auditId));
  if (call.isError) return <ErrorState error={call.error} onRetry={() => void call.refetch()} />;
  if (!call.data) return <Skeleton className="h-64" />;
  return <CallDetailView call={call.data} />;
}

/* ================================================================== script block */

export function PlannedChangesTable({ changes, limit = 4 }: { changes: PlannedChange[]; limit?: number }) {
  const [open, setOpen] = useState(false);
  const shown = open ? changes : changes.slice(0, limit);
  return (
    <div className="border-t">
      <div className="flex items-center px-3.5 py-2.5">
        <span className="flex-1 font-semibold">Planned changes ({changes.length})</span>
        <Pill tone="warn">not executed</Pill>
      </div>
      <table className="w-full text-[12.5px]">
        <caption className="sr-only">Writes the script planned in dry-run mode; none was executed</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Tool</th>
            <th scope="col">Target</th>
            <th scope="col">Arguments</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((c, i) => {
            const target = Object.values(c.arguments)[0];
            const rest = Object.entries(c.arguments).slice(1);
            return (
              <tr key={i} className="border-t border-border/60">
                <td className="px-3.5 py-1.5 font-mono">{c.tool}</td>
                <td className="px-1.5 py-1.5 font-mono">{String(target ?? '')}</td>
                <td className="px-3.5 py-1.5 text-muted-foreground">
                  {rest.map(([, v]) => `“${String(v)}”`).join(' ')}
                  {c.wouldConfirm ? <span className="ml-2 text-xs text-warning">needs confirmation</span> : null}
                </td>
              </tr>
            );
          })}
          {changes.length > limit ? (
            <tr className="border-t border-border/60">
              <td colSpan={3} className="px-3.5 py-1.5">
                <button type="button" className="text-muted-foreground hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
                  {open ? 'Show fewer' : `+ ${changes.length - limit} more`}
                </button>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

/** Groups inner calls: `list_orders ✓`, `add_order_note × 7 · planned`. */
export function innerCallChips(calls: TimelineItem[]): { label: string; tone: 'ok' | 'planned' | 'err' }[] {
  const map = new Map<string, { n: number; planned: boolean; err: boolean }>();
  for (const c of calls) {
    const k = `${c.tool}|${c.dryRun ? 'p' : ''}`;
    const v = map.get(k) ?? { n: 0, planned: !!c.dryRun, err: false };
    v.n++;
    if (c.decision?.startsWith('denied_') || (c.status && c.status !== 'ok')) v.err = true;
    map.set(k, v);
  }
  return [...map.entries()].map(([k, v]) => {
    const tool = k.split('|')[0];
    return { label: `${tool}${v.n > 1 ? ` × ${v.n}` : ''}${v.planned ? ' · planned' : v.err ? ' · error' : ' ✓'}`, tone: v.planned ? 'planned' : v.err ? 'err' : 'ok' };
  });
}

/**
 * Script run (spec §9.12, prototype Task): code, stats against the limits, phases, inner calls
 * (each passed the policy pipeline) and, in dry-run, the planned changes.
 */
export function ScriptBlock({ item, limits, onCall, followUp }: { item: TimelineItem; limits?: { maxToolCalls: number; cpuTimeSec: number }; onCall: (auditId: string, el: HTMLElement) => void; followUp?: { ts: string } | null }) {
  const sr = useQuery({ ...scriptQuery(item.scriptRunId ?? ''), enabled: !!item.scriptRunId });
  const s = sr.data;
  const dry = item.dryRun || s?.mode === 'dry_run';
  const confirmed = item.decision === 'confirmed' || s?.calls.some((c) => c.decision === 'confirmed');
  const [expanded, setExpanded] = useState(dry);
  const children = s?.calls ?? item.children ?? [];
  return (
    <div className="flex-1 overflow-hidden rounded-xl border border-mode-code-border">
      <div className="flex flex-wrap items-center gap-2.5 bg-mode-code-muted px-3.5 py-2.5">
        <span className="font-mono text-[13px] font-semibold text-mode-code">run_script</span>
        <span className={cn('rounded-full px-2 py-px text-xs font-semibold', dry ? 'border border-mode-code-border bg-card text-mode-code' : 'bg-mode-code text-white dark:text-background')}>{dry ? 'dry_run' : 'execute'}</span>
        {confirmed ? <span className="text-[12.5px] font-semibold text-env-prod">Confirmed by user ({item.write ? 'prod write' : 'write'})</span> : null}
        <span className="flex-1" />
        <span className="text-[12.5px] text-muted-foreground tabular-nums">
          {s?.stats ? (
            <>
              {s.stats.cpuMs !== undefined ? `CPU ${(s.stats.cpuMs / 1000).toFixed(1)} s${limits ? ` / ${limits.cpuTimeSec} s` : ''} · ` : ''}
              {compactDuration(s.stats.wallMs)} wall · {s.stats.toolCalls} calls{limits ? ` / ${limits.maxToolCalls}` : ''}
              {s.stats.blockedCalls ? ` · ${s.stats.blockedCalls} blocked` : ''}
            </>
          ) : (
            item.summary
          )}
        </span>
        {!dry ? (
          <button type="button" className="rounded-lg border border-mode-code-border bg-card px-2.5 py-1 text-[12.5px]" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>
            {expanded ? 'Hide script' : 'Show script'}
          </button>
        ) : null}
      </div>
      {expanded ? (
        <>
          {sr.isError ? <ErrorState error={sr.error} /> : null}
          {s ? <CodeView code={s.code} lang="python" className="rounded-none border-0 border-t" highlightLines={s.error?.line ? [s.error.line] : []} label="Script code" /> : <Skeleton className="m-3 h-24" />}
          {s?.phases.length ? (
            <div className="flex flex-wrap gap-2 border-t px-3.5 py-2 text-xs">
              {s.phases.map((p) => (
                <span key={p.name} className={cn('rounded-full border px-2 py-px', p.status === 'failed' && 'border-destructive/40 text-destructive')}>
                  {p.name.replace('_', ' ')}: {p.status}
                  {p.durationMs !== null ? ` · ${compactDuration(p.durationMs)}` : ''}
                </span>
              ))}
            </div>
          ) : null}
          {s?.error ? (
            <div role="note" className="border-t bg-destructive-muted px-3.5 py-2 text-[13px]">
              <strong>{s.error.type}</strong>: {s.error.message}
              {s.error.line ? ` (line ${s.error.line})` : ''}
              {s.error.hint ? <p className="mt-1">Hint returned to the agent: {s.error.hint}</p> : null}
            </div>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-col gap-1.5 border-t px-3.5 py-2.5">
        <span className="text-[12.5px] font-semibold text-muted-foreground">Inner calls · each passed the same policy pipeline as a direct call</span>
        <ol aria-label="Inner calls" className="flex flex-wrap gap-1.5 font-mono text-xs">
          {innerCallChips(children).map((c) => (
            <li key={c.label} className={cn('rounded-md px-2 py-0.5', c.tone === 'planned' ? 'border border-dashed border-warning text-warning' : c.tone === 'err' ? 'border border-destructive/40 text-destructive' : 'border')}>
              {c.label}
            </li>
          ))}
        </ol>
        {expanded && children.length ? (
          <details>
            <summary className="cursor-pointer text-[12.5px] text-primary">Inspect inner calls ({children.length})</summary>
            <ol className="mt-1 flex flex-col gap-1 pl-3">
              {children.map((c) => (
                <li key={c.id}>
                  <button type="button" className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-[12.5px] hover:bg-muted" onClick={(e) => c.auditId && onCall(c.auditId, e.currentTarget)}>
                    <span className="w-16 font-mono text-muted-foreground">{formatTime(c.ts)}</span>
                    <span className="font-mono">{c.tool}</span>
                    {c.decision ? <DecisionBadge decision={c.decision} /> : null}
                    <span className="ml-auto text-muted-foreground">{c.summary}</span>
                  </button>
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>
      {s && s.plannedChanges.length ? <PlannedChangesTable changes={s.plannedChanges} /> : null}
      {dry && followUp ? <div className="border-t px-3.5 py-2 text-[12.5px] text-muted-foreground">Executed {compactDuration(Date.parse(followUp.ts) - Date.parse(item.ts))} later (see the next run).</div> : null}
    </div>
  );
}

/** Decision reason and alternatives live in the `neurouter_log_decision` call arguments. */
export function DecisionDetail({ auditId }: { auditId: string }) {
  const call = useQuery(callQuery(auditId));
  const args = (call.data?.arguments ?? {}) as { reason?: string; alternatives?: string[] };
  if (!call.data) return null;
  return (
    <span className="flex flex-col gap-1 text-[12.5px] text-muted-foreground">
      {args.reason ? <span>{args.reason}</span> : null}
      {args.alternatives?.length ? (
        <span className="flex flex-wrap items-center gap-1">
          Alternatives considered:
          {args.alternatives.map((a) => (
            <span key={a} className="rounded-full border px-2 py-px">
              {a}
            </span>
          ))}
        </span>
      ) : null}
    </span>
  );
}

export type ScriptStats = ScriptRunDetail['stats'];
