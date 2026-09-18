/**
 * Backend test environment.
 *
 * The values live in `applyTestEnv()` (tests/env.ts) so that `global-setup.ts` can
 * establish the same environment before it seeds. Two copies of the list would drift, and
 * the way you would find that out is a global setup quietly connecting somewhere the
 * tests do not.
 */
import { applyTestEnv } from './env';

applyTestEnv();
