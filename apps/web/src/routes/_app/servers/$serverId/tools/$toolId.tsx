import { useEffect, useRef, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import * as z from 'zod';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import type { OverlayPatchOp, OverlayToolEntry, ToolDetail } from '@/contract';
import { GatedButton, useGate } from '@/components/app/gated';
import { ButtonTabs } from '@/components/app/link-tabs';
import { describeChange, keyName, runLabel } from '@/components/app/labels';
import { CodeView } from '@/components/code/code-view';
import { DiffView } from '@/components/code/diff-view';
import { JsonViewer } from '@/components/code/json-viewer';
import { ErrorState, PageSkeleton } from '@/components/feedback/states';
import { Segmented } from '@/components/filters/segmented';
import { PageHeader } from '@/components/layout/page-header';
import { OutcomeBadge, Pill, WriteBadge } from '@/components/status/status';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { suggestionSearchQuery } from '@/features/evals/queries';
import { inboxByToolQuery } from '@/features/inbox/queries';
import { OverlayDraftBar } from '@/features/overlays/draft-bar';
import { tasksQuery } from '@/features/tasks/queries';
import { draftQuery, overlayDiffQuery, overlayPreviewQuery, toolQuery, toolUsageQuery, toolsQuery, usePatchDraft } from '@/features/tools/queries';
import { ApiError } from '@/lib/api-client';
import { formatDuration, formatNumber, formatPercent, formatRelative } from '@/lib/format';
import { notifyError } from '@/lib/notify';
import { cn } from '@/lib/utils';

const TABS = ['definition', 'overlay', 'diff', 'usage'] as const;
const search = z.object({ tab: z.enum(TABS).optional().catch(undefined), issue: z.string().optional().catch(undefined) });

export const Route = createFileRoute('/_app/servers/$serverId/tools/$toolId')({
  validateSearch: search,
  component: ToolPage,
});

/** `ceil(chars / 4)`: the same estimate the backend labels `estimated: true` (A43). */
export const estimateTokens = (s: string) => Math.ceil(new TextEncoder().encode(s).length / 4);

/**
 * Description lint hints (spec §9.6): too short, no units for money fields, ambiguous with a
 * sibling tool, searched fields not named. Heuristics only; the backend lint owns the score.
 */
export function descriptionHints(description: string, name: string, siblings: string[]): string[] {
  const out: string[] = [];
  const d = description.trim();
  if (d.length < 40) out.push(d ? 'Too short: say what it returns and when to use it' : 'No description');
  const noun = name.split('_').slice(1).join('_');
  const twin = siblings.find((s) => s !== name && noun && s.endsWith(`_${noun}`));
  if (twin && !d.includes(twin)) out.push(`Ambiguous with ${twin}`);
  if (name.startsWith('search_') && !/\bby\b/.test(d)) out.push('Doesn’t say which fields are searched');
  if (/amount|price|total/i.test(d) && !/cent|minor unit|currency/i.test(d)) out.push('Missing units (cents or currency)');
  return out;
}

/** Response fields for the shaping tree, from the output schema (object or array of objects). */
export function responseFields(t: Pick<ToolDetail, 'outputSchema'>): { path: string; type: string }[] {
  const s = t.outputSchema as { type?: string; items?: { properties?: Record<string, { type?: string }> }; properties?: Record<string, { type?: string }> } | null;
  const props = s?.type === 'array' ? s.items?.properties : s?.properties;
  return Object.entries(props ?? {}).map(([path, v]) => ({ path, type: v.type ?? 'object' }));
}

function ToolPage() {
  const { serverId, toolId } = Route.useParams();
  const { tab = 'overlay', issue } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const tool = useQuery(toolQuery(toolId));
  const patch = usePatchDraft(serverId);
  const gate = useGate('overlays:write', 'overlays.updateDraft');
  if (tool.isPending) return <PageSkeleton />;
  if (tool.isError) return <ErrorState error={tool.error} onRetry={() => void tool.refetch()} />;
  const t = tool.data;
  const entry = t.overlayEntry ?? {};
  const hidden = entry.hidden ?? t.hidden;
  const pinned = entry.pinned ?? t.pinned;
  const send = (ops: OverlayPatchOp[]) => patch.mutate(ops, { onError: (e) => notifyError(e, 'Could not save the change') });
  return (
    <div className="flex flex-1 flex-col gap-4">
      <PageHeader
        title={entry.name ?? t.name}
        leading={null}
        description={
          <span className="flex flex-wrap items-center gap-2.5">
            <WriteBadge write={t.write} />
            <span className="font-mono text-[12.5px]">{t.method ? `${t.method} ${t.path}` : keyName(t.key)}</span>
            {t.deprecated ? <Pill tone="warn">deprecated</Pill> : null}
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-4 text-[13.5px]">
            <label className="inline-flex items-center gap-2">
              <Switch checked={!hidden} disabled={gate.disabled} onCheckedChange={(v) => send([{ op: 'set', selector: t.key, field: 'hidden', value: !v }])} /> Visible to agents
            </label>
            <label className="inline-flex items-center gap-2">
              <Switch checked={pinned} disabled={gate.disabled || hidden} onCheckedChange={(v) => send([{ op: 'set', selector: t.key, field: 'pinned', value: v }])} /> Pinned
            </label>
          </div>
        }
      />
      {issue ? (
        <div className="rounded-lg border border-warning/40 bg-warning-muted px-3 py-2 text-[13.5px]">
          Fixing an agent-reported issue.{' '}
          <Link to="/inbox/issues/$issueId" params={{ issueId: issue }} className="font-medium text-primary underline">
            View the issue
          </Link>
        </div>
      ) : null}
      <ButtonTabs label="Tool sections" value={tab} onChange={(v) => void navigate({ search: (p) => ({ ...p, tab: v }), replace: true })} tabs={TABS.map((v) => ({ value: v, label: v[0]!.toUpperCase() + v.slice(1) }))} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="flex flex-col gap-4">
        {tab === 'definition' ? <DefinitionTab tool={t} /> : null}
        {tab === 'overlay' ? <OverlayTab serverId={serverId} tool={t} entry={entry} send={send} disabled={gate.disabled} saving={patch.isPending} saveError={patch.error} /> : null}
        {tab === 'diff' ? <DiffTab serverId={serverId} tool={t} /> : null}
        {tab === 'usage' ? <UsageTab serverId={serverId} tool={t} /> : null}
      </div>
      <OverlayDraftBar serverId={serverId} />
    </div>
  );
}

/* ================================================================== definition */

function DefinitionTab({ tool }: { tool: ToolDetail }) {
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">As the agent sees it</h2>
        <p className="text-[13.5px] whitespace-pre-wrap">{tool.description || <span className="text-muted-foreground">No description.</span>}</p>
        <div className="flex flex-wrap gap-1.5">
          <Pill tone={tool.annotations.readOnlyHint ? 'muted' : 'warn'}>readOnlyHint: {String(tool.annotations.readOnlyHint)}</Pill>
          <Pill tone={tool.annotations.destructiveHint ? 'err' : 'muted'}>destructiveHint: {String(tool.annotations.destructiveHint)}</Pill>
          <Pill tone="muted">idempotentHint: {String(tool.annotations.idempotentHint)}</Pill>
        </div>
        <h3 className="text-sm font-semibold">tools/list entry</h3>
        <JsonViewer value={tool.agentView.mcp} label="MCP tools/list entry" collapseAfter={40} />
      </section>
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Code mode stub</h2>
        <CodeView code={tool.agentView.python} lang="python" label="Python stub" />
        <h3 className="text-sm font-semibold">Input schema</h3>
        <JsonViewer value={tool.inputSchema} label="Input schema" />
      </section>
    </div>
  );
}

/* ================================================================== overlay editor */

/**
 * Autosave a field 600 ms after the last keystroke (A-OVERLAY-LIFECYCLE). A pending edit is flushed
 * when the editor unmounts (tab switch, "Review & publish"), so typing is never lost.
 */
function useDebouncedSave(value: string, original: string, delay: number, save: (v: string) => void) {
  const pending = useRef<string | null>(null);
  const saveRef = useRef(save);
  useEffect(() => {
    saveRef.current = save;
  });
  useEffect(() => {
    if (value === original) {
      pending.current = null;
      return;
    }
    pending.current = value;
    const t = setTimeout(() => {
      pending.current = null;
      saveRef.current(value);
    }, delay);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  useEffect(
    () => () => {
      if (pending.current !== null) saveRef.current(pending.current);
    },
    [],
  );
}

function OverlayTab({ serverId, tool, entry, send, disabled, saving, saveError }: { serverId: string; tool: ToolDetail; entry: OverlayToolEntry; send: (ops: OverlayPatchOp[]) => void; disabled: boolean; saving: boolean; saveError: unknown }) {
  const siblings = useQuery(toolsQuery(serverId, {}));
  const names = siblings.data?.items.map((x) => x.name) ?? [];
  const [name, setName] = useState(entry.name ?? tool.name);
  const [description, setDescription] = useState(entry.description ?? tool.description);
  const [nameError, setNameError] = useState<string | null>(null);
  const nameOk = (v: string) => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(v)) return 'Use snake_case: lowercase letters, digits and underscores';
    if (names.some((n) => n === v && n !== tool.name)) return `${v} is already used by another tool`;
    return null;
  };
  useDebouncedSave(name, entry.name ?? tool.name, 600, (v) => {
    const err = nameOk(v);
    setNameError(err);
    if (!err) send([{ op: 'set', selector: tool.key, field: 'name', value: v }]);
  });
  useDebouncedSave(description, entry.description ?? tool.description, 600, (v) => send([{ op: 'set', selector: tool.key, field: 'description', value: v }]));
  const serverNameError = saveError instanceof ApiError ? (saveError.fieldErrors.find((f) => f.path[0] === 'name')?.message ?? null) : null;
  const shownNameError = nameError ?? serverNameError;
  const hints = descriptionHints(description, entry.name ?? tool.name, names);
  const fix = useQuery(suggestionSearchQuery({ serverId, toolName: tool.name }));
  const describeFix = fix.data?.items.find((s) => s.kind === 'describe' && s.status !== 'dismissed' && s.status !== 'applied');
  const suggested = describeFix?.overlayPatch.match(/description:\s*(.+)/)?.[1]?.trim();
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ov-name">Name</Label>
          <Input id="ov-name" value={name} disabled={disabled} onChange={(e) => setName(e.target.value)} aria-invalid={shownNameError ? true : undefined} aria-describedby="ov-name-help" className="font-mono" />
          <span id="ov-name-help" role={shownNameError ? 'alert' : undefined} className={cn('text-[12.5px]', shownNameError ? 'text-destructive' : 'text-muted-foreground')}>
            {shownNameError ?? `Original operation id: ${keyName(tool.key)}`}
          </span>
        </div>
        <div className="flex flex-col gap-1.5">
          <div className="flex items-baseline">
            <Label htmlFor="ov-desc" className="flex-1">
              Description
            </Label>
            <span className="text-[12.5px] text-muted-foreground" aria-live="polite">
              ~{estimateTokens(description)} tokens{saving ? ' · saving…' : ''}
            </span>
          </div>
          <Textarea id="ov-desc" rows={3} value={description} disabled={disabled} onChange={(e) => setDescription(e.target.value)} aria-describedby="ov-desc-hints" />
          <div id="ov-desc-hints" className="flex flex-wrap gap-1.5" aria-label="Description hints">
            {hints.map((h) => (
              <Pill key={h} tone="warn">
                {h}
              </Pill>
            ))}
          </div>
        </div>
        {describeFix && suggested ? (
          <div className="flex flex-col gap-2 rounded-xl border border-brand-border bg-brand-muted p-3.5">
            <div className="flex items-center gap-2">
              <span className="flex-1 font-semibold">Fix suggestion from eval run {runLabel(describeFix.runId)}</span>
              {describeFix.verifiedDelta !== null ? <Pill tone="ok">Verified +{describeFix.verifiedDelta} pts</Pill> : <Pill tone="muted">Not verified</Pill>}
            </div>
            <p>“{suggested}”</p>
            <span className="text-[12.5px] text-muted-foreground">{describeFix.rationale}</span>
            <div>
              <GatedButton cap="overlays:write" demoOp="overlays.updateDraft" size="sm" onClick={() => setDescription(suggested)} disabled={description === suggested}>
                Use suggestion
              </GatedButton>
            </div>
          </div>
        ) : null}
        <ExamplesEditor tool={tool} entry={entry} send={send} disabled={disabled} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <ResponseShapingEditor serverId={serverId} tool={tool} entry={entry} send={send} disabled={disabled} />
      </div>
    </div>
  );
}

function ExamplesEditor({ tool, entry, send, disabled }: { tool: ToolDetail; entry: OverlayToolEntry; send: (ops: OverlayPatchOp[]) => void; disabled: boolean }) {
  const examples = entry.examples ?? tool.examples;
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('{\n  \n}');
  const [error, setError] = useState<string | null>(null);
  const save = (next: typeof examples) => send([{ op: 'set', selector: tool.key, field: 'examples', value: next }]);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="font-medium">Examples</span>
      {examples.length === 0 ? <span className="text-[13px] text-muted-foreground">No examples. One good example often fixes wrong arguments.</span> : null}
      {examples.map((ex, i) => (
        <div key={i} className="flex items-start gap-2 rounded-lg border bg-muted/40 px-2.5 py-2 font-mono text-[12.5px]">
          <span className="min-w-0 flex-1 break-all">{JSON.stringify(ex.arguments)}</span>
          <button type="button" disabled={disabled} aria-label={`Remove example ${i + 1}`} onClick={() => save(examples.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive disabled:opacity-50">
            <Trash2Icon className="size-3.5" />
          </button>
        </div>
      ))}
      {adding ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="ex-new" className="sr-only">
            Example arguments (JSON)
          </Label>
          <Textarea id="ex-new" rows={4} className="font-mono text-[12.5px]" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={error ? true : undefined} />
          {error ? <span role="alert" className="text-xs text-destructive">{error}</span> : null}
          <div className="flex gap-2">
            <GatedButton
              cap="overlays:write"
              demoOp="overlays.updateDraft"
              size="sm"
              onClick={() => {
                try {
                  const args = JSON.parse(text) as unknown;
                  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an object');
                  save([...examples, { arguments: args as Record<string, unknown> }]);
                  setAdding(false);
                  setError(null);
                } catch {
                  setError('Enter a JSON object of arguments, e.g. {"query": "maya@acme.test"}');
                }
              }}
            >
              Add
            </GatedButton>
            <button type="button" className="text-[13px] text-muted-foreground hover:underline" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button type="button" disabled={disabled} onClick={() => setAdding(true)} className="inline-flex h-[30px] items-center gap-1 self-start rounded-lg border border-dashed border-brand-border px-2.5 text-[13px] text-primary disabled:opacity-50">
          <PlusIcon aria-hidden="true" className="size-3.5" /> Add example
        </button>
      )}
    </div>
  );
}

function ResponseShapingEditor({ serverId, tool, entry, send, disabled }: { serverId: string; tool: ToolDetail; entry: OverlayToolEntry; send: (ops: OverlayPatchOp[]) => void; disabled: boolean }) {
  const fields = responseFields(tool);
  const r = entry.response ?? {};
  const include = r.include ?? fields.map((f) => f.path);
  const redact = new Set(r.redact ?? []);
  const isList = (tool.outputSchema as { type?: string } | null)?.type === 'array';
  const [maxItems, setMaxItems] = useState(r.maxItems ? String(r.maxItems) : '');
  useDebouncedSave(maxItems, r.maxItems ? String(r.maxItems) : '', 600, (v) => {
    const n = Number(v);
    send(v && Number.isInteger(n) && n >= 1 ? [{ op: 'set', selector: tool.key, field: 'response', value: { ...r, maxItems: n } }] : []);
  });
  const setResponse = (next: Partial<NonNullable<OverlayToolEntry['response']>>) => send([{ op: 'set', selector: tool.key, field: 'response', value: { ...r, ...next } }]);
  const preview = useQuery(overlayPreviewQuery(serverId, tool.name));
  const tk = preview.data?.tokens;
  const pct = tk && tk.sampleBefore ? Math.round((1 - tk.sampleAfter / tk.sampleBefore) * 100) : 0;
  return (
    <>
      <section aria-labelledby="shape-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
        <h2 id="shape-title" className="text-base font-semibold">
          Response shaping
        </h2>
        <span className="text-[12.5px] text-muted-foreground">Fields agents receive. Unchecked fields are removed before the response reaches the model; secret fields are redacted.</span>
        {fields.length ? (
          <ul className="flex flex-col gap-1 font-mono text-[13px]" aria-label="Response fields">
            {fields.map((f) => {
              const on = include.includes(f.path);
              return (
                <li key={f.path} className="flex items-center gap-2 py-1">
                  <Checkbox checked={on} disabled={disabled} aria-label={`Keep ${f.path}`} onCheckedChange={(v) => setResponse({ include: v ? [...include, f.path] : include.filter((x) => x !== f.path) })} />
                  <span className="flex-1">{f.path}</span>
                  <span className="font-sans text-xs text-muted-foreground">{f.type}</span>
                  <button
                    type="button"
                    disabled={disabled}
                    aria-pressed={redact.has(f.path)}
                    aria-label={`Mark ${f.path} secret`}
                    onClick={() => setResponse({ redact: redact.has(f.path) ? [...redact].filter((x) => x !== f.path) : [...redact, f.path] })}
                    className={cn('rounded-full px-2 py-px font-sans text-[11.5px]', redact.has(f.path) ? 'bg-destructive-muted text-destructive' : 'border text-muted-foreground')}
                  >
                    secret
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <span className="text-[13px] text-muted-foreground">The spec does not describe the response fields.</span>
        )}
        {isList ? (
          <div className="flex flex-wrap items-center gap-4 border-t pt-2.5 text-[13.5px]">
            <label className="inline-flex items-center gap-2">
              Max list items
              <Input aria-label="Max list items" inputMode="numeric" value={maxItems} disabled={disabled} onChange={(e) => setMaxItems(e.target.value.replace(/\D/g, ''))} className="h-7 w-16" placeholder="none" />
            </label>
            <span className="text-[12.5px] text-muted-foreground">Items beyond the cap go behind a page handle (read_result).</span>
          </div>
        ) : null}
      </section>
      <section aria-labelledby="prev-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <h2 id="prev-title" className="flex-1 text-base font-semibold">
            Before / after
          </h2>
          {tk ? (
            <span className={cn('font-semibold tabular-nums', pct > 0 ? 'text-success' : 'text-muted-foreground')} aria-live="polite">
              {formatNumber(tk.sampleBefore)} → {formatNumber(tk.sampleAfter)} tokens{pct > 0 ? ` (−${pct}%)` : ''}
            </span>
          ) : null}
        </div>
        {preview.isError ? (
          <ErrorState error={preview.error} onRetry={() => void preview.refetch()} />
        ) : preview.data ? (
          <div className="grid gap-2.5 sm:grid-cols-2">
            <JsonViewer value={preview.data.sample.before} label="Response before shaping" className="max-h-52 overflow-hidden" />
            <JsonViewer value={preview.data.sample.after} label="Response after shaping" className="max-h-52 overflow-hidden border-success/40 bg-success-muted" />
          </div>
        ) : (
          <Skeleton className="h-40" />
        )}
        <span className="text-xs text-muted-foreground">Preview from a {preview.data?.sample.source ?? 'mock'} call. Token counts are estimates.</span>
      </section>
    </>
  );
}

/* ================================================================== diff */

/** The YAML block of one selector (`  "operationId:x":` and its indented lines). */
export function yamlBlock(yaml: string, key: string): string {
  const lines = yaml.split('\n');
  const start = lines.findIndex((l) => l.trim() === `${JSON.stringify(key)}:` || l.trim() === `${key}:`);
  if (start < 0) return '';
  const out = [lines[start]!];
  for (const l of lines.slice(start + 1)) {
    if (/^ {4}/.test(l)) out.push(l);
    else break;
  }
  return out.join('\n');
}

function DiffTab({ serverId, tool }: { serverId: string; tool: ToolDetail }) {
  const draft = useQuery(draftQuery(serverId));
  const from = String(draft.data?.basedOnRev ?? 0);
  const diff = useQuery({ ...overlayDiffQuery(serverId, from, 'draft'), enabled: !!draft.data });
  const preview = useQuery(overlayPreviewQuery(serverId, tool.name));
  const [layout, setLayout] = useState<'split' | 'unified'>('split');
  const changes = draft.data?.changes.filter((c) => c.target === tool.key) ?? [];
  const before = JSON.stringify(tool.agentView.mcp, null, 2);
  const after = preview.data ? JSON.stringify(preview.data.agentView.mcp, null, 2) : before;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <span className="flex-1 text-[13.5px]">{changes.length ? changes.map(describeChange).join(' · ') : 'No draft changes for this tool.'}</span>
        <Segmented label="Diff layout" size="sm" value={layout} onChange={setLayout} options={[{ value: 'split', label: 'Split' }, { value: 'unified', label: 'Unified' }]} />
      </div>
      <section aria-label="Overlay diff" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">Overlay YAML</h2>
        {diff.data ? (
          <DiffView layout={layout} oldText={yamlBlock(diff.data.fromYaml, tool.key) || '# no entry'} newText={yamlBlock(diff.data.toYaml, tool.key) || '# no entry'} labels={[`Published · overlay v${draft.data?.basedOnRev ?? '–'}`, `Draft · ${changes.length} changes`]} />
        ) : (
          <Skeleton className="h-32" />
        )}
      </section>
      <section aria-label="Agent-visible definition diff" className="flex flex-col gap-2">
        <h2 className="text-base font-semibold">As the agent sees it</h2>
        <DiffView layout={layout} oldText={before} newText={after} labels={['Published', 'Draft']} />
      </section>
    </div>
  );
}

/* ================================================================== usage */

function UsageTab({ serverId, tool }: { serverId: string; tool: ToolDetail }) {
  const usage = useQuery(toolUsageQuery(tool.id));
  const tasks = useQuery(tasksQuery({ serverId, tool: tool.name, limit: 8 }));
  const inbox = useQuery(inboxByToolQuery(serverId, tool.name));
  const u = usage.data;
  return (
    <div className="grid gap-5 lg:grid-cols-2">
      <section className="flex flex-col gap-3 rounded-xl border bg-card p-4">
        <h2 className="text-base font-semibold">Last 7 days</h2>
        {u ? (
          <>
            <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Calls', formatNumber(u.calls)],
                ['Errors', formatNumber(u.errors)],
                ['p50', formatDuration(u.p50Ms)],
                ['p95', formatDuration(u.p95Ms)],
              ].map(([l, v]) => (
                <div key={l}>
                  <dt className="text-[12.5px] text-muted-foreground">{l}</dt>
                  <dd className="text-lg font-semibold tabular-nums">{v}</dd>
                </div>
              ))}
            </dl>
            <h3 className="text-sm font-semibold">Errors by status</h3>
            <ul className="text-[13.5px]">
              {Object.entries(u.byStatus)
                .filter(([k]) => k !== 'ok')
                .map(([k, v]) => (
                  <li key={k} className="flex justify-between border-t py-1.5">
                    <span className="font-mono">{k}</span>
                    <span className="tabular-nums">{formatNumber(v)}</span>
                  </li>
                ))}
            </ul>
            <h3 className="text-sm font-semibold">By mode</h3>
            <p className="text-[13.5px]">
              <span className="text-mode-tool">Direct: {formatNumber(u.byMode.tool ?? 0)}</span> · <span className="text-mode-code">Inside scripts: {formatNumber(u.byMode.code ?? 0)}</span> · {u.calls ? formatPercent((u.byMode.code ?? 0) / u.calls, 0) : '—'} via code mode
            </p>
          </>
        ) : (
          <Skeleton className="h-40" />
        )}
      </section>
      <div className="flex flex-col gap-5">
        <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <h2 className="text-base font-semibold">Recent tasks</h2>
          <ul className="flex flex-col divide-y text-[13.5px]">
            {tasks.data?.items.map((t) => (
              <li key={t.id} className="flex items-center gap-2 py-2">
                <Link to="/tasks/$taskId" params={{ taskId: t.id }} className="min-w-0 flex-1 truncate hover:underline">
                  {t.goal ?? t.inferredLabel?.goal ?? t.id}
                </Link>
                <OutcomeBadge outcome={t.outcome} status={t.status} framing={t.framing} />
                <span className="text-xs text-muted-foreground">{formatRelative(t.startedAt)}</span>
              </li>
            ))}
            {tasks.data && !tasks.data.items.length ? <li className="py-2 text-muted-foreground">No tasks used this tool yet.</li> : null}
          </ul>
        </section>
        <section className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <h2 className="text-base font-semibold">Issues and unmet needs</h2>
          <ul className="flex flex-col divide-y text-[13.5px]">
            {inbox.data?.items.map((i) => (
              <li key={i.id} className="flex items-center gap-2 py-2">
                <Pill tone={i.kind === 'issue' ? 'warn' : 'brand'}>{i.kind === 'issue' ? 'Issue' : 'Need'}</Pill>
                {i.kind === 'issue' ? (
                  <Link to="/inbox/issues/$issueId" params={{ issueId: i.id }} className="min-w-0 flex-1 truncate hover:underline">
                    {i.title}
                  </Link>
                ) : (
                  <Link to="/inbox/needs/$groupId" params={{ groupId: i.groupId ?? i.id }} className="min-w-0 flex-1 truncate hover:underline">
                    {i.title}
                  </Link>
                )}
              </li>
            ))}
            {inbox.data && !inbox.data.items.length ? <li className="py-2 text-muted-foreground">Nothing reported for this tool.</li> : null}
          </ul>
        </section>
      </div>
    </div>
  );
}
