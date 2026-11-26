import type { ConnectConfig } from '@/contract';

const MODE = { auto: 'mode chosen from the latest eval', tools: 'tool mode', code: 'code mode', both: 'tool and code mode' } as const;

/** "What agents will see" (spec §9.16), from `ConnectConfig.summary`. */
export function AgentSummary({ config }: { config: ConnectConfig }) {
  const s = config.summary;
  return (
    <ul className="flex flex-col gap-1 text-[13.5px]">
      <li>
        <strong className="tabular-nums">{s.listedTools}</strong> tools listed{s.discovery === 'search' ? ', the rest through search_tools' : s.discovery === 'auto' ? ' (search_tools when the list is long)' : ''}
      </li>
      <li>Exposure: {MODE[s.exposure]}</li>
      <li>Code mode {s.codeMode ? 'on' : 'off'} in {config.environment.slug}</li>
      <li>{s.writesEnabled ? `Some write tools are on in ${config.environment.slug}` : `Writes: none in ${config.environment.slug} (read-only)`}</li>
      <li>Ops tools on (begin_task, end_task, report_unmet_need, …)</li>
    </ul>
  );
}
