/**
 * Stale Task Recovery — proactive safety net for orphaned orchestrator tasks.
 *
 * Runs every 5 minutes. Detects tasks in assigned/in_progress whose updated_at
 * exceeds a configurable staleness threshold and recovers them:
 *
 *   - Orchestrator DEAD: tasks with no live workers are marked 'failed'
 *     (error = 'stale_task_recovery'). This is the primary recovery path —
 *     a backup for cases where orchestrator-idle's event-based zombie cleanup
 *     didn't run (e.g. daemon restart interrupted it).
 *
 *   - Orchestrator ALIVE: stale tasks are logged as warnings only. The
 *     orchestrator is still running and may complete them; we must not
 *     race with it.
 *
 * How this differs from orchestrator-idle.ts death-cleanup:
 *   - orchestrator-idle.cleanupZombieTasks()  → event-based, triggered when
 *     the idle monitor first detects the orch died. Marks ALL in_progress/
 *     assigned tasks failed immediately.
 *   - orchestrator-idle.cleanupOrphanedTasks() → triggered on orch SPAWN,
 *     cleans up tasks from the previous instance.
 *   - THIS handler → time-based, runs on a schedule (5 min) using configurable
 *     staleness thresholds. Catches tasks that slipped past both of the above
 *     (e.g. daemon restart gap, early process kill before idle-monitor fired).
 *     Also skips tasks that still have a live worker — those may still complete.
 *
 * Uses the unified `tasks` table (kind = 'orchestrator', migration 024).
 * Falls back gracefully if legacy orchestrator_task_activity insert fails.
 *
 * Refs: kithkit#335, fleet tracking #123
 */

import { query, exec } from '../../core/db.js';
import { isOrchestratorAlive as _isOrchestratorAlive, injectMessage as _injectMessage } from '../../agents/tmux.js';
import { getJobStatus as _getJobStatus } from '../../agents/lifecycle.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';
import { evaluateTask as _evaluateTask } from '../../self-improvement/retro-evaluator.js';

const log = createLogger('orch-stale-task-recovery');

// ── Default thresholds ────────────────────────────────────────

/** Default ms before an 'assigned' task with no update is considered stale. */
const DEFAULT_ASSIGNED_STALE_MS = 30 * 60 * 1000; // 30 min

/** Default ms before an 'in_progress' task with no update is considered stale. */
const DEFAULT_IN_PROGRESS_STALE_MS = 60 * 60 * 1000; // 60 min

// ── Injectable deps (overridable for testing) ────────────────

// We only need the status field from a job record for the live-worker check.
type JobStatusLike = { status: string } | null;

let isOrchestratorAlive: () => boolean = _isOrchestratorAlive;
let injectMessage: (agentId: string, text: string) => boolean = _injectMessage;
let getJobStatus: (jobId: string) => JobStatusLike = _getJobStatus;
let evaluateTask: (taskId: string) => Promise<void> = _evaluateTask;

export function _setDepsForTesting(deps: {
  isOrchestratorAlive?: () => boolean;
  injectMessage?: (agentId: string, text: string) => boolean;
  getJobStatus?: (jobId: string) => JobStatusLike;
  evaluateTask?: (taskId: string) => Promise<void>;
} | null): void {
  if (deps === null) {
    isOrchestratorAlive = _isOrchestratorAlive;
    injectMessage = _injectMessage;
    getJobStatus = _getJobStatus;
    evaluateTask = _evaluateTask;
    return;
  }
  if (deps.isOrchestratorAlive) isOrchestratorAlive = deps.isOrchestratorAlive;
  if (deps.injectMessage) injectMessage = deps.injectMessage;
  if (deps.getJobStatus) getJobStatus = deps.getJobStatus;
  if (deps.evaluateTask) evaluateTask = deps.evaluateTask;
}

// ── Types ────────────────────────────────────────────────────

interface StaleTask {
  /** tasks.id — INTEGER primary key (used for task_workers JOIN). */
  rowid: number;
  /** tasks.external_id — UUID exposed via API. */
  ext_id: string;
  title: string;
  status: string;
  updated_at: string;
}

interface TaskWorkerRow {
  worker_id: string;
}

// ── Helpers ──────────────────────────────────────────────────

/**
 * Check if any workers assigned to a task are still queued or running.
 * Uses the unified task_workers table (task_id = tasks.id INTEGER PK).
 * Also falls back to legacy orchestrator_task_workers keyed by ext_id.
 */
function hasLiveWorkers(rowid: number, extId: string): boolean {
  // Check unified task_workers (task_id = INTEGER PK)
  let workers: TaskWorkerRow[] = [];
  try {
    workers = query<TaskWorkerRow>(
      'SELECT worker_id FROM task_workers WHERE task_id = ?',
      rowid,
    );
  } catch {
    // task_workers not yet present (pre-024 migration instance) — fall through to legacy
  }

  // Fall back to legacy orchestrator_task_workers (task_id = external UUID)
  if (workers.length === 0) {
    try {
      workers = query<TaskWorkerRow>(
        'SELECT worker_id FROM orchestrator_task_workers WHERE task_id = ?',
        extId,
      );
    } catch {
      // No legacy table either — treat as no workers
    }
  }

  for (const w of workers) {
    try {
      const job = getJobStatus(w.worker_id);
      if (job && (job.status === 'queued' || job.status === 'running')) {
        return true;
      }
    } catch {
      // Worker not found — not alive
    }
  }
  return false;
}

/**
 * Record a stale-recovery note on a task.
 * Tries task_activity (unified), falls back to orchestrator_task_activity (legacy).
 */
function recordRecoveryNote(rowid: number, extId: string, previousStatus: string, ts: string): void {
  const message = `Task failed: stale, orchestrator session was dead (previous status: ${previousStatus})`;

  // Try unified task_activity (task_id = INTEGER PK)
  try {
    exec(
      `INSERT INTO task_activity (task_id, agent, type, stage, message, created_at)
       VALUES (?, 'daemon', 'note', 'stale_recovery', ?, ?)`,
      rowid, message, ts,
    );
    return;
  } catch {
    // task_activity not yet present — try legacy
  }

  // Fall back to legacy orchestrator_task_activity (task_id = external UUID)
  try {
    exec(
      `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
       VALUES (?, 'daemon', 'note', 'stale_recovery', ?, ?)`,
      extId, message, ts,
    );
  } catch {
    // Neither table available — activity note is best-effort, silently skip
  }
}

// ── Core run logic ────────────────────────────────────────────

export async function _runForTesting(config: Record<string, unknown>): Promise<void> {
  return run(config);
}

async function run(config: Record<string, unknown>): Promise<void> {
  const assignedStaleMs = typeof config.stale_assigned_ms === 'number'
    ? config.stale_assigned_ms
    : DEFAULT_ASSIGNED_STALE_MS;

  const inProgressStaleMs = typeof config.stale_in_progress_ms === 'number'
    ? config.stale_in_progress_ms
    : DEFAULT_IN_PROGRESS_STALE_MS;

  const orchAlive = isOrchestratorAlive();
  const now = Date.now();
  const ts = new Date().toISOString();

  // Query all assigned/in_progress orchestrator tasks with their timestamps.
  // Using the unified tasks table (kind = 'orchestrator').
  let candidates: StaleTask[] = [];
  try {
    candidates = query<StaleTask>(
      `SELECT id AS rowid, external_id AS ext_id, title, status, updated_at
       FROM tasks
       WHERE kind = 'orchestrator' AND status IN ('assigned', 'in_progress')`,
    );
  } catch (err) {
    log.error('Failed to query tasks table for stale recovery', { error: String(err) });
    return;
  }

  if (candidates.length === 0) return;

  // Filter to stale tasks (beyond the per-status threshold)
  const stale = candidates.filter(task => {
    const updatedMs = new Date(task.updated_at).getTime();
    if (isNaN(updatedMs)) return false; // malformed timestamp — skip
    const ageMs = now - updatedMs;
    return task.status === 'assigned'
      ? ageMs > assignedStaleMs
      : ageMs > inProgressStaleMs;
  });

  if (stale.length === 0) return;

  if (!orchAlive) {
    // Orchestrator is dead — recover stale tasks that have no live workers
    let recovered = 0;

    for (const task of stale) {
      try {
        if (hasLiveWorkers(task.rowid, task.ext_id)) {
          log.debug('Stale task has live workers — skipping recovery', {
            taskId: task.ext_id,
            status: task.status,
          });
          continue;
        }

        exec(
          `UPDATE tasks
           SET status = 'failed',
               error = 'stale_task_recovery',
               completed_at = ?,
               updated_at = ?
           WHERE kind = 'orchestrator' AND external_id = ?`,
          ts, ts, task.ext_id,
        );

        recordRecoveryNote(task.rowid, task.ext_id, task.status, ts);

        // Fire-and-forget retro evaluation — stale-recovered tasks are real
        // failures (orch dead, work abandoned) and previously never got a
        // retro because they bypass the normal task-completion API path.
        // evaluateTask self-gates on self_improvement config and never throws.
        try {
          void evaluateTask(task.ext_id);
        } catch { /* best-effort — recovery must not be interrupted */ }

        recovered++;
        log.warn('Stale task recovered (orch dead)', {
          taskId: task.ext_id,
          title: task.title.slice(0, 80),
          previousStatus: task.status,
          ageMs: now - new Date(task.updated_at).getTime(),
        });
      } catch (err) {
        log.error('Failed to recover stale task', { taskId: task.ext_id, error: String(err) });
      }
    }

    if (recovered > 0) {
      try {
        injectMessage(
          'comms',
          `[stale-recovery] ${recovered} task(s) marked failed — orchestrator session was dead and tasks were stale`,
        );
      } catch {
        // Comms inject is best-effort
      }
      log.info('Stale task recovery complete', { recovered, total: stale.length });
    }
  } else {
    // Orchestrator is alive — warn only; do not fail tasks the orch may still complete.
    for (const task of stale) {
      log.warn('Stale orchestrator task detected (orch alive — monitoring only)', {
        taskId: task.ext_id,
        title: task.title.slice(0, 80),
        status: task.status,
        ageMs: now - new Date(task.updated_at).getTime(),
      });
    }
  }
}

// ── Registration ─────────────────────────────────────────────

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('orch-stale-task-recovery', async (ctx) => {
    await run(ctx.config);
  });
}
