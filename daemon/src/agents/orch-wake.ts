/**
 * Orchestrator Wake Listener — event-drive the orchestrator on worker completion.
 *
 * Fix for kithkit#877 / #2820: worker-completion did NOT wake the orchestrator.
 * Previously the orch only resumed on the idle-monitor poll-tick (≤2-min lag)
 * or a daemon restart. This listener fires injectMessage immediately after every
 * orch-parented worker job completes, so the orch can synthesize results without
 * waiting for the next scheduler tick.
 *
 * Design (per R2 #461 review criteria):
 *   • NEW addOnJobComplete LISTENER — finishJob is left untouched (sync contract,
 *     idempotence guard, processQueue draining all preserved).
 *   • The inject is fire-and-forget (.catch()) so the listener is synchronous
 *     from finishJob's perspective — processQueue is not blocked (assertion c).
 *   • Also bumps tasks.updated_at for orch-parented tasks (belt-and-suspenders):
 *     un-blinds orchestrator-idle Check-3b (MAX(updated_at) progress heuristic)
 *     in the window between the wake inject and the orch acting on it.
 *
 * Wakes on ALL terminal job states (completed, failed, timeout) — the orch must
 * know about failures too so it can retry, fail the task, or surface the error.
 */

import {
  isOrchestratorAlive as _isOrchestratorAlive,
  injectMessage as _injectMessage,
} from './tmux.js';
import { addOnJobComplete, type JobRecord } from './lifecycle.js';
import { query, exec } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('agents:orch-wake');

// ── Injectable deps (overridable for testing) ────────────────

let isOrchestratorAlive: () => boolean = _isOrchestratorAlive;
let injectMessage: (target: string, text: string) => Promise<boolean> = _injectMessage;

// ── Listener ─────────────────────────────────────────────────

function orchWakeListener(job: JobRecord): void {
  // Find the parent orchestrator task(s) linked via task_workers.
  // Filter on kind='orchestrator' to avoid spurious wakes for non-orch jobs.
  const rows = query<{ task_id: string; int_id: number }>(
    `SELECT t.external_id AS task_id, t.id AS int_id
     FROM task_workers tw
     JOIN tasks t ON t.id = tw.task_id
     WHERE tw.worker_id = ? AND t.kind = 'orchestrator'`,
    job.id,
  );

  if (rows.length === 0) {
    // Not an orchestrator-parented job — no wake (assertion b: no spurious wakes)
    return;
  }

  // Belt-and-suspenders: bump tasks.updated_at so orchestrator-idle Check-3b
  // (MAX(updated_at) progress heuristic) sees activity between the wake inject
  // firing and the orch actually updating the task itself.
  const ts = new Date().toISOString();
  for (const row of rows) {
    exec(
      `UPDATE tasks SET updated_at = ? WHERE id = ? AND status IN ('in_progress', 'assigned')`,
      ts, row.int_id,
    );
  }

  // Only inject if the orchestrator is alive to receive it.
  if (!isOrchestratorAlive()) {
    log.debug('orch-wake: orchestrator not alive — skipping wake inject', { jobId: job.id });
    return;
  }

  const taskId = rows[0]!.task_id;
  const wakeMsg = `[worker complete] Job ${job.id} finished (${job.status}) for task ${taskId}. Check worker results and continue task synthesis.`;

  // Fire-and-forget: injectMessage is async (kithkit#2743). Must NOT block
  // finishJob's sync path or wedge processQueue (assertion c). Mirror the
  // spawn-nudge pattern in tmux.ts:668/671 with .catch() for error capture.
  injectMessage('orchestrator', wakeMsg).catch(err => {
    log.warn('orch-wake: failed to inject worker-complete wake', {
      jobId: job.id,
      taskId,
      error: String(err),
    });
  });

  log.info('orch-wake: wake inject fired for orch-parented job', {
    jobId: job.id,
    jobStatus: job.status,
    taskId,
  });
}

// ── Public API ───────────────────────────────────────────────

/**
 * Register the orchestrator-wake listener. Call once at daemon bootstrap,
 * after setOnJobComplete() (which clears listeners) has been called.
 */
export function registerOrchWake(): void {
  addOnJobComplete(orchWakeListener);
}

// ── Testing ──────────────────────────────────────────────────

/** @internal Override injectable deps for testing. Pass null to restore originals. */
export function _setOrchWakeDepsForTesting(deps: {
  isOrchestratorAlive?: () => boolean;
  injectMessage?: (target: string, text: string) => Promise<boolean>;
} | null): void {
  if (deps === null) {
    isOrchestratorAlive = _isOrchestratorAlive;
    injectMessage = _injectMessage;
    return;
  }
  if (deps.isOrchestratorAlive !== undefined) isOrchestratorAlive = deps.isOrchestratorAlive;
  if (deps.injectMessage !== undefined) injectMessage = deps.injectMessage;
}
