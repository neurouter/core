import type { Timeseries } from '@/contract';
import { formatDate, formatNumber } from '@/lib/format';

/**
 * Calls per day split by mode (prototype Main): stacked bars, tool mode blue below, inside-script
 * calls teal above. A visually hidden table carries the same numbers (spec §11).
 */
export function CallsChart({ data }: { data: Timeseries }) {
  const tool = data.series.find((s) => s.key === 'tool')?.points ?? [];
  const code = data.series.find((s) => s.key === 'code')?.points ?? [];
  const days = tool.map((p, i) => ({ t: p.t, tool: p.v ?? 0, code: code[i]?.v ?? 0 }));
  const max = Math.max(1, ...days.map((d) => d.tool + d.code));
  const first = days[0]?.t;
  const mid = days[Math.floor(days.length / 2)]?.t;
  const last = days[days.length - 1]?.t;
  const total = days.reduce((a, d) => a + d.tool + d.code, 0);
  return (
    <div className="flex flex-col gap-2">
      <div aria-hidden="true" className="flex h-[150px] items-end gap-1.5 border-b pb-0.5 sm:gap-2.5">
        {days.map((d) => (
          <div key={d.t} className="flex h-full flex-1 flex-col justify-end gap-0.5" title={`${formatDate(d.t)}: ${formatNumber(d.tool)} direct, ${formatNumber(d.code)} in scripts`}>
            <span className="block rounded-[3px] bg-mode-code" style={{ height: `${(d.code / max) * 140}px` }} />
            <span className="block rounded-[3px] bg-mode-tool" style={{ height: `${(d.tool / max) * 140}px` }} />
          </div>
        ))}
      </div>
      <div aria-hidden="true" className="flex justify-between text-xs text-muted-foreground">
        <span>{first ? formatDate(first).replace(/, \d{4}$/, '') : ''}</span>
        <span>{mid ? formatDate(mid).replace(/, \d{4}$/, '') : ''}</span>
        <span>{last ? formatDate(last).replace(/, \d{4}$/, '') : ''}</span>
      </div>
      <table className="sr-only">
        <caption>Calls per day, {formatNumber(total)} in total</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Direct tool calls</th>
            <th scope="col">Inside scripts</th>
          </tr>
        </thead>
        <tbody>
          {days.map((d) => (
            <tr key={d.t}>
              <th scope="row">{formatDate(d.t)}</th>
              <td>{d.tool}</td>
              <td>{d.code}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartLegend() {
  return (
    <>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-mode-tool" />
        Direct tool calls
      </span>
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
        <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-mode-code" />
        Inside scripts
      </span>
    </>
  );
}
