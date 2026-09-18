import { PrismaClient } from '@prisma/client';
import { getConfig } from './config';
import { getLogger } from './logger';

/**
 * The Prisma client singleton.
 *
 * Query logging goes through Pino rather than straight to stdout, so it is structured,
 * level-controlled, and subject to the same redaction as everything else — the old
 * `log: ['query']` printed parameter values, which for this schema will include
 * encrypted credentials and, before encryption lands, worse.
 *
 * W6 adds the token-encryption Prisma extension here (docs/03-teardown.md).
 */

function createPrismaClient(): PrismaClient {
  const config = getConfig();
  const logger = getLogger().child({ component: 'prisma' });

  const client = new PrismaClient({
    datasources: { db: { url: config.databaseUrl } },
    log: [
      { emit: 'event', level: 'warn' },
      { emit: 'event', level: 'error' },
      ...(config.logLevel === 'debug' || config.logLevel === 'trace'
        ? ([{ emit: 'event', level: 'query' }] as const)
        : []),
    ],
  });

  client.$on('warn' as never, (event: { message: string }) => {
    logger.warn({ message: event.message });
  });

  client.$on('error' as never, (event: { message: string }) => {
    logger.error({ message: event.message });
  });

  // Duration and the query shape only. Never `event.params`.
  client.$on('query' as never, (event: { query: string; duration: number }) => {
    logger.debug({ query: event.query, durationMs: event.duration });
  });

  return client;
}

let cached: PrismaClient | undefined;

export function getPrisma(): PrismaClient {
  cached ??= createPrismaClient();
  return cached;
}

export async function disconnectPrisma(): Promise<void> {
  if (cached) {
    await cached.$disconnect();
    cached = undefined;
  }
}
