import { Link } from '@tanstack/react-router';
import { CheckIcon, CopyIcon, LoaderCircleIcon } from 'lucide-react';
import type { MatrixCell, SuggestionRow } from '@/contract';
import { GatedButton } from '@/components/app/gated';
import { copyText } from '@/components/code/copy-button';
import { Pill } from '@/components/status/status';
import { Button } from '@/components/ui/button';
import { useMinWidth } from '@/hooks/use-min-width';
import { notifyError, notifySuccess } from '@/lib/notify';
import { cn } from '@/lib/utils';
import { useApplySuggestion, useDismissSuggestion, useVerifySuggestion } from './queries';

/** Rows of the model × mode matrix; `best` per model from the API, else the highest success rate. */
export function matrixRows(cells: MatrixCell[]): { model: string; tool: MatrixCell | null; code: MatrixCell | null; best: 'tool' | 'code' | null }[] {
  const models = [...new Set(cells.map((c) => c.model))];
  return models.map((model) => {
    const tool = cells.find((c) => c.model === model && c.mode === 'tool') ?? null;
    const code = cells.find((c) => c.model === model && c.mode === 'code') ?? null;
    let best: 'tool' | 'code' | null = tool?.best ? 'tool' : code?.best ? 'code' : null;
    if (!best && tool && code) best = code.successRate > tool.successRate ? 'code' : 'tool';
    if (!best && (tool || code)) best = tool ? 'tool' : 'code';
    return { model, tool, code, best };
  });
}

const tokensK = (n: number) => `${(n / 1000).toFixed(1)}k tokens`;
function cellMeta(c: MatrixCell, mode: 'tool' | 'code'): string {
  return mode === 'code' ? `${c.avgCalls.toFixed(1)} scripts · ${tokensK(c.avgTokens)}` : `${c.avgCalls.toFixed(1)} calls · ${tokensK(c.avgTokens)}`;
}

/**
 * Model × mode matrix (spec §7.3): a real table with row headers; the best cell per row says
 * "best" in text. Stacked cards per model under 640 px.
 */
export function ModelModeMatrix({ cells }: { cells: MatrixCell[] }) {
  const rows = matrixRows(cells);
  const wide = useMinWidth(640);
  const pct = (c: MatrixCell) => `${Math.round(c.successRate * 100)}%`;
  if (!wide) {
    return (
      <ul className="flex flex-col gap-2 p-3" aria-label="Task success by model and mode">
        {rows.map((r) => (
          <li key={r.model} className="rounded-lg border p-3">
            <div className="mb-1.5 font-mono text-[13px]">{r.model}</div>
            <div className="grid grid-cols-2 gap-2">
              {(['tool', 'code'] as const).map((m) => {
                const c = r[m];
                return (
                  <div key={m}>
                    <div className={cn('text-[12.5px] font-semibold', m === 'tool' ? 'text-mode-tool' : 'text-mode-code')}>{m === 'tool' ? 'Tool mode' : 'Code mode'}</div>
                    {c ? (
                      <>
                        <div className="text-lg font-semibold tabular-nums">
                          {pct(c)} {r.best === m ? <span className="text-xs text-mode-code">best</span> : null}
                        </div>
                        <div className="text-xs text-muted-foreground">{cellMeta(c, m)}</div>
                      </>
                    ) : (
                      <div className="text-muted-foreground">not run</div>
                    )}
                  </div>
                );
              })}
            </div>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <table className="w-full text-[13.5px]">
      <caption className="sr-only">Task success by model and mode. The best mode per model is marked “best”.</caption>
      <thead>
        <tr className="bg-muted/50 text-left text-muted-foreground">
          <th scope="col" className="px-4.5 py-2 font-medium">Model</th>
          <th scope="col" className="px-2 py-2 font-medium">
            <span aria-hidden="true" className="text-mode-tool">●</span> Tool mode
          </th>
          <th scope="col" className="px-4.5 py-2 font-medium">
            <span aria-hidden="true" className="text-mode-code">●</span> Code mode
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.model} className="border-t">
            <th scope="row" className="px-4.5 py-3 text-left font-mono text-[13px] font-normal">
              {r.model}
            </th>
            {(['tool', 'code'] as const).map((m) => {
              const c = r[m];
              const best = r.best === m;
              return (
                <td key={m} className={cn('py-3', m === 'tool' ? 'px-2' : 'px-4.5', best && (m === 'code' ? 'bg-mode-code-muted' : 'bg-info-muted'))}>
                  {c ? (
                    <>
                      <span className="text-lg font-semibold tabular-nums">{pct(c)}</span>{' '}
                      {best ? <span className={cn('rounded-full border px-1.5 text-[11.5px] font-semibold', m === 'code' ? 'border-mode-code-border text-mode-code' : 'border-info/40 text-info')}>best</span> : null}
                      <span className="block text-xs text-muted-foreground">{cellMeta(c, m)}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">not run</span>
                  )}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Human title for a suggestion (the contract has none): "Rename …", "Rewrite … description". */
export function suggestionTitle(s: SuggestionRow): string {
  const tool = s.tools[0] ?? 'a tool';
  const renameTo = s.overlayPatch.match(/name:\s*(\S+)/)?.[1];
  const key = s.overlayPatch.match(/"operationId:([^"]+)"/)?.[1];
  switch (s.kind) {
    case 'rename':
      return `Rename ${key ?? tool}${renameTo ? ` → ${renameTo}` : ''}`;
    case 'describe':
      return `Rewrite ${tool} description`;
    case 'hide':
      return `Hide ${key ?? tool}`;
    case 'example':
      return `Add an example to ${tool}`;
    case 'response_shape':
      return `Shape the ${tool} response`;
    case 'composite':
      return s.cause === 'missing_capability' ? `Missing capability: ${s.rationale.split(';')[0]?.slice(0, 60) ?? tool}` : `Add a composite tool for ${tool}`;
  }
}

/** Fix suggestion card (spec §9.14, prototype EvalRun): rationale, overlay patch, verify / apply. */
export function FixSuggestionCard({ s, serverId }: { s: SuggestionRow; serverId: string }) {
  const verify = useVerifySuggestion();
  const apply = useApplySuggestion(serverId);
  const dismiss = useDismissSuggestion();
  const verifying = s.status === 'verifying' || verify.isPending;
  const lines = s.overlayPatch.split('\n').filter((l) => l.trim() && !/^tools:|^\s+"/.test(l));
  return (
    <article aria-label={suggestionTitle(s)} className={cn('flex min-w-0 flex-col gap-2.5 rounded-xl border bg-card p-4', s.status === 'dismissed' && 'opacity-60')}>
      <div className="flex items-center gap-2">
        <span className="flex-1 font-semibold">{suggestionTitle(s)}</span>
        {s.status === 'verified' && s.verifiedDelta !== null ? <Pill tone="ok">Verified +{s.verifiedDelta} pts</Pill> : s.status === 'applied' ? <Pill tone="brand" icon={CheckIcon}>Applied to draft</Pill> : verifying ? <Pill tone="info">Verifying…</Pill> : <Pill tone="muted">Not verified</Pill>}
      </div>
      <span className="text-[13px] text-muted-foreground">
        {s.rationale} <span className="whitespace-nowrap">({s.affectedTaskKeys.length} tasks)</span>
      </span>
      {lines.length ? (
        <pre aria-label="Overlay change" className="rounded-lg border bg-muted/40 px-2.5 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap text-success">
          {lines.map((l) => `+ ${l.trim()}`).join('\n')}
        </pre>
      ) : null}
      {s.predictedDelta && s.status !== 'verified' ? <span className="text-xs text-muted-foreground">Predicted +{s.predictedDelta} pts</span> : null}
      <div className="flex flex-wrap gap-2">
        {s.overlayPatch ? (
          <GatedButton
            cap="overlays:write"
            size="sm"
            disabled={s.status === 'applied' || apply.isPending}
            onClick={() =>
              apply.mutate(
                { id: s.id },
                {
                  onSuccess: () => notifySuccess('Added to the overlay draft', 'Publish it from the Overlay tab.'),
                  onError: (e) => notifyError(e, 'Could not apply the fix'),
                },
              )
            }
          >
            Apply as overlay
          </GatedButton>
        ) : null}
        {s.status === 'proposed' && s.overlayPatch ? (
          <GatedButton cap="evals:run" demoOp="suggestions.verify" variant="outline" size="sm" disabled={verifying} onClick={() => verify.mutate(s.id, { onError: (e) => notifyError(e, 'Could not verify') })}>
            {verifying ? <LoaderCircleIcon className="animate-spin" /> : null} Verify
          </GatedButton>
        ) : null}
        {s.status === 'applied' ? (
          <Button variant="outline" size="sm" render={<Link to="/servers/$serverId/overlay" params={{ serverId }} />} nativeButton={false}>
            Review the draft
          </Button>
        ) : null}
        {s.specPatch ? (
          <Button variant="ghost" size="sm" onClick={() => void copyText(s.specPatch!).then((ok) => ok && notifySuccess('Spec patch copied'))}>
            <CopyIcon /> Copy spec patch
          </Button>
        ) : null}
        {s.status !== 'dismissed' && s.status !== 'applied' ? (
          <GatedButton cap="evals:run" variant="ghost" size="sm" onClick={() => dismiss.mutate(s.id)}>
            Dismiss
          </GatedButton>
        ) : null}
      </div>
    </article>
  );
}
