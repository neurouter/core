import { ConfigError, startServer } from './server.js';

/** Server entry point: boot, then graceful shutdown on SIGINT/SIGTERM. */
async function main(): Promise<void> {
  let running;
  try {
    running = await startServer();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(err.message);
      process.exit(1);
    }
    throw err;
  }
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    running.services.logger.info({ signal }, 'shutting down');
    const timer = setTimeout(() => process.exit(1), 20_000);
    timer.unref();
    try {
      await running.close();
      process.exit(0);
    } catch (err) {
      running.services.logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
