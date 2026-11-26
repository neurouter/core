import { MontyRunner, type MontyRunnerOptions } from './monty-runner.js';
import type { Executor, ExecutorHealth, HostBridge, RunRequest, RunResult } from './types.js';

export interface LocalExecutorOptions extends MontyRunnerOptions {
  /** Allow in production (tests only). `NEUROUTER_EXECUTOR_MODE=local` is refused when NODE_ENV=production. */
  allowInProduction?: boolean;
}

/** In-process Monty pool (dev/tests). The worker subprocesses still isolate crashes. */
export class LocalExecutor implements Executor {
  readonly kind = 'local' as const;
  private constructor(private readonly runner: MontyRunner) {}

  static async create(opts: LocalExecutorOptions): Promise<LocalExecutor> {
    if (process.env.NODE_ENV === 'production' && !opts.allowInProduction) {
      throw new Error('LocalExecutor is refused when NODE_ENV=production; use the embedded or remote executor');
    }
    return new LocalExecutor(await MontyRunner.create(opts));
  }

  async health(): Promise<ExecutorHealth> {
    return this.runner.health();
  }

  run(req: RunRequest, host: HostBridge, signal: AbortSignal): Promise<RunResult> {
    return this.runner.run(req, host, signal);
  }

  close(): Promise<void> {
    return this.runner.close();
  }
}
