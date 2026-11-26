import { Link } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CopyIcon } from 'lucide-react';
import type { IssueRow, NeedGroupRow } from '@/contract';
import { GatedButton, useGate } from '@/components/app/gated';
import type { Tone } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { copyText } from '@/components/code/copy-button';
import { formatDate, formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';
import { useState } from 'react';
import { fetchNeedMarkdown, needGroupQuery, useTriageNeed } from './queries';

export const NEED_STATUS: Record<NeedGroupRow['status'], { label: string; tone: Tone }> = {
  open: { label: 'New', tone: 'muted' },
  planned: { label: 'Planned', tone: 'brand' },
  done: { label: 'Shipped', tone: 'ok' },
  dismissed: { label: 'Dismissed', tone: 'outline' },
};

export const ISSUE_STATUS: Record<IssueRow['status'], { label: string; tone: Tone }> = {
  open: { label: 'Open', tone: 'warn' },
  acknowledged: { label: 'Triaged', tone: 'brand' },
  fixed: { label: 'Resolved', tone: 'ok' },
  dismissed: { label: 'Dismissed', tone: 'outline' },
};

/** 14-day sparkline (role="img" with a sentence). */
export function Sparkline({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  const pts = values.map((v, i) => `${(i * 84) / Math.max(1, values.length - 1)},${20 - (v / max) * 18}`).join(' ');
  return (
    <svg width="84" height="22" viewBox="0 0 84 22" role="img" aria-label={label}>
      <polyline points={pts} fill="none" stroke="var(--primary)" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  );
}

/** Need-group detail panel (prototype Inbox aside): reports, what agents tried, triage, Markdown. */
export function NeedGroupPanel({ groupId, heading = 'h2' }: { groupId: string; heading?: 'h1' | 'h2' }) {
  const g = useQuery(needGroupQuery(groupId));
  const triage = useTriageNeed(groupId);
  const gate = useGate('inbox:triage');
  const [note, setNote] = useState<string | null>(null);
  if (!g.data) return <Skeleton className="h-80 rounded-xl" />;
  const d = g.data;
  const H = heading;
  const last14 = d.daily.slice(-14).map((x) => x.count);
  return (
    <div className="flex flex-col gap-3.5">
      <H className="text-[17px] font-semibold">{d.label}</H>
      <span className="text-[13px] text-muted-foreground">
        {d.count} reports · {d.distinctPrincipals} keys · first seen {formatDate(d.firstSeenAt).replace(/, \d{4}$/, '')} · {d.server.name}
      </span>
      {last14.some(Boolean) ? <Sparkline values={last14} label={`${d.count} reports, trend over 14 days`} /> : null}
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold">What agents tried</span>
        <div className="flex flex-wrap gap-1.5 font-mono text-xs">
          {d.attemptedTools.map((t) => (
            <span key={t.tool} className="rounded-md border px-2 py-0.5">
              {t.tool} × {t.count}
            </span>
          ))}
          {!d.attemptedTools.length ? <span className="font-sans text-muted-foreground">Nothing: agents stopped and asked.</span> : null}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <span className="text-[13px] font-semibold">Reports</span>
        {d.reports.items.map((r) => (
          <blockquote key={r.id} className="rounded-lg bg-muted/60 px-3 py-2.5 text-[13px]">
            “{r.intent}”
            <span className="mt-1 block text-xs text-muted-foreground">
              attempted: {r.attempted.length ? r.attempted.join(', ') : 'none'} · {r.principal?.name ?? 'unknown'} · {formatRelative(r.createdAt)}
              {r.taskId ? (
                <>
                  {' · '}
                  <Link to="/tasks/$taskId" params={{ taskId: r.taskId }} className="text-primary hover:underline">
                    task
                  </Link>
                </>
              ) : null}
            </span>
          </blockquote>
        ))}
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`triage-${groupId}`} className="text-[13px] font-semibold">
          Triage
        </label>
        <select
          id={`triage-${groupId}`}
          value={d.status}
          disabled={gate.disabled || triage.isPending}
          onChange={(e) => triage.mutate({ status: e.target.value as NeedGroupRow['status'] }, { onSuccess: () => notifySuccess(`Marked ${NEED_STATUS[e.target.value as NeedGroupRow['status']].label}`), onError: (err) => notifyError(err) })}
          className="h-9 rounded-lg border bg-background px-2 text-sm"
        >
          {(Object.keys(NEED_STATUS) as NeedGroupRow['status'][]).map((s) => (
            <option key={s} value={s}>
              {NEED_STATUS[s].label}
            </option>
          ))}
        </select>
        <Textarea aria-label="Triage note" rows={2} placeholder="Note (e.g. the ticket it is planned in)" value={note ?? d.note ?? ''} disabled={gate.disabled} onChange={(e) => setNote(e.target.value)} />
        {note !== null && note !== (d.note ?? '') ? (
          <GatedButton cap="inbox:triage" size="sm" className="self-start" onClick={() => triage.mutate({ note }, { onSuccess: () => (setNote(null), notifySuccess('Note saved')) })}>
            Save note
          </GatedButton>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            void fetchNeedMarkdown(groupId)
              .then((md) => copyText(md))
              .then((ok) => (ok ? notifySuccess('Copied as Markdown') : notifyError(new Error('Clipboard unavailable'))))
          }
        >
          <CopyIcon /> Copy as Markdown
        </Button>
        {d.reports.items[0]?.taskId ? (
          <Button variant="outline" size="sm" render={<Link to="/tasks/$taskId" params={{ taskId: d.reports.items[0].taskId }} />} nativeButton={false}>
            Open a sample task
          </Button>
        ) : null}
      </div>
    </div>
  );
}
