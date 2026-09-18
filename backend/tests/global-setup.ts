import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { applyTestEnv } from './env';

/**
 * Prepares the test database before the suite runs: migrate, then seed.
 *
 * `prisma migrate deploy` is the same command the Procfile runs on release, so every test
 * run is also a rehearsal of the deploy path. That matters more than it sounds: a
 * migration that only ever gets applied by `migrate dev` locally can be broken in
 * production for weeks without anyone noticing.
 *
 * ## Why the seed belongs here
 *
 * It used to run only as a side effect of `seed.test.ts` importing and calling `seedAll`,
 * which made every other database test's data depend on **file execution order**. A file
 * running after `seed.test.ts` saw a populated database; one running before it saw an
 * empty one. `tests/db/render.test.ts` was the first file to sort ahead of the seed, and
 * it failed on a cold database with `expected 0 to be greater than 0` while passing on
 * any database a previous run had already touched — the signature of a test that only
 * passes on leftover data.
 *
 * Seeding here makes every database test order-independent, which kills the whole class
 * rather than the one instance. Renaming a file, or adding a local `seedAll` call in one
 * `beforeAll`, would have fixed the symptom and left the trap armed for the next
 * workstream.
 *
 * The seed is idempotent — every row is upserted on a UUIDv5 derived from natural keys —
 * so running it against an already-seeded database is safe.
 *
 * Does nothing when `TEST_DATABASE_URL` is unset, so `npm test` still passes on a clean
 * clone with no Postgres. See docs/12-testing.md.
 */

/** npm hoists to the workspace root, so the binary is not reliably in `backend/`. */
function findPrismaBin(): string {
  let dir = __dirname;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', '.bin', 'prisma');
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('Could not find the prisma CLI; run `npm ci`.');
    dir = parent;
  }
}

export default async function setup(): Promise<void> {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) return;

  execFileSync(
    findPrismaBin(),
    ['migrate', 'deploy', '--schema', path.resolve(__dirname, '../prisma/schema.prisma')],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
  );

  // Establish the environment before importing anything that reaches `platform/config`,
  // which validates at import time. The imports below are dynamic for exactly that
  // reason: static ones are hoisted above this call and would read a partial environment.
  applyTestEnv();

  const { getPrisma, disconnectPrisma } = await import('../src/platform/db');
  const { seedAll } = await import('../prisma/seed/index');

  try {
    // Through the ordinary application client rather than a bare PrismaClient, so the
    // seed exercises the encryption extension exactly as the app does.
    await seedAll(getPrisma());
  } finally {
    // Test files open their own clients; leaving this one connected holds a pool open for
    // the whole run.
    await disconnectPrisma();
  }
}
