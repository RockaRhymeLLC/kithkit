/**
 * Orchestrator Idle Monitor — graceful shutdown after inactivity or context exhaustion.
 *
 * Two shutdown triggers:
 * - Idle timeout: no active workers and no recent activity for 10 min (configurable)
 * - Context exhaustion: orchestrator's context usage exceeds 80%
 *
 * Shutdown sequence:
 * 1. Inject a graceful shutdown prompt into the orchestrator's tmux session
 * 2. Give it 60 seconds to wrap up (send final status, exit cleanly)
 * 3. If still alive after grace period, force-kill the session
 */

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { query, exec, update } from '../../core/db.js';
import { resolveProjectPath } from '../../core/config.js';
import {
  isOrchestratorAlive as _isOrchestratorAlive,
  killOrchestratorSession as _killOrchestratorSession,
  injectMessage as _injectMessage,
  _getOrchestratorSession,
  TMUX_BIN,
  TMUX_SOCKET,
} from '../../agents/tmux.js';
import { cleanupSessionDirs as _cleanupSessionDirs } from '../../agents/lifecycle.js';
import { createLogger } from '../../core/logger.js';
import { logActivity, getActivity } from '../../api/activity.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('orchestrator-idle');

// ── Injectable deps (overridable for testing) ────────────────

let isOrchestratorAlive = _isOrchestratorAlive;
let killOrchestratorSession = _killOrchestratorSession;
let injectMessage = _injectMessage;
let cleanupSessionDirs = _cleanupSessionDirs;

/**
 * Dump post-mortem state to the orchestrator's session directory.
 * Writes agent DB record + recent activity log entries.
 */
function writePostMortem(reason: string): void {
  const sessionDir = resolveProjectPath('.claude', 'sessions', 'orchestrator');
  try {
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const agentRows = query<Record<string, unknown>>(
      "SELECT * FROM agents WHERE id = 'orchestrator'",
    );
    const recentActivity = getActivity('orchestrator', { limit: 20 });

    const postMortem = {
      reason,
      timestamp: new Date().toISOString(),
      agent: agentRows[0] ?? null,
      recent_activity: recentActivity,
    };

    fs.writeFileSync(
      `${sessionDir}/post-mortem.json`,
      JSON.stringify(postMortem, null, 2),
    );
  } catch (err) {
    log.warn('Failed to write post-mortem', { error: String(err) });
  }
}

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CONTEXT_THRESHOLD_PCT = 65; // Daemon backstop — orchestrator self-restarts at 50%
const CONTEXT_STALE_SECONDS = 600; // Ignore context data older than 10 min
const GRACE_PERIOD_MS = 60 * 1000; // 60 seconds to exit after nudge

/**
 * Check if the Claude process is actively running in the orchestrator's tmux session.
 *
 * The orchestrator runs inside a bash wrapper script, so tmux's pane_current_command
 * always reports "bash" — not "claude". Instead, we get the wrapper's PID via
 * `#{pane_pid}` and use `pgrep -P <panePid> -f claude` to check whether a claude
 * process is a descendant of the wrapper. This matches the approach used by
 * `getOrchestratorState()` in agents/tmux.ts.
 */
function isClaudeProcessRunning(): boolean {
  try {
    const session = _getOrchestratorSession();

    // Get the PID of the wrapper bash process that owns the tmux pane
    const panePid = execFileSync(TMUX_BIN, [
      '-S', TMUX_SOCKET,
      'display-message',
      '-t', `${session}:`,
      '-p', '#{pane_pid}',
    ], { encoding: 'utf8', timeout: 5000 }).trim();

    if (!panePid || !/^\d+$/.test(panePid)) {
      return false;
    }

    // Check if any "claude" process is a descendant of the wrapper PID.
    // pgrep exits 0 if found, non-zero if not.
    try {
      execFileSync('/usr/bin/pgrep', ['-P', panePid, '-f', 'claude'], {
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  } catch {
    return false;
  }
}

// Track whether we've already sent the shutdown nudge
let shutdownNudgedAt: number | null = null;
let shutdownReason: string | null = null;

function buildShutdownPrompt(reason: string): string {
  return [
    `Shutdown requested: ${reason}`,
    'Please wrap up gracefully:',
    '1. If you have any unsent findings or context, send a final result to comms now:',
    '   curl -s -X POST http://localhost:3847/api/messages -H "Content-Type: application/json" -d \'{"from":"orchestrator","to":"comms","type":"result","body":"<any final notes>"}\'',
    '2. Then exit by running: exit',
    '',
    'If you are actively working on something, say so — the daemon will check again later.',
  ].join('\n');
}

/**
 * Mark all in_progress and assigned tasks as failed when the orchestrator dies.
 * Returns count of zombie tasks cleaned up.
 */
function cleanupZombieTasks(): number {
  const ts = new Date().toISOString();
  const zombies = query<{ id: string; status: string }>(
    `SELECT id, status FROM orchestrator_tasks WHERE status IN ('in_progress', 'assigned')`,
  );
  for (const task of zombies) {
    exec(
      `UPDATE orchestrator_tasks SET status = 'failed', error = 'orchestrator_died', completed_at = ?, updated_at = ? WHERE id = ?`,
      ts, ts, task.id,
    );
    // Auto-log activity for each zombie task
    exec(
      `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
       VALUES (?, 'daemon', 'note', 'cleanup', ?, ?)`,
      task.id, `Task failed: orchestrator died while task was ${task.status}`, ts,
    );
  }
  if (zombies.length > 0) {
    log.warn('Cleaned up zombie tasks after orchestrator death', { count: zombies.length, taskIds: zombies.map(t => t.id) });
  }
  return zombies.length;
}

const PENDING_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes
const STALE_WORK_NOTES_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Warn about tasks that are stale in the queue or have no recent activity.
 * Runs even when the orchestrator is dead — helps detect zombie tasks.
 */
function checkTaskTimeouts(): void {
  const now = Date.now();

  // Check pending/assigned tasks older than 5 minutes
  const stalePending = query<{ id: string; title: string; status: string; created_at: string; assigned_at: string | null }>(
    `SELECT id, title, status, created_at, assigned_at FROM orchestrator_tasks WHERE status IN ('pending', 'assigned')`,
  );
  for (const task of stalePending) {
    const refTime = task.assigned_at ?? task.created_at;
    const ageMs = now - new Date(refTime).getTime();
    if (ageMs > PENDING_TIMEOUT_MS) {
      log.warn('Task stale in queue', {
        taskId: task.id,
        title: task.title.slice(0, 80),
        status: task.status,
        ageMinutes: Math.round(ageMs / 60000),
      });
    }
  }

  // Check in_progress tasks with no recent work_notes updates
  const activeTaskRows = query<{ id: string; title: string; updated_at: string; work_notes: string | null }>(
    `SELECT id, title, updated_at, work_notes FROM orchestrator_tasks WHERE status = 'in_progress'`,
  );
  for (const task of activeTaskRows) {
    const lastUpdate = new Date(task.updated_at).getTime();
    if (now - lastUpdate > STALE_WORK_NOTES_MS) {
      log.warn('In-progress task with no recent updates', {
        taskId: task.id,
        title: task.title.slice(0, 80),
        lastUpdateMinutes: Math.round((now - lastUpdate) / 60000),
        hasWorkNotes: !!task.work_notes,
      });
    }
  }
}

/**
 * Read the orchestrator's context usage from its separate state file.
 */
function getOrchestratorContextUsage(): number | null {
  const stateFile = resolveProjectPath('.claude', 'state', 'context-usage-orch.json');
  try {
    if (!fs.existsSync(stateFile)) return null;
    const stats = fs.statSync(stateFile);
    const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
    if (ageSeconds > CONTEXT_STALE_SECONDS) return null;
    const data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    return data.used_percentage ?? null;
  } catch {
    return null;
  }
}

async function run(config: Record<string, unknown>): Promise<void> {
  // Periodic cleanup: remove session directories older than 7 days
  try {
    const cleaned = cleanupSessionDirs(7);
    if (cleaned > 0) log.info('Cleaned up stale session directories', { cleaned });
  } catch (err) {
    log.warn('Session dir cleanup failed', { error: String(err) });
  }

  // Check task timeouts on every tick — runs even when orchestrator is dead.
  // This catches stale/zombie tasks from a dead orchestrator early.
  checkTaskTimeouts();

  // If we previously nudged, check the outcome BEFORE the alive check.
  // The orchestrator may have exited gracefully in response to our nudge —
  // if we check alive first and reset nudge state, we'd never log the graceful exit.
  if (shutdownNudgedAt !== null) {
    if (!isOrchestratorAlive()) {
      // Orchestrator exited after our nudge — log the graceful exit
      log.info('Orchestrator exited gracefully after shutdown nudge', { reason: shutdownReason });
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'session_end',
        details: `Graceful exit after nudge: ${shutdownReason}`,
      });
      // Clean up any tasks that were left in-progress or assigned
      cleanupZombieTasks();
      shutdownNudgedAt = null;
      shutdownReason = null;
      return;
    }

    const elapsed = Date.now() - shutdownNudgedAt;
    if (elapsed >= GRACE_PERIOD_MS) {
      log.warn('Orchestrator did not exit within grace period — force killing', { reason: shutdownReason });
      writePostMortem(`Grace period expired: ${shutdownReason}`);
      killOrchestratorSession();
      update('agents', 'orchestrator', {
        status: 'stopped',
        updated_at: new Date().toISOString(),
      });
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'shutdown_reason',
        details: `Force-killed after grace period: ${shutdownReason}`,
      });
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'session_end',
        details: `Force-killed: grace period expired (${shutdownReason})`,
      });
      // Clean up any tasks that were left in-progress or assigned
      cleanupZombieTasks();
      shutdownNudgedAt = null;
      shutdownReason = null;
      return;
    }

    // Still within grace period — let it finish
    return;
  }

  // Not alive and no pending nudge — check for zombie tasks left behind
  if (!isOrchestratorAlive()) {
    cleanupZombieTasks();
    return;
  }

  const idleTimeoutMs = typeof config.idle_timeout_minutes === 'number'
    ? config.idle_timeout_minutes * 60 * 1000
    : DEFAULT_IDLE_TIMEOUT_MS;

  // --- Check 0: Process-level liveness ---
  // Claude can pause for long periods during complex tasks (thinking, generating).
  // If the Claude process is still running, the orchestrator is NOT idle — even if
  // last_activity hasn't been updated. This prevents premature kills.
  // This check MUST run before the active workers check — a long-running Claude
  // process with no spawned workers should not be killed.
  if (isClaudeProcessRunning()) {
    log.debug('Claude process still running in orchestrator session — not idle');
    // Touch last_activity so the DB stays fresh
    update('agents', 'orchestrator', {
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    return;
  }

  // Check if orchestrator has active workers
  const activeJobs = query<{ count: number }>(
    "SELECT COUNT(*) as count FROM worker_jobs WHERE status IN ('queued', 'running')",
  );
  if ((activeJobs[0]?.count ?? 0) > 0) {
    log.debug('Workers still running — not idle');
    return; // Workers still running — not idle
  }

  // --- Check 1: Context exhaustion (backstop) ---
  // The orchestrator should self-restart at ~60% context. This is the safety net
  // at 65% in case it didn't. We tell it to save state and exit so it can be respawned.
  const contextUsed = getOrchestratorContextUsage();
  if (contextUsed !== null && contextUsed >= CONTEXT_THRESHOLD_PCT) {
    const reason = `context at ${contextUsed}% — save any pending work state to the daemon (POST /api/messages) and exit. The daemon will respawn you with that context.`;
    log.warn('Orchestrator context backstop triggered', { contextUsed });
    const injected = injectMessage('orchestrator', buildShutdownPrompt(reason));
    if (injected) {
      shutdownNudgedAt = Date.now();
      shutdownReason = `context exhaustion (${contextUsed}%)`;
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'shutdown_reason',
        details: `Context exhaustion: ${contextUsed}% used — nudge sent`,
      });
    } else {
      log.warn('Failed to inject context shutdown nudge — killing session');
      writePostMortem(`Context exhaustion: ${contextUsed}%, injection failed`);
      killOrchestratorSession();
      update('agents', 'orchestrator', { status: 'stopped', updated_at: new Date().toISOString() });
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'shutdown_reason',
        details: `Context exhaustion: ${contextUsed}% — failed to inject nudge, force-killed`,
      });
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'session_end',
        details: `Force-killed: context exhaustion (${contextUsed}%), injection failed`,
      });
    }
    return;
  }

  // --- Check 2: Idle timeout ---
  // Only reached if Claude process is NOT running (Check 0 above).
  // This handles the case where the orchestrator's tmux session is alive
  // but Claude has exited (left at a shell prompt).
  const rows = query<{ last_activity: string | null; started_at: string | null }>(
    "SELECT last_activity, started_at FROM agents WHERE id = 'orchestrator'",
  );
  const agent = rows[0];
  if (!agent) return;

  const lastActive = agent.last_activity ?? agent.started_at;
  if (!lastActive) return;

  const idleMs = Date.now() - new Date(lastActive).getTime();

  if (idleMs < idleTimeoutMs) {
    log.debug('Not idle long enough', { idleMinutes: Math.round(idleMs / 60000), thresholdMinutes: Math.round(idleTimeoutMs / 60000) });
    return; // Not idle long enough
  }

  // --- Check 3: Pending tasks ---
  // Before nudging shutdown, check if there are tasks waiting in the queue.
  // If so, wake the orchestrator with a task notification instead of shutting it down.
  // This covers the case where a task arrived while Claude was active and the
  // orchestrator went idle before the message-delivery cycle injected it.
  const pendingTaskRows = query<{ count: number; title: string }>(
    `SELECT COUNT(*) as count, MIN(title) as title FROM orchestrator_tasks
     WHERE status = 'pending'`,
  );
  const pendingTaskCount = pendingTaskRows[0]?.count ?? 0;
  if (pendingTaskCount > 0) {
    const taskTitle = pendingTaskRows[0]?.title ?? 'unknown';
    const wakeMsg = pendingTaskCount === 1
      ? `You have 1 pending task: "${taskTitle}" — check GET /api/orchestrator/tasks?status=pending`
      : `You have ${pendingTaskCount} pending tasks — check GET /api/orchestrator/tasks?status=pending`;
    log.info('Orchestrator idle but has pending tasks — waking instead of shutdown', { pendingTaskCount });
    const injected = injectMessage('orchestrator', wakeMsg);
    if (injected) {
      // Touch last_activity so we don't immediately re-trigger
      update('agents', 'orchestrator', {
        last_activity: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
      logActivity({
        agent_id: 'orchestrator',
        event_type: 'task_received',
        details: `Woken for ${pendingTaskCount} pending task(s): ${taskTitle}`,
      });
    }
    return;
  }

  const reason = `idle for ${Math.round(idleMs / 60000)} minutes — Claude process not running, no pending work`;
  log.info('Orchestrator idle — sending shutdown nudge', { idleMinutes: Math.round(idleMs / 60000) });
  const injected = injectMessage('orchestrator', buildShutdownPrompt(reason));

  if (injected) {
    shutdownNudgedAt = Date.now();
    shutdownReason = reason;
    logActivity({
      agent_id: 'orchestrator',
      event_type: 'shutdown_reason',
      details: `Idle timeout: ${reason} — nudge sent`,
    });
  } else {
    // Couldn't inject — session might be gone already
    log.warn('Failed to inject shutdown nudge — killing session');
    writePostMortem(`Idle timeout: ${reason}, injection failed`);
    killOrchestratorSession();
    update('agents', 'orchestrator', {
      status: 'stopped',
      updated_at: new Date().toISOString(),
    });
    logActivity({
      agent_id: 'orchestrator',
      event_type: 'shutdown_reason',
      details: `Idle timeout: ${reason} — failed to inject nudge, force-killed`,
    });
    logActivity({
      agent_id: 'orchestrator',
      event_type: 'session_end',
      details: `Force-killed: idle timeout, injection failed`,
    });
  }
}

/**
 * Register the orchestrator-idle task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('orchestrator-idle', async (ctx) => {
    await run(ctx.config);
  });
}

// ── Testing ──────────────────────────────────────────────────

/** @internal Reset nudge state for testing. */
export function _resetNudgeStateForTesting(): void {
  shutdownNudgedAt = null;
  shutdownReason = null;
}

/** @internal Set nudge state for testing. */
export function _setNudgeStateForTesting(at: number, reason: string): void {
  shutdownNudgedAt = at;
  shutdownReason = reason;
}

/** @internal Get current nudge state for testing. */
export function _getNudgeStateForTesting(): { nudgedAt: number | null; reason: string | null } {
  return { nudgedAt: shutdownNudgedAt, reason: shutdownReason };
}

/** @internal Expose run() for direct testing. */
export async function _runForTesting(config: Record<string, unknown>): Promise<void> {
  return run(config);
}

/** @internal Override injectable deps for testing. Pass null to restore originals. */
export function _setDepsForTesting(deps: {
  isOrchestratorAlive?: () => boolean;
  killOrchestratorSession?: () => boolean;
  injectMessage?: (target: string, text: string) => boolean;
  cleanupSessionDirs?: (maxAgeDays?: number) => number;
} | null): void {
  if (deps === null) {
    isOrchestratorAlive = _isOrchestratorAlive;
    killOrchestratorSession = _killOrchestratorSession;
    injectMessage = _injectMessage;
    cleanupSessionDirs = _cleanupSessionDirs;
    return;
  }
  if (deps.isOrchestratorAlive) isOrchestratorAlive = deps.isOrchestratorAlive;
  if (deps.killOrchestratorSession) killOrchestratorSession = deps.killOrchestratorSession;
  if (deps.injectMessage) injectMessage = deps.injectMessage;
  if (deps.cleanupSessionDirs) cleanupSessionDirs = deps.cleanupSessionDirs;
}
