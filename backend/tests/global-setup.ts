import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Applies migrations to the test database before the suite runs.
 *
 * `prisma migrate deploy` is the same command the Procfile runs on release, so every test
 * run is also a rehearsal of the deploy path. That matters more than it sounds: a
 * migration that only ever gets applied by `migrate dev` locally can be broken in
 * production for weeks without anyone noticing.
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

export default function setup(): void {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) return;

  execFileSync(
    findPrismaBin(),
    ['migrate', 'deploy', '--schema', path.resolve(__dirname, '../prisma/schema.prisma')],
    { env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'pipe' },
  );
}
