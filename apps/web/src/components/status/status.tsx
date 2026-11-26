import type { ReactNode } from 'react';
import {
  BanIcon, CheckCheckIcon, CheckIcon, CircleDashedIcon, CircleIcon, ClockIcon, FileCodeIcon, FlaskConicalIcon, PencilIcon, TriangleAlertIcon, XIcon,
  type LucideIcon,
} from 'lucide-react';
import { isBlockedDecision, type AuditDecision, type AuditStatus, type HealthStatus, type SpecFormat, type TaskFraming, type TaskOutcome } from '@neurouter/shared';
import { cn } from '@/lib/utils';
import { formatDuration } from '@/lib/format';
import { CopyButton } from '@/components/code/copy-button';

/**
 * Status pills. Status is never colour-only: every pill carries text, most also an icon
 * (frontend spec §11).
 */
export type Tone = 'ok' | 'warn' | 'err' | 'info' | 'muted' | 'outline' | 'brand';

const TONE: Record<Tone, string> = {
  ok: 'border-transparent bg-success-muted text-success',
  warn: 'border-transparent bg-warning-muted text-warning',
  err: 'border-transparent bg-destructive-muted text-destructive',
  info: 'border-transparent bg-info-muted text-info',
  muted: 'border-transparent bg-muted text-muted-foreground',
  outline: 'border-border bg-background text-muted-foreground',
  brand: 'border-transparent bg-brand-muted text-brand-strong',
};

export function Pill({ tone = 'muted', icon: Icon, children, className, title }: { tone?: Tone; icon?: LucideIcon | undefined; children: ReactNode; className?: string; title?: string }) {
  return (
    <span
      data-tone={tone}
      title={title}
      className={cn('inline-flex h-[22px] w-fit shrink-0 items-center gap-1 rounded-full border px-2 text-xs font-medium whitespace-nowrap [&>svg]:size-3', TONE[tone], className)}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ decisions (Neurouter policy pipeline) */

const DECISION: Record<AuditDecision, { tone: Tone; icon: LucideIcon; label: string; detail?: string }> = {
  allowed: { tone: 'ok', icon: CheckIcon, label: 'allowed' },
  dry_run: { tone: 'warn', icon: CircleDashedIcon, label: 'dry run', detail: 'Planned only, not executed' },
  confirmed: { tone: 'ok', icon: CheckCheckIcon, label: 'confirmed by user', detail: 'The user confirmed this write in the client' },
  denied_acl: { tone: 'err', icon: BanIcon, label: 'blocked: acl', detail: 'The key may not call this tool' },
  denied_policy: { tone: 'err', icon: BanIcon, label: 'blocked: policy', detail: 'A policy refused the call' },
  denied_rate_limit: { tone: 'err', icon: BanIcon, label: 'blocked: rate limit', detail: 'Rate limited' },
  denied_read_only: { tone: 'err', icon: BanIcon, label: 'blocked: read-only', detail: 'Writes are off in this environment' },
  denied_disabled: { tone: 'err', icon: BanIcon, label: 'blocked: disabled', detail: 'Disabled by a kill switch' },
  denied_confirmation: { tone: 'err', icon: BanIcon, label: 'blocked: not confirmed', detail: 'The user declined the confirmation' },
};

export function decisionLabel(d: AuditDecision): string {
  return DECISION[d].label;
}

export function DecisionBadge({ decision }: { decision: AuditDecision }) {
  const def = DECISION[decision];
  return (
    <Pill tone={def.tone} icon={def.icon} title={def.detail}>
      {def.label}
    </Pill>
  );
}

const STATUS: Record<AuditStatus, { tone: 'ok' | 'err' | 'warn' | 'muted'; label: string }> = {
  ok: { tone: 'ok', label: 'ok' },
  tool_error: { tone: 'err', label: 'tool error' },
  upstream_error: { tone: 'err', label: 'upstream error' },
  timeout: { tone: 'warn', label: 'timeout' },
  invalid_args: { tone: 'err', label: 'invalid args' },
  blocked: { tone: 'muted', label: 'blocked' },
  cancelled: { tone: 'muted', label: 'cancelled' },
  script_error: { tone: 'err', label: 'script error' },
  limit_exceeded: { tone: 'warn', label: 'limit exceeded' },
};
const STATUS_TEXT: Record<'ok' | 'err' | 'warn' | 'muted', string> = { ok: 'text-success', err: 'text-destructive', warn: 'text-warning', muted: 'text-muted-foreground' };

/** Status as coloured text with a leading dot. */
export function AuditStatusText({ status }: { status: AuditStatus }) {
  const def = STATUS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-[13px] whitespace-nowrap', STATUS_TEXT[def.tone])}>
      <CircleIcon aria-hidden="true" className="size-2 fill-current" />
      {def.label}
    </span>
  );
}

export function auditStatusLabel(s: AuditStatus): string {
  return STATUS[s].label;
}

export { isBlockedDecision };

/* ------------------------------------------------------------ health */

const HEALTH: Record<HealthStatus, { tone: Tone; label: string; dot: string }> = {
  up: { tone: 'ok', label: 'Healthy', dot: 'bg-success' },
  down: { tone: 'err', label: 'Down', dot: 'bg-destructive' },
  unknown: { tone: 'muted', label: 'Unknown', dot: 'bg-muted-foreground' },
};

/** `slow` is derived: healthy but p95 over 1 s. */
export function healthView(status: HealthStatus, latencyMs?: number | null): { label: string; dot: string } {
  if (status === 'up' && latencyMs != null && latencyMs > 1000) return { label: `Slow · p95 ${formatDuration(latencyMs)}`, dot: 'bg-warning' };
  return { label: HEALTH[status].label, dot: HEALTH[status].dot };
}

export function HealthDot({ status, latencyMs, className }: { status: HealthStatus; latencyMs?: number | null; className?: string }) {
  return <span aria-hidden="true" className={cn('inline-block size-2 shrink-0 rounded-full', healthView(status, latencyMs).dot, className)} />;
}

export function healthLabel(status: HealthStatus, latencyMs?: number | null): string {
  return healthView(status, latencyMs).label;
}

export function HealthText({ status, latencyMs }: { status: HealthStatus; latencyMs?: number | null }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <HealthDot status={status} latencyMs={latencyMs} />
      {healthLabel(status, latencyMs)}
    </span>
  );
}

/* ------------------------------------------------------------ keys */

export function KeyStatusBadge({ status }: { status: 'active' | 'revoked' | 'expired' }) {
  if (status === 'active') return <Pill tone="ok" icon={CheckIcon}>Active</Pill>;
  if (status === 'expired') return <Pill tone="warn" icon={ClockIcon}>Expired</Pill>;
  return <Pill tone="muted" icon={XIcon}>Revoked</Pill>;
}

/* ------------------------------------------------------------ Neurouter badges (spec §7.3 "status") */

const ENV_STYLE: Record<string, string> = {
  dev: 'bg-env-dev-muted text-env-dev',
  qa: 'bg-env-qa-muted text-env-qa',
  prod: 'bg-env-prod-muted text-env-prod',
  mock: 'bg-env-dev-muted text-env-dev',
};

/** Environment badge, always text (colour follows the kind: dev grey, qa blue, prod amber). */
export function EnvBadge({ slug, kind, className }: { slug: string; kind?: string; className?: string }) {
  const k = kind ?? slug;
  return <span className={cn('inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-xs font-semibold', ENV_STYLE[k] ?? ENV_STYLE.dev, className)}>{slug}</span>;
}

/** Tool mode (blue) or code mode (teal), with text. */
export function ModeBadge({ mode, className }: { mode: 'tool' | 'code' | 'tools' | 'both'; className?: string }) {
  if (mode === 'both')
    return (
      <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', className)}>
        <span className="text-mode-tool">tool</span>+<span className="text-mode-code">code</span>
      </span>
    );
  const code = mode === 'code';
  return <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', code ? 'text-mode-code' : 'text-mode-tool', className)}>{code ? 'code mode' : 'tool mode'}</span>;
}

/** Read / Write pill (prototype: grey "Read", amber "Write" with a pencil). */
export function WriteBadge({ write }: { write: boolean }) {
  return write ? (
    <Pill tone="warn" icon={PencilIcon}>
      Write
    </Pill>
  ) : (
    <Pill tone="muted">Read</Pill>
  );
}

const SPEC_LABEL: Record<SpecFormat, string> = {
  'openapi-3.0': 'OpenAPI 3.0',
  'openapi-3.1': 'OpenAPI 3.1',
  'graphql-sdl': 'GraphQL SDL',
  'graphql-introspection': 'GraphQL',
};
export function specFormatLabel(f: SpecFormat | null | undefined): string {
  return f ? SPEC_LABEL[f] : 'Spec';
}
export function SpecKindBadge({ format, detail }: { format: SpecFormat; detail?: string }) {
  return (
    <Pill tone="outline" icon={FileCodeIcon}>
      {SPEC_LABEL[format]}
      {detail ? ` · ${detail}` : ''}
    </Pill>
  );
}

const OUTCOME: Record<TaskOutcome | 'in_progress' | 'inferred', { tone: Tone; label: string }> = {
  success: { tone: 'ok', label: 'Success' },
  partial: { tone: 'warn', label: 'Partial' },
  failure: { tone: 'err', label: 'Failure' },
  abandoned: { tone: 'muted', label: 'Abandoned' },
  unknown: { tone: 'muted', label: 'Unknown' },
  in_progress: { tone: 'info', label: 'In progress' },
  inferred: { tone: 'outline', label: 'Inferred' },
};

/** Task outcome; an open task shows "In progress", an inferred task without an outcome "Inferred". */
export function OutcomeBadge({ outcome, status, framing }: { outcome: TaskOutcome | null; status?: 'open' | 'closed'; framing?: TaskFraming }) {
  const key = status === 'open' ? 'in_progress' : outcome ?? (framing === 'inferred' ? 'inferred' : 'unknown');
  const def = OUTCOME[key];
  return (
    <Pill tone={def.tone} icon={key === 'in_progress' ? CircleDashedIcon : undefined}>
      {def.label}
    </Pill>
  );
}

export function EvalTrafficBadge() {
  return (
    <Pill tone="outline" icon={FlaskConicalIcon}>
      eval
    </Pill>
  );
}

/** "Defined in neurouter.yaml · line 42" with a copy action (A-GITOPS). */
export function FileManagedNote({ path, line, yaml }: { path: string; line: number | null; yaml?: string }) {
  return (
    <div role="note" className="flex flex-wrap items-center gap-2 rounded-lg border border-dashed px-3 py-2 text-[12.5px] text-muted-foreground">
      <TriangleAlertIcon aria-hidden="true" className="size-3.5" />
      <span>
        Defined in <span className="font-mono">{path}</span>
        {line ? ` · line ${line}` : ''}. Edit the file to change it.
      </span>
      {yaml ? <CopyButton value={yaml} label="Copy YAML" /> : null}
    </div>
  );
}
