import { Link } from '@tanstack/react-router';
import type { EnvironmentDetail } from '@/contract';
import { EnvBadge, HealthText } from '@/components/status/status';
import { cn } from '@/lib/utils';

/** "Writes: 3 of 9 on", "Writes: all on (simulated)", "Writes: 0 of 9 on · read-only". */
export function writesSummary(e: Pick<EnvironmentDetail, 'isMock' | 'kind' | 'writes'>): string {
  if (e.isMock) return 'Writes: all on (simulated)';
  const on = e.writes.enabled ? e.writes.enabledToolNames.length : 0;
  return `Writes: ${on} of ${e.writes.writeToolCount} on${on === 0 ? ' · read-only' : ''}`;
}

export function envBadgeKind(e: Pick<EnvironmentDetail, 'isMock' | 'kind'>): string {
  return e.isMock ? 'mock' : e.kind;
}

/** Compact environment card (server overview right rail, prototype Main). */
export function EnvMiniCard({ env, compact = false }: { env: EnvironmentDetail; compact?: boolean }) {
  return (
    <div className={cn('flex flex-col gap-1 rounded-[10px] border px-3 py-2.5', compact && 'gap-0.5')}>
      <div className="flex items-center gap-2">
        <EnvBadge slug={env.slug} kind={envBadgeKind(env)} />
        <span className="flex-1" />
        <HealthText status={env.health.status} latencyMs={env.health.latencyMs} />
      </div>
      {!compact ? <span className="truncate font-mono text-xs text-muted-foreground">{env.isMock ? 'built-in · used by evals' : env.baseUrl}</span> : null}
      <span className="text-[12.5px]">{writesSummary(env)}</span>
    </div>
  );
}

export function EnvStrip({ serverId, envs }: { serverId: string; envs: EnvironmentDetail[] }) {
  return (
    <section aria-labelledby="env-strip-title" className="flex flex-col gap-2.5 rounded-xl border bg-card p-4">
      <div className="flex items-center">
        <h2 id="env-strip-title" className="flex-1 text-base font-semibold">
          Environments
        </h2>
        <Link to="/servers/$serverId/environments" params={{ serverId }} className="text-[13px] text-primary hover:underline">
          Manage
        </Link>
      </div>
      {envs.map((e) => (
        <EnvMiniCard key={e.id} env={e} />
      ))}
    </section>
  );
}
