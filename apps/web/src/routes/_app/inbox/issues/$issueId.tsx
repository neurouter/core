import { useState } from 'react';
import { Link, createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { CopyIcon, WrenchIcon } from 'lucide-react';
import type { IssueRow } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton, useGate } from '@/components/app/gated';
import { copyText } from '@/components/code/copy-button';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { PageHeader } from '@/components/layout/page-header';
import { EnvBadge, OutcomeBadge, Pill } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { suggestionSearchQuery } from '@/features/evals/queries';
import { ISSUE_STATUS } from '@/features/inbox/components';
import { fetchIssueMarkdown, issueQuery, useTriageIssue } from '@/features/inbox/queries';
import { CallDetailView } from '@/features/tasks/components';
import { toolsQuery } from '@/features/tools/queries';
import { formatRelative } from '@/lib/format';
import { notifyError, notifySuccess } from '@/lib/notify';

export const Route = createFileRoute('/_app/inbox/issues/$issueId')({
  beforeLoad: guard(['inbox:read']),
  component: IssuePage,
});

/** Issue detail (spec §9.13): problem, evidence, the failing call, related eval fixes, triage. */
function IssuePage() {
  const { issueId } = Route.useParams();
  const issue = useQuery(issueQuery(issueId));
  const triage = useTriageIssue(issueId);
  const gate = useGate('inbox:triage');
  const [note, setNote] = useState<string | null>(null);
  const tools = useQuery({ ...toolsQuery(issue.data?.server.id ?? '', {}), enabled: !!issue.data });
  const fixes = useQuery({ ...suggestionSearchQuery({ serverId: issue.data?.server.id, toolName: issue.data?.tool }), enabled: !!issue.data });
  useSetCrumbs([{ label: 'Inbox', to: '/inbox' }, { label: 'Issues', to: '/inbox?tab=issues' }, { label: issue.data?.tool ?? issueId }]);
  if (issue.isPending) return <PageSkeleton />;
  if (issue.isError) return <ErrorState error={issue.error} onRetry={() => void issue.refetch()} />;
  const i = issue.data;
  const toolId = tools.data?.items.find((t) => t.name === i.tool)?.id;
  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={i.problem}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{i.tool}</span> · {i.server.name} · <EnvBadge slug={i.environment.slug} kind={i.environment.kind} /> · reported {formatRelative(i.createdAt)}
          </span>
        }
        actions={
          toolId ? (
            <GatedButton cap="overlays:write" render={<Link to="/servers/$serverId/tools/$toolId" params={{ serverId: i.server.id, toolId }} search={{ tab: 'overlay', issue: i.id }} />} nativeButton={false}>
              <WrenchIcon /> Propose fix
            </GatedButton>
          ) : null
        }
      />
      <div className="grid gap-5 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex min-w-0 flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <h2 className="text-base font-semibold">Evidence</h2>
            <p className="text-[13.5px] whitespace-pre-wrap">{typeof i.evidence === 'string' ? i.evidence : JSON.stringify(i.evidence, null, 2)}</p>
          </section>
          {i.failingCall ? (
            <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h2 className="text-base font-semibold">Failing call</h2>
              <CallDetailView call={i.failingCall} />
            </section>
          ) : null}
        </div>
        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <h2 className="text-base font-semibold">Triage</h2>
            <label htmlFor="issue-status" className="text-[13px] font-medium">
              Status
            </label>
            <select id="issue-status" value={i.status} disabled={gate.disabled} onChange={(e) => triage.mutate({ status: e.target.value as IssueRow['status'] }, { onSuccess: () => notifySuccess('Status changed'), onError: (err) => notifyError(err) })} className="h-9 rounded-lg border bg-background px-2 text-sm">
              {(Object.keys(ISSUE_STATUS) as IssueRow['status'][]).map((s) => (
                <option key={s} value={s}>
                  {ISSUE_STATUS[s].label}
                </option>
              ))}
            </select>
            <Textarea aria-label="Note" rows={3} value={note ?? i.note ?? ''} disabled={gate.disabled} onChange={(e) => setNote(e.target.value)} placeholder="Note" />
            {note !== null && note !== (i.note ?? '') ? (
              <GatedButton cap="inbox:triage" size="sm" className="self-start" onClick={() => triage.mutate({ note }, { onSuccess: () => (setNote(null), notifySuccess('Note saved')) })}>
                Save note
              </GatedButton>
            ) : null}
            <Button variant="outline" size="sm" className="self-start" onClick={() => void fetchIssueMarkdown(i.id).then(copyText).then((ok) => ok && notifySuccess('Copied as Markdown'))}>
              <CopyIcon /> Copy as Markdown
            </Button>
          </section>
          {i.task ? (
            <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
              <h2 className="text-base font-semibold">Task</h2>
              <Link to="/tasks/$taskId" params={{ taskId: i.task.id }} className="text-[13.5px] hover:underline">
                {i.task.goal ?? i.task.id}
              </Link>
              <OutcomeBadge outcome={i.task.outcome} status={i.task.status} framing={i.task.framing} />
            </section>
          ) : null}
          <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
            <h2 className="text-base font-semibold">Related eval fixes</h2>
            {fixes.data?.items.map((s) => (
              <Link key={s.id} to="/evals/runs/$runId" params={{ runId: s.runId }} search={{ tab: 'fixes' }} className="text-[13.5px] hover:underline">
                {s.rationale} <Pill tone="muted">{s.status}</Pill>
              </Link>
            ))}
            {fixes.data && !fixes.data.items.length ? <span className="text-[13px] text-muted-foreground">No eval failures point at this tool.</span> : null}
          </section>
        </div>
      </div>
    </div>
  );
}
