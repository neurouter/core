import type { Executor } from '@neurouter/executor';
import type { Metrics } from '../../kernel/observability/metrics.js';

/** Executor health loop (§9.3): `run_script` is listed only while the executor is healthy. */
export class ExecutorHealth {
  healthy = false;
  last: { ok: boolean; montyVersion: string; poolSize: number; busy: number; detail?: string } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly executor: () => Executor | null,
    private readonly metrics: Metrics | undefined,
    private readonly log: { warn: (o: object, m: string) => void },
    private readonly intervalMs = 10_000,
  ) {}

  async check(): Promise<boolean> {
    const ex = this.executor();
    const was = this.healthy;
    if (!ex) {
      this.healthy = false;
      this.last = null;
    } else {
      try {
        this.last = await ex.health();
        this.healthy = this.last.ok;
      } catch (err) {
        this.healthy = false;
        this.last = { ok: false, montyVersion: '', poolSize: 0, busy: 0, detail: (err as Error).message };
      }
    }
    this.metrics?.executorUp.set(this.healthy ? 1 : 0);
    this.metrics?.executorBusy.set(this.last?.busy ?? 0);
    if (was && !this.healthy) this.log.warn({ detail: this.last?.detail }, 'code-mode executor unhealthy; run_script hidden');
    if (!this.timer) {
      this.timer = setInterval(() => void this.check().catch(() => {}), this.intervalMs);
      this.timer.unref();
    }
    return this.healthy;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
