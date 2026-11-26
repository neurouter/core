import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SocketExecutor } from './client.js';
import { silentLogger } from './logger.js';
import { resolveMontyBinary, sha256File } from './monty-info.js';
import type { ExecLogger } from './types.js';

export interface SpawnExecutorOptions {
  /** Socket file name; the file is created inside a fresh 0700 directory (default `neurouter-executor.sock`). */
  socketPath?: string;
  /** Shared secret for `hello` (default: 32 random bytes per start). */
  token?: string;
  poolMax: number;
  prewarm: number;
  logLevel?: string;
  /** Executor entry; default `dist/main.js` next to this module, else `src/main.ts` through tsx (dev). */
  entry?: string;
  /** Extra Node flags for the child (default: `--import tsx` when `entry` is a .ts file). */
  execArgv?: string[];
  montyBinaryPath?: string;
  /**
   * Pinned sha256 of the Monty binary (e.g. computed at image build). When given, the parent does not
   * hash the binary itself (a synchronous 47 MB read at startup); the child still verifies the binary
   * against it before starting, and the client checks the child's `hello` against it.
   */
  montyBinarySha256?: string;
  /** Called when the child exits unexpectedly (it is restarted with backoff 1 s → 30 s). */
  onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
  logger?: ExecLogger;
  nodeEnv?: string;
}

export interface EmbeddedExecutor {
  readonly executor: SocketExecutor;
  readonly socketPath: string;
  readonly token: string;
  readonly montyBinaryPath: string;
  readonly montyBinarySha256: string;
  /** Child pid (changes after a restart). */
  pid(): number | undefined;
  /** Resolves once the first connection succeeded. */
  ready(timeoutMs?: number): Promise<void>;
  /** Kills the current child (tests: simulate a crash); it is restarted. */
  kill(signal?: NodeJS.Signals): void;
  close(): Promise<void>;
}

/**
 * Resolves the executor entry next to this module: `main.js` when running from `dist/` (production),
 * `main.ts` through the tsx loader when running from source (dev/tests, so the child is never stale).
 */
export function resolveExecutorEntry(): { entry: string; execArgv: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const js = join(here, 'main.js');
  if (existsSync(js)) return { entry: js, execArgv: [] };
  const ts = join(here, 'main.ts');
  if (existsSync(ts)) return { entry: ts, execArgv: ['--import', import.meta.resolve('tsx')] };
  throw new Error(`executor entry not found in ${here} (build apps/executor)`);
}

const LEVELS: Record<number, keyof ExecLogger> = { 20: 'debug', 30: 'info', 40: 'warn', 50: 'error' };

/**
 * Embedded mode (§10.6): spawns `apps/executor` as a child process listening on a Unix socket in a
 * private 0700 directory, with an environment that holds no secrets, and restarts it with backoff.
 */
export function spawnEmbeddedExecutor(opts: SpawnExecutorOptions): EmbeddedExecutor {
  const log = opts.logger ?? silentLogger;
  const dir = mkdtempSync(join(tmpdir(), 'nr-exec-'));
  chmodSync(dir, 0o700);
  const socketPath = join(dir, basename(opts.socketPath ?? 'neurouter-executor.sock'));
  const token = opts.token ?? randomBytes(32).toString('base64url');
  const montyBinaryPath = resolveMontyBinary(opts.montyBinaryPath);
  const montyBinarySha256 = opts.montyBinarySha256?.trim().toLowerCase() || sha256File(montyBinaryPath);
  const resolved = opts.entry ? { entry: opts.entry, execArgv: opts.entry.endsWith('.ts') ? ['--import', import.meta.resolve('tsx')] : [] } : resolveExecutorEntry();
  const execArgv = opts.execArgv ?? resolved.execArgv;
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: opts.nodeEnv ?? process.env.NODE_ENV ?? 'production',
    MONTY_BINARY_PATH: montyBinaryPath,
    MONTY_BINARY_SHA256: montyBinarySha256,
    NEUROUTER_EXECUTOR_TOKEN: token,
    NEUROUTER_EXECUTOR_POOL_MAX: String(opts.poolMax),
    NEUROUTER_EXECUTOR_PREWARM: String(opts.prewarm),
    LOG_LEVEL: opts.logLevel ?? 'info',
  };
  const executor = new SocketExecutor({ address: { socketPath }, token, expectedMontySha256: montyBinarySha256, logger: log, connectTimeoutMs: 5000 });

  let child: ChildProcess | null = null;
  let closing = false;
  let backoff = 1000;
  let startedAt = 0;
  let restartTimer: NodeJS.Timeout | null = null;

  const start = () => {
    startedAt = Date.now();
    const c = spawn(process.execPath, [...execArgv, resolved.entry, '--socket', socketPath], { env, stdio: ['ignore', 'ignore', 'pipe'], cwd: dir });
    child = c;
    let buf = '';
    c.stderr?.setEncoding('utf8');
    c.stderr?.on('data', (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line) as { level?: number; msg?: string } & Record<string, unknown>;
          const { level, msg, time: _t, pid, name: _n, ...rest } = rec;
          log[LEVELS[level ?? 30] ?? 'info']({ executorPid: pid, ...rest }, `executor: ${msg ?? ''}`);
        } catch {
          log.info({ line }, 'executor output');
        }
      }
    });
    c.on('exit', (code, signal) => {
      if (child === c) child = null;
      if (closing) return;
      log.warn({ code, signal }, 'executor exited; restarting');
      opts.onExit?.(code, signal);
      if (Date.now() - startedAt > 60_000) backoff = 1000;
      restartTimer = setTimeout(start, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    });
  };
  start();

  return {
    executor,
    socketPath,
    token,
    montyBinaryPath,
    montyBinarySha256,
    pid: () => child?.pid,
    ready: (timeoutMs = 20_000) => executor.connect(timeoutMs),
    kill: (signal = 'SIGKILL') => child?.kill(signal),
    async close() {
      closing = true;
      if (restartTimer) clearTimeout(restartTimer);
      await executor.close();
      const c = child;
      if (c && c.exitCode === null) {
        await new Promise<void>((res) => {
          const t = setTimeout(() => {
            c.kill('SIGKILL');
            res();
          }, 3000);
          c.once('exit', () => {
            clearTimeout(t);
            res();
          });
          c.kill('SIGTERM');
        });
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
