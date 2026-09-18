import { defineWorkspace } from 'vitest/config';
import react from '@vitejs/plugin-react';

/**
 * One Vitest run for both workspaces, because "did the tests pass?" should have one
 * answer. The two halves need different environments, so they are separate projects
 * rather than one config with a compromise `environment` setting.
 *
 * Tests that need a real database are skipped unless `TEST_DATABASE_URL` is set, so
 * `npm test` passes on a clean clone with no Postgres running. See docs/12-testing.md.
 */
export default defineWorkspace([
  {
    test: {
      name: 'backend',
      root: './backend',
      environment: 'node',
      include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
      setupFiles: ['./tests/setup.ts'],
      // Applies migrations when TEST_DATABASE_URL is set; a no-op otherwise.
      globalSetup: ['./tests/global-setup.ts'],
      // Database tests share one Postgres. Running the files in parallel against it makes
      // failures depend on interleaving, which is the worst kind of flake to chase.
      //
      // `fileParallelism` is a root-level option and is silently ignored inside a
      // workspace project, so it was never actually in effect — two files calling
      // `seedAll` concurrently interleaved their writes. `singleFork` is per-project and
      // genuinely serializes the files into one process. Kept alongside it because it is
      // correct at the root and harmless here.
      fileParallelism: false,
      poolOptions: { forks: { singleFork: true } },
    },
  },
  {
    plugins: [react()],
    test: {
      name: 'frontend',
      root: './frontend',
      environment: 'jsdom',
      include: ['src/**/*.test.{ts,tsx}', 'tests/**/*.test.{ts,tsx}'],
      setupFiles: ['./tests/setup.ts'],
    },
  },
]);
