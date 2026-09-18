import 'dotenv/config';
import { loadConfigOrExit } from './platform/boot';
import { getLogger } from './platform/logger';
import { disconnectPrisma } from './platform/db';
import { startWorker, stopWorker } from './jobs';

/**
 * Worker process entry point — the `worker` process type in the Procfile.
 *
 * Separate from the web process on purpose. The prototype ran its scheduler on a
 * `setInterval` inside the web dyno, which meant every extra web dyno ran a duplicate
 * scheduler and published the same post twice, and a dyno restart lost whatever was
 * mid-flight. A distinct process with its own scaling is the fix.
 *
 * Until W6 registers queues this process boots, idles, and shuts down cleanly. That is
 * still worth deploying: it proves the process type, config and database wiring work
 * before any real job depends on them.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = getLogger().child({ process: 'worker' });

  logger.info({ env: config.env }, 'Worker process starting');
  await startWorker();

  // Nothing is listening on a socket, so hold the event loop open explicitly.
  const heartbeat = setInterval(() => undefined, 60_000);

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals) => {
    void (async () => {
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Worker shutting down');
      clearInterval(heartbeat);
      try {
        await stopWorker();
        await disconnectPrisma();
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Worker shutdown failed');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection in worker');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception in worker; exiting');
    process.exit(1);
  });
}

void main();
