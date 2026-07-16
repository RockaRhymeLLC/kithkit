/**
 * Shared guard: does a task have a worker that is still recoverable —
 * i.e. not provably dead?
 *
 * Both orchestrator-idle.ts (cleanupZombieTasks, cleanupOrphanedTasks) and
 * orch-stale-task-recovery.ts need to distinguish tasks whose work is truly
 * abandoned (no worker ever ran, or every worker is definitively dead) from
 * tasks where a worker might still produce a result (queued, running,
 * already completed, or any status we don't yet recognize) — the latter
 * should be recovered (reset to 'assigned' for a fresh orchestrator to
 * resume/re-synthesize) rather than blanket-marked 'failed', which would
 * silently discard real work.
 *
 * This is a default-deny (fail-safe) guard: it only treats a task as
 * abandoned when every worker is in a status we KNOW is terminal-and-dead
 * ('failed' or 'timeout'). A worker in 'queued' — the status every worker
 * starts in immediately after spawn, before it flips to 'running' — is
 * treated as recoverable, not absent. Any unrecognized/future status is
 * also treated as recoverable: the safe default is to preserve the task,
 * not destroy it.
 */

import { query } from '../../../core/db.js';
import { createLogger } from '../../../core/logger.js';

const log = createLogger('task-worker-guard');

interface WorkerStatusRow {
  status: string;
}

/** Worker statuses that are known to be terminal and dead — no further work will happen. */
const DEAD_STATUSES = new Set(['failed', 'timeout']);

/**
 * Check whether a task has at least one worker that is not provably dead
 * (i.e. not 'failed' and not 'timeout'). Queued, running, completed, and
 * any unrecognized status all count as recoverable.
 *
 * @param taskRowId tasks.id — the INTEGER primary key (matches task_workers.task_id).
 */
export function hasRecoverableWorker(taskRowId: number): boolean {
  let workers: WorkerStatusRow[] = [];
  try {
    workers = query<WorkerStatusRow>(
      `SELECT wj.status AS status
       FROM task_workers tw
       JOIN worker_jobs wj ON tw.worker_id = wj.id
       WHERE tw.task_id = ?`,
      taskRowId,
    );
  } catch (err) {
    // task_workers/worker_jobs query failed (e.g. pre-migration schema, DB
    // error). We cannot determine worker state — fail CLOSED by treating the
    // task as recoverable (preserve it) rather than authorizing destruction
    // based on a check that never actually ran. Log loudly: a genuinely
    // missing table this late in the schema's life is a real problem, not
    // routine, and must not fail silently.
    log.error('hasRecoverableWorker: query failed — preserving task (fail-closed)', {
      taskRowId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
  return workers.some(w => !DEAD_STATUSES.has(w.status));
}
