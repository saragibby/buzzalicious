import 'dotenv/config';
import type { Server } from 'node:http';
import { loadConfigOrExit } from './platform/boot';
import { getLogger } from './platform/logger';
import { disconnectPrisma } from './platform/db';
import { createApp } from './http/app';
import { startWorker, stopWorker } from './jobs';

/**
 * Web process entry point.
 *
 * A thin bootstrap and nothing else: validate config, build the app, listen, and shut
 * down cleanly. The prototype's `index.ts` also held routes, Prisma queries and a
 * `setInterval` scheduler; all of that now lives where it belongs.
 */
async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = getLogger();

  const app = createApp();
  const server: Server = app.listen(config.port, () => {
    logger.info(
      { port: config.port, env: config.env, storage: config.storage.driver },
      'API listening',
    );
  });

  // In-process consumers behind a flag, per docs/01-architecture.md. On Heroku the worker
  // runs as its own dyno, so this stays false on web dynos.
  if (config.workerEnabled) {
    await startWorker();
  }

  registerShutdown(server);
}

function registerShutdown(server: Server): void {
  const logger = getLogger();
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals) => {
    void (async () => {
      // Heroku sends SIGTERM and SIGKILLs 30s later. A second signal must not restart
      // the sequence.
      if (shuttingDown) return;
      shuttingDown = true;
      logger.info({ signal }, 'Shutting down');

      const timeout = setTimeout(() => {
        logger.error('Graceful shutdown timed out; forcing exit');
        process.exit(1);
      }, 25_000);
      timeout.unref();

      try {
        // Stop accepting connections, drain in-flight requests, then release resources.
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        await stopWorker();
        await disconnectPrisma();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (error) {
        logger.error({ err: error }, 'Shutdown failed');
        process.exit(1);
      }
    })();
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Uncaught exception; exiting');
    process.exit(1);
  });
}

void main();
