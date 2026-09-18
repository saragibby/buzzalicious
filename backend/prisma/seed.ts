import { disconnectPrisma, getPrisma } from '../src/platform/db';
import { getLogger } from '../src/platform/logger';
import { seedAll } from './seed/index';

/**
 * `npm run db:seed` — CLI entry point.
 *
 * The seed goes through the ordinary application client, not a bare `PrismaClient`, so it
 * exercises the encryption extension exactly as the app does. A seed that wrote plaintext
 * tokens straight to the columns would produce a database the app cannot read, and would
 * do it silently.
 *
 * The seeding itself lives in `seed/index.ts` as `seedAll(db)` so tests can run it against
 * their own client without shelling out.
 */
async function main(): Promise<void> {
  const logger = getLogger().child({ component: 'seed' });
  const started = Date.now();

  const summary = await seedAll(getPrisma());

  logger.info(
    { ...summary, durationMs: Date.now() - started },
    'Seed complete. Re-running is safe: every row is upserted on a derived id.',
  );
}

main()
  .catch((error: unknown) => {
    getLogger().child({ component: 'seed' }).error({ err: error }, 'Seed failed');
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectPrisma();
  });
