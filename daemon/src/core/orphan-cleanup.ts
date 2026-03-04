/**
 * Orphan Cleanup — runs on daemon startup to clear stale resources.
 *
 * After a daemon crash or kill, active-looking database records accumulate
 * for resources whose owning sessions are long gone:
 *   - timers in 'pending' / 'snoozed' / 'fired' state for dead agent sessions
 *   - orchestrator_tasks stuck in 'assigned' / 'in_progress' state
 *   - worker_jobs stuck in 'running' / 'queued' state (belt-and-suspenders;
 *     the existing recoverFromRestart() also does this, but that function runs
 *     before migrations and has no session-awareness)
 *
 * Session liveness check:
 *   - Persistent agents (comms, orchestrator) — verified via
 *     `tmux has-session -t =<session>` (exit 0 = alive).
 *   - Worker processes — no persistent session; any running/queued worker
 *     record after a restart is definitionally orphaned (the SDK process died
 *     with the daemon).
 *
 * This function is synchronous (uses better-sqlite3 + execFileSync), safe to
 * call multiple times (all DB updates are idempotent), and designed to run
 * after migrations but before the scheduler initialises.
 */

import { execFileSync } from 'node:child_process';
import { query, exec } from './db.js';
import { createLogger } from './logger.js';
import { TMUX_BIN, TMUX_SOCKET, resolveSession } from '../agents/tmux.js';

const log = createLogger('orphan-cleanup');

// ── Types ────────────────────────────────────────────────────

export interface OrphanCleanupReport {
  timersExpired: number;
  tasksFailedOrphaned: number;
  jobsFailedOrphaned: number;
}

// ── Session liveness helpers ─────────────────────────────────

/**
 * Map a timer's `session` column (agent id) to a tmux session name.
 * Delegates to tmux.ts resolveSession() — single source of truth for
 * agent-to-session mapping.
 */
function agentToTmuxSession(agentId: string): string {
  return resolveSession(agentId) ?? agentId;
}

/**
 * Check whether a tmux session is currently alive.
 * Returns true only if `tmux has-session` exits 0.
 */
function isTmuxSessionAlive(sessionName: string): boolean {
  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${sessionName}`], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
}

// ── Orphan detection ─────────────────────────────────────────

interface TimerRow {
  id: string;
  session: string;
  status: string;
}

interface TaskRow {
  id: string;
  title: string;
  status: string;
  assignee: string | null;
}

interface JobRow {
  id: string;
  profile: string;
  status: string;
}

// ── Main cleanup function ────────────────────────────────────

/**
 * Identify and clean up orphaned resources left over from a previous daemon
 * run.  Safe to call on every startup — all mutations are idempotent.
 *
 * Steps:
 *  1. Expire timers whose owner session is gone.
 *  2. Fail orchestrator_tasks that are assigned/in_progress but whose
 *     assignee session is gone.
 *  3. Fail worker_jobs stuck in running/queued (workers die with the daemon
 *     process; there is no persistent process to check).
 *
 * @returns A report summarising what was cleaned up.
 */
export function cleanupOrphanedResources(): OrphanCleanupReport {
  const ts = new Date().toISOString();
  const report: OrphanCleanupReport = {
    timersExpired: 0,
    tasksFailedOrphaned: 0,
    jobsFailedOrphaned: 0,
  };

  log.info('Orphan cleanup starting');

  // ── 1. Timers ────────────────────────────────────────────
  //
  // Active timer statuses: 'pending', 'snoozed', 'fired'.
  // Each timer targets a session ('comms' or 'orchestrator').
  // If that session is gone the timer can never fire/nag usefully.

  const activeTimers = query<TimerRow>(
    `SELECT id, session, status FROM timers WHERE status IN ('pending', 'snoozed', 'fired')`,
  );

  // Cache liveness checks per session name to avoid repeated tmux calls
  const sessionAliveCache = new Map<string, boolean>();

  for (const timer of activeTimers) {
    const tmuxSession = agentToTmuxSession(timer.session);

    if (!sessionAliveCache.has(tmuxSession)) {
      sessionAliveCache.set(tmuxSession, isTmuxSessionAlive(tmuxSession));
    }

    if (!sessionAliveCache.get(tmuxSession)) {
      exec(
        `UPDATE timers SET status = 'expired', completed_at = ? WHERE id = ?`,
        ts, timer.id,
      );
      report.timersExpired++;
      log.info('Timer expired (orphaned session)', {
        id: timer.id,
        session: timer.session,
        tmuxSession,
        previousStatus: timer.status,
      });
    }
  }

  // ── 2. Orchestrator tasks ────────────────────────────────
  //
  // Tasks in 'assigned' or 'in_progress' state have an active assignee.
  // The only assignee that matters for session-checking is 'orchestrator'.
  // If the orchestrator session is gone, these tasks can never complete.

  const activeTasks = query<TaskRow>(
    `SELECT id, title, status, assignee FROM orchestrator_tasks WHERE status IN ('assigned', 'in_progress')`,
  );

  for (const task of activeTasks) {
    const assignee = task.assignee ?? 'orchestrator';
    const tmuxSession = agentToTmuxSession(assignee);

    if (!sessionAliveCache.has(tmuxSession)) {
      sessionAliveCache.set(tmuxSession, isTmuxSessionAlive(tmuxSession));
    }

    if (!sessionAliveCache.get(tmuxSession)) {
      exec(
        `UPDATE orchestrator_tasks SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
        'orphaned — owning agent session not found on daemon restart',
        ts, ts, task.id,
      );
      report.tasksFailedOrphaned++;
      log.info('Orchestrator task failed (orphaned session)', {
        id: task.id,
        title: task.title,
        previousStatus: task.status,
        assignee,
        tmuxSession,
      });
    }
  }

  // ── 3. Worker jobs ───────────────────────────────────────
  //
  // Worker jobs run as SDK sub-processes inside the daemon process.
  // When the daemon exits, all worker processes die with it.
  // Any 'running' or 'queued' worker_jobs after a restart are definitionally
  // orphaned — there is no live process to check.
  //
  // Note: recoverFromRestart() in agents/recovery.ts already does a similar
  // sweep, but it's belt-and-suspenders here as well.  The check is
  // intentionally scoped to jobs that still have NULL finished_at (i.e. the
  // earlier recovery pass hasn't touched them yet, which shouldn't happen in
  // normal flow but can occur during testing or unusual restart sequences).

  const stuckJobs = query<JobRow>(
    `SELECT id, profile, status FROM worker_jobs WHERE status IN ('running', 'queued') AND finished_at IS NULL`,
  );

  for (const job of stuckJobs) {
    exec(
      `UPDATE worker_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      'orphaned — daemon restarted while job was active',
      ts, job.id,
    );
    report.jobsFailedOrphaned++;
    log.info('Worker job failed (orphaned on restart)', {
      id: job.id,
      profile: job.profile,
      previousStatus: job.status,
    });
  }

  // ── Summary ──────────────────────────────────────────────

  const totalCleaned = report.timersExpired + report.tasksFailedOrphaned + report.jobsFailedOrphaned;
  if (totalCleaned > 0) {
    log.info('Orphan cleanup completed', {
      timersExpired: report.timersExpired,
      tasksFailedOrphaned: report.tasksFailedOrphaned,
      jobsFailedOrphaned: report.jobsFailedOrphaned,
      total: totalCleaned,
    });
  } else {
    log.info('Orphan cleanup completed — no orphans found');
  }

  return report;
}
