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
