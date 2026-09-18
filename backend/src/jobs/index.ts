import { getLogger } from '../platform/logger';

/**
 * Background job seam.
 *
 * ADR-0004 selects pg-boss on Postgres, and **W6 implements it**. M1 deliberately stops
 * at the boundary: the worker process type, the start/stop lifecycle and the shutdown
 * wiring exist and are exercised, but there is no queue yet. That keeps the Procfile and
 * the deploy topology honest without W0 guessing at a job schema that W2's models have
 * not been written for.
 *
 * What W6 replaces:
 *  - `startWorker` boots pg-boss against `config.databaseUrl` and registers handlers.
 *  - `stopWorker` calls `boss.stop({ graceful: true })`.
 *  - Handlers live in `jobs/handlers/` and delegate straight into `modules/`; a job
 *    handler should contain no business logic of its own.
 *
 * Job payloads carry identifiers only — never a credential, never a token
 * (docs/10-credentials-and-security.md). Queue rows are readable by anyone with database
 * access and outlive the job.
 */

let running = false;

export async function startWorker(): Promise<void> {
  if (running) return;
  running = true;
  await Promise.resolve();
  getLogger().info({ queue: 'none' }, 'Worker started (no queues registered until W6)');
}

export async function stopWorker(): Promise<void> {
  if (!running) return;
  running = false;
  await Promise.resolve();
  getLogger().info('Worker stopped');
}

export function isWorkerRunning(): boolean {
  return running;
}
