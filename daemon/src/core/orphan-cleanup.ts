/**
 * Orphan Cleanup — runs on daemon startup to clear stale resources.
 *
 * After a daemon crash or kill, active-looking database records accumulate
 * for resources whose owning sessions are long gone:
 *   - timers in 'pending' / 'snoozed' / 'fired' state for dead agent sessions
 *   - orchestrator tasks (tasks WHERE kind='orchestrator') stuck in 'assigned' / 'in_progress' state
 *   - worker_jobs stuck in 'running' / 'queued' state (belt-and-suspenders;
 *     the existing recoverFromRestart() also does this, but that function runs
 *     before migrations and has no session-awareness)
 *
 * Liveness check:
 *   - Persistent agents (comms, orchestrator) — verified via
 *     `tmux has-session -t =<session>` (exit 0 = alive).
 *   - Worker jobs — each row records the pid/start-time of the daemon
 *     process that spawned it (owner_pid/owner_started_at). A row is only
 *     claimed if that owning process is verifiably gone (see
 *     core/process-liveness.ts) — never claimed unconditionally, since a
 *     second daemon process attached to the same database may still own it.
 *
 * This function is synchronous (uses better-sqlite3 + execFileSync), safe to
 * call multiple times (all DB updates are idempotent), and designed to run
 * after migrations but before the scheduler initialises.
 */

import { execFileSync } from 'node:child_process';
import { query, exec } from './db.js';
import { createLogger } from './logger.js';
import {
  TMUX_BIN,
  TMUX_SOCKET,
  resolveSession,
  getOrchestratorState as _getOrchestratorState,
  killOrchestratorSession as _killOrchestratorSession,
} from '../agents/tmux.js';
import { isProcessAlive as _isProcessAliveReal } from './process-liveness.js';

const log = createLogger('orphan-cleanup');

// ── Injectable deps (for testing) ────────────────────────────

let _isTmuxSessionAlive = (sessionName: string): boolean => {
  try {
    execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${sessionName}`], {
      timeout: 5000,
      stdio: 'ignore',
    });
    return true;
  } catch {
    return false;
  }
};

let _orchStateFn: () => 'active' | 'waiting' | 'dead' = _getOrchestratorState;
let _killOrchFn: () => boolean = _killOrchestratorSession;
let _isProcessAlive: (pid: number, startedAt: string | null) => boolean = _isProcessAliveReal;

/** @internal Override injectable deps for testing. Pass null to restore originals. */
export function _setDepsForTesting(deps: {
  isTmuxSessionAlive?: (sessionName: string) => boolean;
  getOrchestratorState?: () => 'active' | 'waiting' | 'dead';
  killOrchestratorSession?: () => boolean;
  isProcessAlive?: (pid: number, startedAt: string | null) => boolean;
} | null): void {
  if (deps === null) {
    _isTmuxSessionAlive = (sessionName: string): boolean => {
      try {
        execFileSync(TMUX_BIN, ['-S', TMUX_SOCKET, 'has-session', '-t', `=${sessionName}`], {
          timeout: 5000,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    };
    _orchStateFn = _getOrchestratorState;
    _killOrchFn = _killOrchestratorSession;
    _isProcessAlive = _isProcessAliveReal;
    return;
  }
  if (deps.isTmuxSessionAlive !== undefined) _isTmuxSessionAlive = deps.isTmuxSessionAlive;
  if (deps.getOrchestratorState !== undefined) _orchStateFn = deps.getOrchestratorState;
  if (deps.killOrchestratorSession !== undefined) _killOrchFn = deps.killOrchestratorSession;
  if (deps.isProcessAlive !== undefined) _isProcessAlive = deps.isProcessAlive;
}

// ── Types ────────────────────────────────────────────────────

export interface OrphanCleanupReport {
  timersExpired: number;
  tasksFailedOrphaned: number;
  jobsFailedOrphaned: number;
  staleOrchSessionKilled?: boolean;
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
 * Delegates to the injectable `_isTmuxSessionAlive` dep (overridable in tests).
 */
function isTmuxSessionAlive(sessionName: string): boolean {
  return _isTmuxSessionAlive(sessionName);
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
  owner_pid: number | null;
  owner_started_at: string | null;
}

// ── Main cleanup function ────────────────────────────────────

/**
 * Identify and clean up orphaned resources left over from a previous daemon
 * run.  Safe to call on every startup — all mutations are idempotent.
 *
 * Steps:
 *  1. Expire timers whose owner session is gone.
 *  2. Fail orchestrator tasks (tasks WHERE kind='orchestrator') that are assigned/in_progress
 *     but whose assignee session is gone.
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
  //
  // Query by internal primary key (id) — external_id may be NULL for some
  // rows (same NULL-safety class as the sn-todo-link fix).

  const activeTasks = query<TaskRow>(
    `SELECT id, title, status, assigned_to AS assignee FROM tasks WHERE kind = 'orchestrator' AND status IN ('assigned', 'in_progress')`,
  );

  for (const task of activeTasks) {
    const assignee = task.assignee ?? 'orchestrator';
    const tmuxSession = agentToTmuxSession(assignee);

    if (!sessionAliveCache.has(tmuxSession)) {
      sessionAliveCache.set(tmuxSession, isTmuxSessionAlive(tmuxSession));
    }

    if (!sessionAliveCache.get(tmuxSession)) {
      exec(
        `UPDATE tasks SET status = 'failed', error = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
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
  // Worker jobs are owned by whichever daemon process spawned them
  // (agents/lifecycle.ts stamps owner_pid/owner_started_at at INSERT time).
  // A 'running'/'queued' row is only safe to claim if its owning process is
  // actually gone — checked via a real liveness probe (process-liveness.ts),
  // not assumed. If a second daemon process ever attaches to the same
  // database, this stops the sweep from claiming the first daemon's
  // genuinely-live workers out from under it.
  //
  // Rows with no owner_pid recorded predate ownership tracking (written
  // before this column existed) — there is no liveness info to check, so
  // they are claimed as orphaned, matching the old behavior for that legacy
  // case only. Every row written from this point forward always carries an
  // owner_pid.
  //
  // Note: recoverFromRestart() in agents/recovery.ts already does a similar
  // sweep, but it's belt-and-suspenders here as well.  The check is
  // intentionally scoped to jobs that still have NULL finished_at (i.e. the
  // earlier recovery pass hasn't touched them yet, which shouldn't happen in
  // normal flow but can occur during testing or unusual restart sequences).

  const stuckJobs = query<JobRow>(
    `SELECT id, profile, status, owner_pid, owner_started_at FROM worker_jobs WHERE status IN ('running', 'queued') AND finished_at IS NULL`,
  );

  for (const job of stuckJobs) {
    let orphanReason: string | null = null;

    if (job.owner_pid == null) {
      orphanReason = 'orphaned — no owner process recorded for this job (predates ownership tracking)';
    } else if (!_isProcessAlive(job.owner_pid, job.owner_started_at)) {
      orphanReason = `orphaned — owning process (pid ${job.owner_pid}) is no longer running`;
    }

    if (orphanReason === null) {
      // Owner process is still alive — this job is not orphaned, leave it.
      continue;
    }

    exec(
      `UPDATE worker_jobs SET status = 'failed', error = ?, finished_at = ? WHERE id = ?`,
      orphanReason, ts, job.id,
    );
    report.jobsFailedOrphaned++;
    log.info('Worker job failed (orphaned)', {
      id: job.id,
      profile: job.profile,
      previousStatus: job.status,
      ownerPid: job.owner_pid,
      reason: orphanReason,
    });
  }

  // ── 4. Stale orchestrator sessions ──────────────────────
  //
  // If the orch tmux session exists but has no Claude process running
  // (getOrchestratorState() returns 'waiting'), it is a zombie from a
  // previous run — the wrapper exited but tmux stayed alive with just
  // bash. The escalate handler would see it as alive and queue work that
  // nobody picks up. Kill it so the next escalation spawns a fresh session.

  const orchState = _orchStateFn();
  if (orchState === 'waiting') {
    log.info('cleanupOrphanedResources: stale orch session detected — killing for clean spawn');
    _killOrchFn();
    report.staleOrchSessionKilled = true;
  }

  // ── Summary ──────────────────────────────────────────────

  const totalCleaned = report.timersExpired + report.tasksFailedOrphaned + report.jobsFailedOrphaned;
  if (totalCleaned > 0 || report.staleOrchSessionKilled) {
    log.info('Orphan cleanup completed', {
      timersExpired: report.timersExpired,
      tasksFailedOrphaned: report.tasksFailedOrphaned,
      jobsFailedOrphaned: report.jobsFailedOrphaned,
      staleOrchSessionKilled: report.staleOrchSessionKilled ?? false,
      total: totalCleaned,
    });
  } else {
    log.info('Orphan cleanup completed — no orphans found');
  }

  return report;
}
