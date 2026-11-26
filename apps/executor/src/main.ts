#!/usr/bin/env node
/**
 * Neurouter code-mode executor (§10.6). Usage:
 *   node dist/main.js --socket /path/executor.sock     (embedded: spawned by the server)
 *   node dist/main.js --tcp 127.0.0.1:7777             (sidecar / separate deployment)
 * Env: NEUROUTER_EXECUTOR_TOKEN (required; ≥ 32 chars for --tcp), NEUROUTER_EXECUTOR_POOL_MAX (4),
 * NEUROUTER_EXECUTOR_PREWARM (2), MONTY_BINARY_PATH, MONTY_BINARY_SHA256, LOG_LEVEL.
 */
import { createStderrLogger } from './logger.js';
import { MontyRunner } from './monty-runner.js';
import { ExecutorServer, type ListenAddress } from './server.js';

function parseArgs(argv: string[]): ListenAddress {
  const i = argv.indexOf('--socket');
  if (i >= 0 && argv[i + 1]) return { socketPath: argv[i + 1]! };
  const j = argv.indexOf('--tcp');
  if (j >= 0 && argv[j + 1]) {
    const m = /^(.+):(\d+)$/.exec(argv[j + 1]!);
    if (m) return { host: m[1]!, port: Number(m[2]) };
  }
  throw new Error('usage: neurouter-executor --socket <path> | --tcp <host:port>');
}

async function main(): Promise<void> {
  const log = createStderrLogger(process.env.LOG_LEVEL ?? 'info');
  const addr = parseArgs(process.argv.slice(2));
  const token = process.env.NEUROUTER_EXECUTOR_TOKEN ?? '';
  if (!token) throw new Error('NEUROUTER_EXECUTOR_TOKEN is required');
  if ('host' in addr && token.length < 32) throw new Error('NEUROUTER_EXECUTOR_TOKEN must be at least 32 characters for --tcp');
  const runner = await MontyRunner.create({
    poolMax: Number(process.env.NEUROUTER_EXECUTOR_POOL_MAX ?? 4),
    prewarm: Number(process.env.NEUROUTER_EXECUTOR_PREWARM ?? 2),
    ...(process.env.MONTY_BINARY_PATH ? { binaryPath: process.env.MONTY_BINARY_PATH } : {}),
    ...(process.env.MONTY_BINARY_SHA256 ? { binarySha256: process.env.MONTY_BINARY_SHA256 } : {}),
    logger: log,
  });
  const server = new ExecutorServer({ runner, token, logger: log });
  const where = await server.listen(addr);
  log.info({ address: where, poolMax: runner.poolMax, montyVersion: runner.montyVersion }, 'executor listening');
  const stop = async (signal: string) => {
    log.info({ signal }, 'executor shutting down');
    await server.close();
    await runner.close();
    process.exit(0);
  };
  process.once('SIGTERM', () => void stop('SIGTERM'));
  process.once('SIGINT', () => void stop('SIGINT'));
  process.once('disconnect', () => void stop('disconnect'));
}

main().catch((err: unknown) => {
  process.stderr.write(JSON.stringify({ level: 60, time: Date.now(), name: 'neurouter-executor', msg: 'fatal', err: err instanceof Error ? err.message : String(err) }) + '\n');
  process.exit(1);
});
