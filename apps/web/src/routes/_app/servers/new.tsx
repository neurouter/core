import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as z from 'zod';
import { AlertCircleIcon, CheckIcon, CircleDashedIcon, FileUpIcon, LoaderCircleIcon, SparklesIcon, XIcon } from 'lucide-react';
import { api, readinessBand, SAMPLE_SPEC_URL, type EnvironmentCreate, type SpecPreview, type UpstreamAuthIn } from '@/contract';
import { guard } from '@/app/route-guards';
import { GatedButton, useGate } from '@/components/app/gated';
import { ButtonTabs } from '@/components/app/link-tabs';
import { CodeView } from '@/components/code/code-view';
import { FileDrop } from '@/components/code/file-drop';
import { ErrorState } from '@/components/feedback/states';
import { useSetCrumbs } from '@/components/layout/crumbs';
import { PageHeader } from '@/components/layout/page-header';
import { Pill, SpecKindBadge, WriteBadge, specFormatLabel } from '@/components/status/status';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import { runQuery } from '@/features/evals/queries';
import { BAND_LABEL } from '@/features/readiness/score';
import { ModeRecommendation } from '@/features/readiness/mode-recommendation';
import { ScoreRing } from '@/features/readiness/score-ring';
import { slugify } from '@/features/servers/slug';
import { useMe } from '@/hooks/use-me';
import { ApiError, apiFetch } from '@/lib/api-client';
import { formatDuration, formatNumber } from '@/lib/format';
import { notifyError } from '@/lib/notify';
import { readStorage, writeStorage } from '@/lib/storage';
import { cn } from '@/lib/utils';

const STEPS = ['source', 'compile', 'tools', 'environment', 'readiness'] as const;
type Step = (typeof STEPS)[number];

const search = z.object({
  step: z.enum(STEPS).optional().catch(undefined),
  draft: z.string().optional().catch(undefined),
  tab: z.enum(['url', 'upload', 'paste', 'graphql']).optional().catch(undefined),
  sample: z.coerce.string().optional().catch(undefined),
  /** Created server and its quick-eval run (step 5), so a refresh resumes. */
  server: z.string().optional().catch(undefined),
  run: z.string().optional().catch(undefined),
});

export const Route = createFileRoute('/_app/servers/new')({
  validateSearch: search,
  beforeLoad: guard(['servers:write']),
  staticData: { crumbs: ['Import a spec'] },
  component: ImportWizard,
});

/** The bundled sample (fictional Acme Orders API): the server answers this URL from its bundled copy. */
export const SAMPLE_URL = SAMPLE_SPEC_URL;

const draftQuery = (id: string) => ({
  queryKey: ['spec-preview', id] as const,
  queryFn: ({ signal }: { signal: AbortSignal }) => apiFetch(api.specs.draft, { params: { id }, signal }),
  refetchInterval: (q: { state: { data?: SpecPreview } }) => (q.state.data && q.state.data.status === 'compiling' ? 400 : false),
});

/** Wizard environment draft, kept in sessionStorage per preview (the API has no place for it before the server exists). */
type EnvDraft = { add: boolean; slug: string; kind: 'dev' | 'qa' | 'prod'; baseUrl: string; authType: 'none' | 'header' | 'bearer' | 'oauth_passthrough'; headerName: string; secretRef: string };
const envKey = (draft: string) => `neurouter-console-wizard-env-${draft}`;
const DEFAULT_ENV: EnvDraft = { add: false, slug: 'dev', kind: 'dev', baseUrl: '', authType: 'header', headerName: 'X-Api-Key', secretRef: '' };

/**
 * The environment step's starting point from what the import already knows (`SpecPreview.environmentHint`).
 * A GraphQL endpoint was just introspected from the server, so it is a live upstream: the environment starts
 * ON with its origin and the introspection header (a reference, or just the header name for a literal value).
 * An OpenAPI `servers[0].url` is only a declaration (often production or a placeholder): it fills the base
 * URL, but adding the environment stays opt-in.
 */
export function envDraftFromHint(h: SpecPreview['environmentHint']): EnvDraft {
  if (!h) return DEFAULT_ENV;
  const env: EnvDraft = { ...DEFAULT_ENV, baseUrl: h.baseUrl };
  if (h.source !== 'graphql_endpoint') return env;
  if (!h.auth) return { ...env, add: true, authType: 'none' };
  return { ...env, add: true, authType: h.auth.type, headerName: h.auth.type === 'header' ? h.auth.headerName : DEFAULT_ENV.headerName, secretRef: h.auth.secretRef ?? '' };
}

/** The wizard's environment draft: what the user changed (sessionStorage) over the import's prefill. */
function loadEnvDraft(preview: SpecPreview): EnvDraft {
  const base = envDraftFromHint(preview.environmentHint);
  try {
    return { ...base, ...(JSON.parse(readStorage(envKey(preview.id)) ?? '{}') as Partial<EnvDraft>) };
  } catch {
    return base;
  }
}

export function toEnvironmentCreate(e: EnvDraft): EnvironmentCreate[] {
  if (!e.add || !e.baseUrl) return [];
  const auth: UpstreamAuthIn =
    e.authType === 'none' ? { type: 'none' } : e.authType === 'bearer' ? { type: 'bearer', secretRef: e.secretRef } : e.authType === 'header' ? { type: 'header', headerName: e.headerName, secretRef: e.secretRef } : { type: 'oauth_passthrough', mode: 'broker', scopes: [] };
  return [{ slug: e.slug, kind: e.kind, baseUrl: e.baseUrl, auth }];
}

const STEP_LABEL: Record<Step, [string, string]> = {
  source: ['Source', 'URL, file or paste'],
  compile: ['Compile', 'Parse and validate'],
  tools: ['Tools', 'Rename, hide, review'],
  environment: ['Environment', 'Base URL and credentials'],
  readiness: ['Readiness', 'Score how well agents do'],
};

function ImportWizard() {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const step: Step = s.draft ? (s.step ?? 'compile') : 'source';
  const preview = useQuery({ ...draftQuery(s.draft ?? ''), enabled: !!s.draft });
  const title = preview.data?.name ?? preview.data?.title ?? null;
  useSetCrumbs([{ label: 'Import a spec', to: '/servers/new' }, ...(title ? [{ label: title }] : [])]);
  const go = (next: Step, extra: Record<string, string | undefined> = {}) => void navigate({ search: (p) => ({ ...p, step: next, ...extra }) });
  const idx = STEPS.indexOf(step);
  const sub = (st: Step): string => {
    const pv = preview.data;
    if (!pv) return STEP_LABEL[st][1];
    if (st === 'source') return pv.format ? `${specFormatLabel(pv.format)} ${pv.kind === 'graphql' ? 'schema' : 'file'}` : STEP_LABEL.source[1];
    if (st === 'compile' && pv.status === 'ready') return `${pv.operationCount} operations, ${pv.diagnostics.filter((d) => d.severity === 'error').length} errors`;
    if (st === 'tools' && idx > 2) return `${pv.tools.filter((t) => !t.hidden).length} exposed, ${pv.counts.hiddenByDefault} hidden`;
    return STEP_LABEL[st][1];
  };
  if (preview.isError && s.draft) {
    return (
      <>
        <PageHeader title="Import a spec" />
        <ErrorState error={preview.error} />
        <Button className="self-start" render={<Link to="/servers/new" />} nativeButton={false}>
          Start again
        </Button>
      </>
    );
  }
  return (
    <div className="-mx-4 -mt-6 -mb-10 flex min-h-[calc(100svh-3.5rem)] flex-col md:-mx-8 md:flex-row">
      {/* step rail: left column ≥ 768 px, a top progress bar below (spec §10) */}
      <nav aria-label="Import steps" className="hidden shrink-0 bg-brand-muted px-5 py-7 md:block md:w-[260px]">
        <ol className="flex flex-col gap-1.5">
          {STEPS.map((st, i) => {
            const state = i < idx ? 'done' : i === idx ? 'now' : 'next';
            return (
              <li key={st} aria-current={state === 'now' ? 'step' : undefined} className={cn('flex items-start gap-3 rounded-[10px] px-3 py-2.5', state === 'now' && 'bg-card ring-1 ring-brand-border')}>
                <span
                  aria-hidden="true"
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                    state === 'done' ? 'bg-primary text-primary-foreground' : state === 'now' ? 'border-2 border-primary bg-card text-primary' : 'border border-brand-border bg-card',
                  )}
                >
                  {state === 'done' ? <CheckIcon className="size-3.5" /> : state === 'now' ? i + 1 : ''}
                </span>
                <span className="flex flex-col">
                  <span className="font-semibold">
                    <span className="sr-only">Step {i + 1}: </span>
                    {STEP_LABEL[st][0]}
                    {state === 'done' ? <span className="sr-only"> (done)</span> : null}
                  </span>
                  <span className="text-[12.5px] text-muted-foreground">{sub(st)}</span>
                </span>
              </li>
            );
          })}
        </ol>
      </nav>
      <div className="border-b px-4 py-3 md:hidden">
        <div className="mb-1.5 flex justify-between text-[13px]">
          <span className="font-semibold">{STEP_LABEL[step][0]}</span>
          <span className="text-muted-foreground">
            Step {idx + 1} of {STEPS.length}
          </span>
        </div>
        <Progress value={((idx + 1) / STEPS.length) * 100} aria-label={`Step ${idx + 1} of ${STEPS.length}`} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        {step === 'source' ? <SourceStep onCompiled={(id) => go('compile', { draft: id })} /> : null}
        {step !== 'source' && !preview.data ? <div className="p-8 text-muted-foreground">Loading the import…</div> : null}
        {step === 'compile' && preview.data ? <CompileStep preview={preview.data} onBack={() => void navigate({ search: {} })} onNext={() => go('tools')} /> : null}
        {step === 'tools' && preview.data ? <ToolsStep preview={preview.data} onBack={() => go('compile')} onNext={() => go('environment')} /> : null}
        {step === 'environment' && preview.data ? <EnvironmentStep preview={preview.data} onBack={() => go('tools')} onNext={() => go('readiness')} /> : null}
        {step === 'readiness' && preview.data ? <ReadinessStep preview={preview.data} serverId={s.server} runId={s.run} onBack={() => go('environment')} onState={(extra) => go('readiness', extra)} /> : null}
      </div>
    </div>
  );
}

/* ================================================================== shell */

function StepBody({ title, description, children, errors }: { title: string; description?: React.ReactNode; children: React.ReactNode; errors?: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (errors?.length) ref.current?.focus();
  }, [errors?.length]);
  return (
    <div className="flex flex-1 flex-col gap-5 px-4 py-6 md:px-8 md:py-7">
      <PageHeader title={title} description={description} />
      {errors?.length ? (
        <div ref={ref} tabIndex={-1} role="alert" className="rounded-lg border border-destructive/40 bg-destructive-muted p-3 text-[13.5px] outline-none">
          <strong>Fix these before you continue:</strong>
          <ul className="mt-1 list-disc pl-5">
            {errors.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {children}
    </div>
  );
}

function StepFooter({ step, onBack, next }: { step: number; onBack?: () => void; next: React.ReactNode }) {
  return (
    <footer className="sticky bottom-0 flex items-center gap-2.5 border-t bg-background px-4 py-3 md:px-8">
      <span className="flex-1 text-[13px] text-muted-foreground">
        Step {step} of {STEPS.length}
      </span>
      {onBack ? (
        <Button variant="outline" size="lg" onClick={onBack}>
          Back
        </Button>
      ) : null}
      {next}
    </footer>
  );
}

/* ================================================================== step 1: source */

const FETCH_MESSAGES: Record<string, string> = {
  unreachable: 'The URL did not respond. Check that it is reachable from the Neurouter server.',
  too_large: 'The spec is larger than 10 MB.',
  not_a_spec: 'The URL returned something that is not an OpenAPI 3.x or GraphQL document.',
  blocked_host: 'That host is blocked: private networks and cloud metadata addresses are not allowed.',
  unauthorized: 'The GraphQL endpoint refused the request (401/403). Add an Authorization header and try again.',
  introspection_disabled: 'The GraphQL endpoint has introspection turned off. Paste or upload the SDL or an introspection JSON instead.',
  not_graphql: 'The URL did not answer like a GraphQL endpoint. Check the URL (usually it ends in /graphql).',
};

export function sourceErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return 'Something went wrong. Try again.';
  if (err.code === 'spec_fetch_failed') return FETCH_MESSAGES[err.reason ?? ''] ?? err.detail ?? err.title;
  if (err.code === 'spec_unsupported') return err.detail ?? 'Unsupported spec. Swagger 2.0 must be converted to OpenAPI 3.x first.';
  if (err.isDemoReadOnly) return err.detail ?? 'The demo imports the sample spec only.';
  return err.detail ?? err.title;
}

function SourceStep({ onCompiled }: { onCompiled: (previewId: string) => void }) {
  const s = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const [tab, setTab] = useState<'url' | 'upload' | 'paste' | 'graphql'>(s.tab ?? 'url');
  const [url, setUrl] = useState(s.sample ? SAMPLE_URL : '');
  const [gqlUrl, setGqlUrl] = useState('');
  const [gqlHeaderName, setGqlHeaderName] = useState('Authorization');
  const [gqlHeaderValue, setGqlHeaderValue] = useState('');
  const [paste, setPaste] = useState('');
  const [file, setFile] = useState<{ name: string; content: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: (source: { url: string } | { content: string; filename?: string } | { graphqlEndpoint: string; headers?: { name: string; value: string }[] }) => apiFetch(api.specs.preview, { body: { source } }),
    onSuccess: (r) => onCompiled(r.previewId),
    onError: (err) => setError(sourceErrorMessage(err)),
  });
  const submit = (e?: React.FormEvent) => {
    e?.preventDefault();
    setError(null);
    if (tab === 'url') create.mutate({ url: url.trim() });
    else if (tab === 'graphql') create.mutate({ graphqlEndpoint: gqlUrl.trim(), ...(gqlHeaderName.trim() && gqlHeaderValue ? { headers: [{ name: gqlHeaderName.trim(), value: gqlHeaderValue }] } : {}) });
    else if (tab === 'upload' && file) create.mutate({ content: file.content, filename: file.name });
    else if (tab === 'paste') create.mutate({ content: paste });
  };
  const ready = tab === 'url' ? /^https?:\/\/.+/.test(url.trim()) : tab === 'graphql' ? /^https?:\/\/.+/.test(gqlUrl.trim()) : tab === 'upload' ? !!file : paste.trim().length > 0;
  return (
    <>
      <StepBody title="Import a spec" description="Neurouter compiles an OpenAPI 3.x or GraphQL spec into MCP tools. Nothing calls your API until you add an environment.">
        <ButtonTabs
          label="Source"
          value={tab}
          onChange={(v) => {
            setTab(v);
            setError(null);
            void navigate({ search: (p) => ({ ...p, tab: v }), replace: true });
          }}
          tabs={[
            { value: 'url', label: 'URL' },
            { value: 'upload', label: 'Upload' },
            { value: 'paste', label: 'Paste' },
            { value: 'graphql', label: 'GraphQL endpoint' },
          ]}
        />
        <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        <form id="source-form" onSubmit={submit} className="flex max-w-2xl flex-col gap-3">
          {tab === 'url' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spec-url">Spec URL</Label>
              <Input id="spec-url" type="url" inputMode="url" placeholder="https://api.example.com/openapi.yaml" value={url} onChange={(e) => setUrl(e.target.value)} aria-describedby={error ? 'source-error' : undefined} aria-invalid={error ? true : undefined} />
              <p className="text-[12.5px] text-muted-foreground">OpenAPI 3.0 or 3.1, YAML or JSON. Swagger 2.0 needs converting first.</p>
            </div>
          ) : null}
          {tab === 'graphql' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="gql-url">GraphQL endpoint</Label>
              <Input id="gql-url" type="url" placeholder="https://api.example.com/graphql" value={gqlUrl} onChange={(e) => setGqlUrl(e.target.value)} />
              <p className="text-[12.5px] text-muted-foreground">Neurouter runs one introspection query from the server. Upstream credentials for tool calls are set later, per environment.</p>
              <div className="mt-2 flex flex-wrap gap-3">
                <div className="flex min-w-40 flex-col gap-1.5">
                  <Label htmlFor="gql-header-name">Header (optional)</Label>
                  <Input id="gql-header-name" placeholder="Authorization" value={gqlHeaderName} onChange={(e) => setGqlHeaderName(e.target.value)} />
                </div>
                <div className="flex min-w-64 flex-1 flex-col gap-1.5">
                  <Label htmlFor="gql-header-value">Value</Label>
                  <Input id="gql-header-value" type="password" autoComplete="off" placeholder="Bearer …" value={gqlHeaderValue} onChange={(e) => setGqlHeaderValue(e.target.value)} />
                </div>
              </div>
              <p className="text-[12.5px] text-muted-foreground">Sent with the introspection request only; never stored.</p>
            </div>
          ) : null}
          {tab === 'upload' ? <FileDrop accept=".yaml,.yml,.json,.graphql,.gql" maxBytes={10 * 1024 * 1024} file={file} onFile={(f) => setFile(f)} onError={setError} /> : null}
          {tab === 'paste' ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="spec-paste">Spec</Label>
              <Textarea id="spec-paste" rows={12} className="font-mono text-[12.5px]" placeholder={'openapi: 3.1.0\ninfo:\n  title: My API\npaths: …'} value={paste} onChange={(e) => setPaste(e.target.value)} />
            </div>
          ) : null}
          {error ? (
            <Alert variant="destructive" id="source-error">
              <AlertCircleIcon />
              <AlertTitle>Could not import the spec</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <button
            type="button"
            className="inline-flex items-center gap-1.5 self-start text-[13.5px] font-medium text-primary hover:underline"
            onClick={() => {
              setTab('url');
              setUrl(SAMPLE_URL);
              setError(null);
              create.mutate({ url: SAMPLE_URL });
            }}
          >
            <SparklesIcon aria-hidden="true" className="size-4" /> Try the sample: Acme Orders API (fictional)
          </button>
        </form>
        </div>
      </StepBody>
      <StepFooter
        step={1}
        next={
          <GatedButton cap="servers:write" demoOp="specs.preview" size="lg" type="submit" form="source-form" disabled={!ready || create.isPending}>
            {create.isPending ? <LoaderCircleIcon className="animate-spin" /> : <FileUpIcon />}
            {tab === 'url' || tab === 'graphql' ? 'Fetch and compile' : 'Compile'}
          </GatedButton>
        }
      />
    </>
  );
}

/* ================================================================== step 2: compile */

function useDraftUpdate(previewId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name?: string; slug?: string; overlayOps?: { op: 'set'; selector: string; field: 'name' | 'hidden'; value: unknown }[] }) => apiFetch(api.specs.draftUpdate, { params: { id: previewId }, body }),
    onSuccess: (pv) => qc.setQueryData(['spec-preview', previewId], pv),
  });
}

const STAGE_LABEL = { fetch: 'Fetch', parse: 'Parse', validate: 'Validate', normalize: 'Normalize', generate: 'Generate tools' } as const;

function CompileStep({ preview, onBack, onNext }: { preview: SpecPreview; onBack: () => void; onNext: () => void }) {
  const update = useDraftUpdate(preview.id);
  const [nameEdit, setName] = useState<string | null>(null);
  const [slugEdit, setSlug] = useState<string | null>(null);
  // prefilled from info.title once the compile is done (spec §9.2)
  const name = nameEdit ?? preview.name ?? preview.title ?? '';
  const slug = slugEdit ?? preview.slug ?? preview.suggestedSlug ?? (preview.title ? slugify(preview.title) : '');
  const [slugError, setSlugError] = useState<string | null>(null);
  const [slow, setSlow] = useState(false);
  const qc = useQueryClient();
  useEffect(() => {
    if (preview.status !== 'compiling') return;
    const t = setTimeout(() => setSlow(true), 10_000);
    return () => clearTimeout(t);
  }, [preview.status]);
  const errors = preview.diagnostics.filter((d) => d.severity === 'error');
  const warnings = preview.diagnostics.filter((d) => d.severity !== 'error');
  const ready = preview.status === 'ready';
  const save = () => {
    setSlugError(null);
    update.mutate({ name, slug }, { onError: (err) => setSlugError(err instanceof ApiError ? (err.fieldErrors[0]?.message ?? err.detail ?? err.title) : 'Could not save') });
  };
  const cancel = useMutation({
    mutationFn: () => apiFetch(api.specs.cancelPreview, { params: { id: preview.id } }),
    onSettled: () => {
      qc.removeQueries({ queryKey: ['spec-preview', preview.id] });
      onBack();
    },
  });
  const blocked = errors.length > 0 || preview.status === 'failed';
  return (
    <>
      <StepBody title={ready ? (blocked ? 'The spec has errors' : 'Compiled') : 'Compiling…'} description={preview.format ? <SpecKindBadge format={preview.format} detail={`${preview.operationCount} operations`} /> : 'Fetching and parsing the spec.'} errors={blocked ? ['Fix the spec and re-upload it. Errors are listed below.'] : undefined}>
        <ol aria-label="Compile stages" className="flex flex-wrap gap-2" aria-live="polite">
          {preview.stages.map((st) => (
            <li key={st.name} className="flex items-center gap-1.5 rounded-full border px-3 py-1 text-[13px]">
              {st.status === 'ok' ? <CheckIcon aria-hidden="true" className="size-3.5 text-success" /> : st.status === 'running' ? <LoaderCircleIcon aria-hidden="true" className="size-3.5 animate-spin text-primary" /> : st.status === 'failed' ? <XIcon aria-hidden="true" className="size-3.5 text-destructive" /> : <CircleDashedIcon aria-hidden="true" className="size-3.5 text-muted-foreground" />}
              {STAGE_LABEL[st.name]}
              <span className="sr-only">: {st.status}</span>
              {st.durationMs !== null ? <span className="text-xs text-muted-foreground">{formatDuration(st.durationMs)}</span> : null}
            </li>
          ))}
        </ol>
        {!ready && slow ? (
          <div className="flex items-center gap-3 text-[13.5px] text-muted-foreground">
            Large specs take a while.
            <Button variant="outline" size="sm" onClick={() => cancel.mutate()}>
              Cancel
            </Button>
          </div>
        ) : null}
        {ready ? (
          <>
            <dl className="grid max-w-2xl grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                ['Operations', preview.operationCount],
                ['Tools', preview.counts.tools],
                ['Write tools', preview.counts.writeTools],
                ['Hidden by default', preview.counts.hiddenByDefault],
              ].map(([l, v]) => (
                <div key={l} className="rounded-xl border p-3">
                  <dt className="text-[12.5px] text-muted-foreground">{l}</dt>
                  <dd className="text-xl font-semibold tabular-nums">{formatNumber(v as number)}</dd>
                </div>
              ))}
            </dl>
            <div className="grid max-w-2xl gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="srv-name">Server name</Label>
                <Input id="srv-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={save} />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="srv-slug">Slug</Label>
                <Input id="srv-slug" value={slug} onChange={(e) => setSlug(slugify(e.target.value, false))} onBlur={save} aria-invalid={slugError ? true : undefined} aria-describedby="slug-help" className="font-mono" />
                <p id="slug-help" className={cn('text-[12.5px]', slugError ? 'text-destructive' : 'text-muted-foreground')}>
                  {slugError ?? 'Used in the MCP URL (/mcp/<slug>/<environment>). It cannot change later.'}
                </p>
              </div>
            </div>
            <section aria-labelledby="diag-title" className="flex flex-col gap-2">
              <h2 id="diag-title" className="text-base font-semibold">
                Diagnostics <span className="text-sm font-normal text-muted-foreground">({errors.length} errors, {warnings.length} warnings)</span>
              </h2>
              {preview.diagnostics.length === 0 ? <p className="text-[13.5px] text-muted-foreground">No issues found.</p> : null}
              <ul className="flex flex-col gap-2">
                {[...errors, ...warnings].map((d, i) => (
                  <li key={i} className="rounded-xl border p-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Pill tone={d.severity === 'error' ? 'err' : d.severity === 'warning' ? 'warn' : 'muted'}>{d.severity}</Pill>
                      <span className="text-[13.5px]">{d.message}</span>
                      {d.pointer ? <code className="font-mono text-xs text-muted-foreground">{d.pointer}</code> : null}
                    </div>
                    {d.excerpt ? (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-[13px] text-primary">View in spec</summary>
                        <CodeView code={d.excerpt} lang="yaml" className="mt-2" label={`Spec excerpt at ${d.pointer ?? ''}`} />
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          </>
        ) : null}
      </StepBody>
      <StepFooter
        step={2}
        onBack={() => cancel.mutate()}
        next={
          <Button size="lg" onClick={onNext} disabled={!ready || blocked}>
            Next: Tools
          </Button>
        }
      />
    </>
  );
}

/* ================================================================== step 3: tools */

export const previewSelector = (t: SpecPreview['tools'][number]) => (t.field ? `graphql:${t.field}` : `${t.method} ${t.path}`);

function ToolsStep({ preview, onBack, onNext }: { preview: SpecPreview; onBack: () => void; onNext: () => void }) {
  const update = useDraftUpdate(preview.id);
  const [showHidden, setShowHidden] = useState(true);
  const [names, setNames] = useState<Record<string, string>>({});
  const [nameErrors, setNameErrors] = useState<Record<string, string>>({});
  const tools = preview.tools;
  const exposed = tools.filter((t) => !t.hidden).length;
  const writes = tools.filter((t) => t.write && !t.hidden).length;
  const deprecated = tools.filter((t) => !t.hidden && t.suggestedHide.some((r) => /deprecated/.test(r)));
  const visibleRows = showHidden ? tools : tools.filter((t) => !t.hidden);
  const setHidden = (sel: string[], hidden: boolean) => update.mutate({ overlayOps: sel.map((selector) => ({ op: 'set' as const, selector, field: 'hidden' as const, value: hidden })) }, { onError: (e) => notifyError(e, 'Could not update the tools') });
  const rename = (t: SpecPreview['tools'][number], value: string) => {
    const sel = previewSelector(t);
    if (value === t.name) return;
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(value)) return setNameErrors((e) => ({ ...e, [sel]: 'Use snake_case: lowercase letters, digits and underscores' }));
    if (tools.some((x) => x !== t && x.name === value)) return setNameErrors((e) => ({ ...e, [sel]: `${value} is already used by another tool` }));
    setNameErrors((e) => {
      const n = { ...e };
      delete n[sel];
      return n;
    });
    update.mutate({ overlayOps: [{ op: 'set', selector: sel, field: 'name', value }] });
  };
  const qualTone = { ok: 'ok', short: 'warn', none: 'err' } as const;
  return (
    <>
      <StepBody
        title="Choose the tools agents will see"
        description={
          <>
            Neurouter compiled {preview.operationCount} operations{preview.title ? <> from <span className="font-mono text-[13px]">{preview.title}</span></> : null}. Names and visibility you change here are saved as an overlay, so re-importing the spec keeps them.
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3">
          <span className="font-semibold" aria-live="polite">
            {exposed} of {tools.length} tools exposed
          </span>
          <span className="text-muted-foreground" aria-hidden="true">
            ·
          </span>
          <span>
            <span className="font-semibold text-warning">{writes} write tools</span> (off everywhere until you enable them)
          </span>
          <span className="flex-1" />
          <Button variant="outline" size="sm" disabled={!deprecated.length} onClick={() => setHidden(deprecated.map(previewSelector), true)}>
            Hide deprecated ({deprecated.length})
          </Button>
          <label className="inline-flex items-center gap-1.5 text-[13px]">
            <Checkbox checked={showHidden} onCheckedChange={(v) => setShowHidden(!!v)} /> Show hidden
          </label>
        </div>
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[760px] text-[13.5px]">
            <caption className="sr-only">Tools generated from the spec</caption>
            <thead>
              <tr className="bg-muted/50 text-left text-muted-foreground">
                <th scope="col" className="w-9 px-3.5 py-2 font-medium">
                  <span className="sr-only">Include</span>
                </th>
                <th scope="col" className="px-2 py-2 font-medium">Tool name</th>
                <th scope="col" className="px-2 py-2 font-medium">Operation</th>
                <th scope="col" className="px-2 py-2 font-medium">Kind</th>
                <th scope="col" className="px-2 py-2 font-medium">Description</th>
                <th scope="col" className="px-3.5 py-2 font-medium">Suggestion</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((t) => {
                const sel = previewSelector(t);
                const err = nameErrors[sel];
                return (
                  <tr key={sel} className={cn('border-t', t.hidden && 'bg-muted/40 text-muted-foreground')}>
                    <td className="px-3.5 py-2">
                      <Checkbox checked={!t.hidden} onCheckedChange={(v) => setHidden([sel], !v)} aria-label={`Include ${t.name}`} />
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex flex-col gap-0.5">
                        <Input
                          value={names[sel] ?? t.name}
                          onChange={(e) => setNames((n) => ({ ...n, [sel]: e.target.value }))}
                          onBlur={(e) => rename(t, e.target.value)}
                          aria-label={`Tool name for ${t.method ? `${t.method} ${t.path}` : t.field}`}
                          aria-invalid={err ? true : undefined}
                          aria-describedby={err ? `err-${sel}` : undefined}
                          className="h-7 w-[200px] font-mono text-[12.5px]"
                        />
                        {err ? (
                          <span id={`err-${sel}`} className="text-xs text-destructive">
                            {err}
                          </span>
                        ) : t.title && t.title !== t.name ? (
                          <span className="font-mono text-xs text-muted-foreground">{t.title}</span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-2 py-2 font-mono text-[12.5px] whitespace-nowrap">{t.method ? `${t.method} ${t.path}` : t.field}</td>
                    <td className="px-2 py-2">
                      <WriteBadge write={t.write} />
                    </td>
                    <td className="px-2 py-2">
                      <Pill tone={qualTone[t.descriptionQuality]}>{t.descriptionQuality}</Pill>
                    </td>
                    <td className="px-3.5 py-2">
                      {t.suggestedHide.map((r) => (
                        <Pill key={r} tone="err">
                          suggested hide: {r}
                        </Pill>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <span className="text-[12.5px] text-muted-foreground">Descriptions marked “none” or “short” lower the readiness score. You can rewrite them in the overlay editor after the import.</span>
      </StepBody>
      <StepFooter
        step={3}
        onBack={onBack}
        next={
          <Button size="lg" onClick={onNext} disabled={Object.keys(nameErrors).length > 0}>
            Next: Environment
          </Button>
        }
      />
    </>
  );
}

/* ================================================================== step 4: environment */

function EnvironmentStep({ preview, onBack, onNext }: { preview: SpecPreview; onBack: () => void; onNext: () => void }) {
  const [env, setEnv] = useState<EnvDraft>(() => loadEnvDraft(preview));
  useEffect(() => writeStorage(envKey(preview.id), JSON.stringify(env)), [env, preview.id]);
  const test = useMutation({ mutationFn: () => apiFetch(api.environments.testDraft, { params: { id: preview.id }, body: { baseUrl: env.baseUrl, auth: toEnvironmentCreate({ ...env, add: true })[0]!.auth } }) });
  const refOk = env.authType === 'none' || env.authType === 'oauth_passthrough' || /^(env:[A-Za-z_][A-Za-z0-9_]{0,127}|secret:[A-Za-z0-9][A-Za-z0-9._-]{0,127})$/.test(env.secretRef);
  const urlOk = /^https?:\/\/.+/.test(env.baseUrl);
  const problems = env.add ? [...(!urlOk ? ['Enter the base URL (http or https).'] : []), ...(!refOk ? ['The credential must be a reference: env:NAME or secret:NAME. Literal secrets are not stored.'] : [])] : [];
  const [showProblems, setShowProblems] = useState(false);
  const set = (patch: Partial<EnvDraft>) => setEnv((e) => ({ ...e, ...patch }));
  const hint = preview.environmentHint;
  return (
    <>
      <StepBody title="Add an environment (optional)" description={<>Agents and evals can use the built-in <strong>mock</strong> environment right away. Add <strong>dev</strong> to call your real API.</>} errors={showProblems ? problems : undefined}>
        <div className="flex items-start gap-2.5 rounded-xl bg-brand-muted px-4 py-3 text-[13.5px]">
          Read-only by default. Write tools stay off until you enable them per environment.
        </div>
        <label className="inline-flex items-center gap-2 font-medium">
          <Checkbox checked={env.add} onCheckedChange={(v) => set({ add: !!v })} /> Add a dev environment now
        </label>
        {env.add ? (
          <div className="grid max-w-2xl gap-4">
            <div className="grid gap-3 sm:grid-cols-[120px_1fr]">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="env-slug">Name</Label>
                <Input id="env-slug" value={env.slug} onChange={(e) => set({ slug: slugify(e.target.value, false).slice(0, 31) || 'dev' })} className="font-mono" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="env-url">Base URL</Label>
                <Input id="env-url" type="url" placeholder="https://dev.api.example.com" value={env.baseUrl} onChange={(e) => set({ baseUrl: e.target.value })} aria-invalid={showProblems && !urlOk ? true : undefined} aria-describedby={hint ? 'env-url-help' : undefined} />
                {hint ? (
                  <p id="env-url-help" className="text-[12.5px] text-muted-foreground">
                    {hint.source === 'graphql_endpoint' ? 'From the GraphQL endpoint you imported. ' : 'From the spec’s servers list. '}
                    {hint.endpointPath ? (
                      <>
                        Tool calls POST to <code className="break-all">{env.baseUrl.replace(/\/+$/, '') + hint.endpointPath}</code>
                      </>
                    ) : null}
                  </p>
                ) : null}
              </div>
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">Authentication</legend>
              <div className="flex flex-wrap gap-3 text-[13.5px]">
                {(
                  [
                    ['none', 'None'],
                    ['header', 'API key header'],
                    ['bearer', 'Bearer token'],
                    ['oauth_passthrough', 'OAuth passthrough'],
                  ] as const
                ).map(([v, l]) => (
                  <label key={v} className="inline-flex items-center gap-1.5">
                    <input type="radio" name="auth" value={v} checked={env.authType === v} onChange={() => set({ authType: v })} className="accent-[var(--primary)]" />
                    {l}
                  </label>
                ))}
              </div>
            </fieldset>
            {env.authType === 'header' ? (
              <div className="flex flex-col gap-1.5 sm:max-w-xs">
                <Label htmlFor="env-header">Header name</Label>
                <Input id="env-header" value={env.headerName} onChange={(e) => set({ headerName: e.target.value })} className="font-mono" />
              </div>
            ) : null}
            {env.authType === 'header' || env.authType === 'bearer' ? (
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="env-ref">Credential reference</Label>
                <Input id="env-ref" placeholder="env:ACME_DEV_TOKEN" value={env.secretRef} onChange={(e) => set({ secretRef: e.target.value.trim() })} className="font-mono" aria-invalid={showProblems && !refOk ? true : undefined} aria-describedby="env-ref-help" />
                <p id="env-ref-help" className="text-[12.5px] text-muted-foreground">
                  <code>env:NAME</code> reads an environment variable of the Neurouter server. To store a secret instead, add it on the Environments tab after the import.
                </p>
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" disabled={!urlOk || !refOk || test.isPending} onClick={() => test.mutate()}>
                {test.isPending ? <LoaderCircleIcon className="animate-spin" /> : null} Test connection
              </Button>
              {test.data ? (
                <span role="status" className={cn('text-[13.5px]', test.data.ok ? 'text-success' : 'text-destructive')}>
                  {test.data.ok ? `Connected in ${formatDuration(test.data.latencyMs)}` : 'Could not connect'}
                  {test.data.detail ? ` · ${test.data.detail}` : ''}
                  {test.data.credential === 'missing' ? ' · credential missing' : ''}
                </span>
              ) : null}
              {test.isError ? <span role="status" className="text-[13.5px] text-destructive">{sourceErrorMessage(test.error)}</span> : null}
            </div>
          </div>
        ) : null}
      </StepBody>
      <StepFooter
        step={4}
        onBack={onBack}
        next={
          <>
            {env.add ? (
              <Button variant="ghost" size="lg" onClick={() => (set({ add: false }), onNext())}>
                Skip for now
              </Button>
            ) : null}
            <Button
              size="lg"
              onClick={() => {
                if (problems.length) return setShowProblems(true);
                onNext();
              }}
            >
              {env.add ? 'Next: Readiness' : 'Skip for now'}
            </Button>
          </>
        }
      />
    </>
  );
}

/* ================================================================== step 5: readiness */

const LINT_LABEL: Record<string, string> = { description_present: 'Descriptions', examples_present: 'Examples', names_clear: 'Naming', params_described: 'Argument descriptions', toolset_size: 'Toolset size', output_shaped: 'Response shaping', description_actionable: 'Actionable descriptions', params_typed: 'Typed arguments', writes_marked: 'Writes marked', schema_depth: 'Schema depth' };

function ReadinessStep({ preview, serverId, runId, onBack, onState }: { preview: SpecPreview; serverId?: string | undefined; runId?: string | undefined; onBack: () => void; onState: (extra: Record<string, string>) => void }) {
  const me = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const evalGate = useGate('evals:run', 'evals.createRun');
  const env = useMemo<EnvDraft>(() => loadEnvDraft(preview), [preview.id]); // eslint-disable-line react-hooks/exhaustive-deps -- read once per preview
  const createServer = useMutation({
    mutationFn: async () => {
      if (serverId) return serverId;
      const res = await apiFetch(api.servers.create, { body: { previewId: preview.id, slug: preview.slug ?? preview.suggestedSlug ?? 'imported-api', name: preview.name ?? preview.title ?? 'Imported API', environments: toEnvironmentCreate(env) } });
      void qc.invalidateQueries({ queryKey: ['servers'] });
      return 'server' in res ? res.server.id : res.id;
    },
  });
  const startRun = useMutation({
    mutationFn: async () => {
      const id = await createServer.mutateAsync();
      const run = await apiFetch(api.evals.createRun, { body: { serverId: id, preset: 'quick' } });
      return { serverId: id, runId: run.id };
    },
    onSuccess: (r) => onState({ server: r.serverId, run: r.runId }),
    onError: (e) => notifyError(e, 'Could not start the quick eval'),
  });
  const finish = useMutation({
    mutationFn: () => createServer.mutateAsync(),
    onSuccess: (id) => void navigate({ to: '/servers/$serverId', params: { serverId: id }, search: { connect: '1' } }),
    onError: (e) => notifyError(e, 'Could not create the server'),
  });
  const run = useQuery({ ...runQuery(runId ?? ''), enabled: !!runId });
  const r = run.data;
  const done = r?.status === 'succeeded' && r.score;
  const running = !!runId && (!r || r.status === 'running' || r.status === 'queued');
  const prelim = preview.preliminaryScore ?? preview.lint?.score ?? 0;
  const lintRows = (preview.lint?.rules ?? []).filter((x) => ['description_present', 'examples_present', 'example_runs', 'names_clear'].includes(x.rule));
  const noModel = !me.features.evals;
  const modeCell = (mode: 'tool' | 'code') => {
    const cells = r?.matrix.filter((c) => c.mode === mode) ?? [];
    if (!cells.length) return null;
    const avg = (f: (c: (typeof cells)[number]) => number) => cells.reduce((a, c) => a + f(c), 0) / cells.length;
    return { success: Math.round(avg((c) => c.successRate) * 100), calls: avg((c) => c.avgCalls), tokens: avg((c) => c.avgTokens) };
  };
  const tool = modeCell('tool');
  const code = modeCell('code');
  return (
    <>
      <StepBody title="How ready is this API for agents?" description="The score says how often AI agents finish real tasks with these tools, safely and efficiently. It runs against the built-in mock environment, so nothing touches your API.">
        <section aria-live="polite" aria-label="Readiness" className="flex flex-wrap items-center gap-8 rounded-xl border p-6">
          {done ? (
            <ScoreRing score={r.score!.headline} size="xl" />
          ) : running ? (
            <ScoreRing size="xl" progress={r ? r.progress.done / Math.max(1, r.progress.total) : 0} progressLabel={r ? `${r.progress.done} / ${r.progress.total}` : '…'} />
          ) : (
            <ScoreRing score={prelim} size="xl" preliminary />
          )}
          <div className="flex min-w-[300px] flex-1 flex-col gap-3">
            {done ? (
              <>
                <span className="text-base font-semibold">
                  {r.score!.headline} · {BAND_LABEL[readinessBand(r.score!.headline)]}
                </span>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {tool ? (
                    <div className="rounded-[10px] border px-3 py-2.5">
                      <div className="text-[12.5px] font-semibold text-mode-tool">Tool mode</div>
                      <div className="text-lg font-semibold">{tool.success}% tasks</div>
                      <div className="text-[12.5px] text-muted-foreground">
                        {tool.calls.toFixed(1)} calls · {(tool.tokens / 1000).toFixed(1)}k tokens / task
                      </div>
                    </div>
                  ) : null}
                  {code ? (
                    <div className="rounded-[10px] border px-3 py-2.5">
                      <div className="text-[12.5px] font-semibold text-mode-code">Code mode</div>
                      <div className="text-lg font-semibold">{code.success}% tasks</div>
                      <div className="text-[12.5px] text-muted-foreground">
                        {code.calls.toFixed(1)} {code.calls < 1.5 ? 'script' : 'calls'} · {(code.tokens / 1000).toFixed(1)}k tokens / task
                      </div>
                    </div>
                  ) : null}
                </div>
                <ModeRecommendation mode={r.score!.recommendedMode} text={r.score!.recommendation} />
                {r.suggestionsCount ? (
                  <div className="rounded-[10px] bg-brand-muted px-3.5 py-3 text-[13.5px]">
                    <strong>{r.suggestionsCount} fixes</strong> are suggested. Review them to raise the score.
                  </div>
                ) : null}
              </>
            ) : running ? (
              <>
                <span className="text-base font-semibold">Running a quick eval…</span>
                <span className="text-muted-foreground">12 generated tasks × {r?.models[0] ?? 'one model'} × tool mode and code mode.</span>
                <Progress value={r ? (r.progress.done / Math.max(1, r.progress.total)) * 100 : 0} aria-label="Quick eval progress" />
              </>
            ) : (
              <>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold">Preliminary</span>
                  <span className="rounded-full border border-dashed border-muted-foreground/50 px-2 text-xs text-muted-foreground">no eval yet</span>
                </div>
                <ul className="flex flex-col gap-2.5" aria-label="Spec checks">
                  {lintRows.map((x) => {
                    const v = Math.round(x.score * 100);
                    return (
                      <li key={x.rule} className="grid grid-cols-[140px_1fr_44px] items-center gap-2.5 text-[13.5px]" title={x.detail}>
                        <span>{LINT_LABEL[x.rule] ?? x.rule}</span>
                        <span aria-hidden="true" className="h-2 overflow-hidden rounded-full bg-muted">
                          <span className={cn('block h-full', v >= 75 ? 'bg-success' : v >= 50 ? 'bg-warning' : 'bg-destructive')} style={{ width: `${v}%` }} />
                        </span>
                        <span className="text-right font-semibold tabular-nums">{v}%</span>
                      </li>
                    );
                  })}
                </ul>
                <p className="text-[13px] text-muted-foreground">Spec checks look at descriptions, examples and naming. A real score needs agents to try tasks.</p>
              </>
            )}
          </div>
        </section>
        {noModel && !runId ? (
          <Alert>
            <AlertCircleIcon />
            <AlertTitle>No model provider configured</AlertTitle>
            <AlertDescription>
              Evals use your own OpenAI, Anthropic or Gemini API key.{' '}
              <Link to="/settings" search={{ tab: 'models' }} className="font-medium text-primary underline">
                Add it in Settings › Models
              </Link>
              .
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-wrap gap-2.5">
          {!runId ? (
            <GatedButton cap="evals:run" demoOp="evals.createRun" size="lg" disabled={noModel || startRun.isPending} disabledReason={noModel ? 'Add a model provider key in Settings › Models first' : null} onClick={() => startRun.mutate()}>
              {startRun.isPending ? <LoaderCircleIcon className="animate-spin" /> : null}
              Run a quick eval (12 tasks · 1 model · tool + code)
            </GatedButton>
          ) : done ? (
            <Button size="lg" render={<Link to="/evals/runs/$runId" params={{ runId: r.id }} search={{ tab: 'fixes' }} />} nativeButton={false}>
              Review {r.suggestionsCount} fix suggestions
            </Button>
          ) : null}
          <Button variant="outline" size="lg" disabled={finish.isPending} onClick={() => (serverId ? void navigate({ to: '/servers/$serverId', params: { serverId }, search: { connect: '1' } }) : finish.mutate())}>
            Finish
          </Button>
        </div>
        <p className="text-[12.5px] text-muted-foreground">
          Evals use your own OpenAI, Anthropic or Gemini API key (Settings › Models). A quick eval costs roughly 120k tokens.
          {evalGate.reason ? ` ${evalGate.reason}.` : ''}
        </p>
      </StepBody>
      <StepFooter step={5} onBack={runId ? undefined : onBack} next={null} />
    </>
  );
}
