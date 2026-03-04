/**
 * Stale Task Recovery — detects and fails tasks orphaned by a dead orchestrator.
 *
 * Runs every 5 minutes. Finds tasks in assigned/in_progress where:
 * - The orchestrator session is dead
 * - No live workers are running for that task
 *
 * Transitions those tasks to 'failed' with a descriptive note.
 * This replaces the old wrapper's exit-cleanup responsibility.
 */

import { query, exec } from '../../core/db.js';
import { isOrchestratorAlive, injectMessage } from '../../agents/tmux.js';
import { getJobStatus } from '../../agents/lifecycle.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('orch-stale-task-recovery');

interface StaleTask {
  id: string;
  title: string;
  status: string;
}

interface TaskWorkerRow {
  worker_id: string;
}

/**
 * Check if any workers assigned to a task are still alive (queued or running).
 */
function hasLiveWorkers(taskId: string): boolean {
  const workers = query<TaskWorkerRow>(
    'SELECT worker_id FROM orchestrator_task_workers WHERE task_id = ?',
    taskId,
  );

  for (const w of workers) {
    try {
      const status = getJobStatus(w.worker_id);
      if (status && (status.status === 'queued' || status.status === 'running')) {
        return true;
      }
    } catch {
      // Worker not found — not alive
    }
  }

  return false;
}

async function run(): Promise<void> {
  // Only run when orchestrator is dead
  if (isOrchestratorAlive()) {
    return;
  }

  const staleTasks = query<StaleTask>(
    `SELECT id, title, status FROM orchestrator_tasks
     WHERE status IN ('assigned', 'in_progress')`,
  );

  if (staleTasks.length === 0) return;

  const ts = new Date().toISOString();
  let recovered = 0;

  for (const task of staleTasks) {
    // Skip if task has live workers — they may still complete
    if (hasLiveWorkers(task.id)) {
      log.debug('Stale task has live workers — skipping', { taskId: task.id });
      continue;
    }

    exec(
      `UPDATE orchestrator_tasks SET status = 'failed', error = 'orchestrator_session_died', completed_at = ?, updated_at = ? WHERE id = ?`,
      ts, ts, task.id,
    );

    exec(
      `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
       VALUES (?, 'daemon', 'note', 'stale_recovery', ?, ?)`,
      task.id, `Task failed: orchestrator session died while task was ${task.status}`, ts,
    );

    recovered++;
    log.warn('Stale task recovered', { taskId: task.id, title: task.title.slice(0, 80), previousStatus: task.status });
  }

  if (recovered > 0) {
    // Notify comms
    injectMessage('comms', `[stale-recovery] ${recovered} task(s) marked failed — orchestrator session was dead`);
    log.info('Stale task recovery complete', { recovered });
  }
}

export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('orch-stale-task-recovery', async () => {
    await run();
  });
}
