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
import { resolveProjectPath, loadConfig } from '../../core/config.js';
import {
  isOrchestratorAlive as _isOrchestratorAlive,
  killOrchestratorSession as _killOrchestratorSession,
  injectMessage as _injectMessage,
  spawnOrchestratorSession as _spawnOrchestratorSession,
  _getOrchestratorSession,
  TMUX_BIN,
  TMUX_SOCKET,
} from '../../agents/tmux.js';
import { cleanupSessionDirs as _cleanupSessionDirs } from '../../agents/lifecycle.js';
import { sendMessage } from '../../agents/message-router.js';
import { createLogger } from '../../core/logger.js';
import { logActivity, getActivity } from '../../api/activity.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('orchestrator-idle');

// ── Injectable deps (overridable for testing) ────────────────

let isOrchestratorAlive = _isOrchestratorAlive;
let killOrchestratorSession = _killOrchestratorSession;
let injectMessage = _injectMessage;
let spawnOrchestratorSession = _spawnOrchestratorSession;
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
 * Check if Claude is actively processing in the orchestrator's tmux session.
 *
 * With --agent, Claude IS the tmux pane process. To distinguish "actively processing"
 * from "idle at the input prompt," we check whether Claude has child processes
 * (tool execution spawns children like bash, node, etc.).
 */
function isClaudeProcessRunning(): boolean {
  try {
    const session = _getOrchestratorSession();

    const panePid = execFileSync(TMUX_BIN, [
      '-S', TMUX_SOCKET,
      'display-message',
      '-t', `${session}:`,
      '-p', '#{pane_pid}',
    ], { encoding: 'utf8', timeout: 5000 }).trim();

    if (!panePid || !/^\d+$/.test(panePid)) {
      return false;
    }

    // Check if the pane process has child processes (tools running = actively working)
    try {
      execFileSync('/usr/bin/pgrep', ['-P', panePid], {
        timeout: 5000,
      });
      return true; // Has children → actively processing
    } catch {
      return false; // No children → idle at input prompt
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
    `   curl -s -X POST http://localhost:${loadConfig().daemon.port}/api/messages -H "Content-Type: application/json" -d '{"from":"orchestrator","to":"comms","type":"result","body":"<any final notes>"}'`,
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

/**
 * Detect tasks orphaned by a previous orchestrator instance.
 * When a new orchestrator spawns (e.g., via task escalation) while the old one's
 * tasks are still in_progress/assigned, those tasks belong to the dead instance.
 * We detect this by comparing task timestamps against the current orchestrator's started_at.
 * Returns count of orphaned tasks cleaned up.
 */
function cleanupOrphanedTasks(): number {
  // Get the current orchestrator's started_at
  const orchRows = query<{ started_at: string | null }>(
    "SELECT started_at FROM agents WHERE id = 'orchestrator'",
  );
  const orchStartedAt = orchRows[0]?.started_at;
  if (!orchStartedAt) return 0;

  const ts = new Date().toISOString();

  // Find tasks that are in_progress or assigned but whose relevant timestamp
  // predates the current orchestrator's started_at.
  // For in_progress: use started_at (when it transitioned to in_progress), fall back to created_at.
  // For assigned: use assigned_at, fall back to created_at.
  const orphans = query<{ id: string; status: string }>(
    `SELECT id, status FROM orchestrator_tasks
     WHERE status IN ('in_progress', 'assigned')
     AND (
       (status = 'in_progress' AND COALESCE(started_at, created_at) < ?)
       OR
       (status = 'assigned' AND COALESCE(assigned_at, created_at) < ?)
     )`,
    orchStartedAt, orchStartedAt,
  );

  for (const task of orphans) {
    exec(
      `UPDATE orchestrator_tasks SET status = 'failed', error = 'orchestrator_restarted', completed_at = ?, updated_at = ? WHERE id = ?`,
      ts, ts, task.id,
    );
    exec(
      `INSERT INTO orchestrator_task_activity (task_id, agent, type, stage, message, created_at)
       VALUES (?, 'daemon', 'note', 'cleanup', ?, ?)`,
      task.id, `Task failed: orchestrator restarted while task was ${task.status}`, ts,
    );
  }
  if (orphans.length > 0) {
    log.info('Cleaned up orphaned tasks from previous orchestrator instance', {
      count: orphans.length,
      taskIds: orphans.map(t => t.id),
    });
  }
  return orphans.length;
}

/**
 * Spawn a fresh orchestrator session to process pending tasks.
 * Called by the idle monitor when the orchestrator is dead but pending tasks exist.
 */
function respawnForPendingTasks(taskId: string, taskTitle: string, taskDesc: string, pendingCount: number): void {
  try {
    const session = spawnOrchestratorSession();
    if (!session) {
      log.error('Failed to respawn orchestrator for pending tasks');
      return;
    }

    // Register/update in agents table
    const ts = new Date().toISOString();
    try {
      exec(
        `INSERT INTO agents (id, type, profile, status, tmux_session, started_at, created_at, updated_at)
         VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', ?, ?, ?, ?)`,
        session, ts, ts, ts,
      );
    } catch {
      // Already exists — update
      update('agents', 'orchestrator', {
        status: 'running',
        tmux_session: session,
        started_at: ts,
        updated_at: ts,
      });
    }

    logActivity({
      agent_id: 'orchestrator',
      session_id: session,
      event_type: 'session_start',
      details: `Respawned by idle monitor for ${pendingCount} pending task(s): ${taskTitle.slice(0, 100)}`,
    });

    // Send the task as a message so it appears in the orchestrator's message history
    sendMessage({
      from: 'daemon',
      to: 'orchestrator',
      type: 'task',
      body: JSON.stringify({ task: taskTitle, context: taskDesc, task_id: taskId }),
    });

    log.info('Orchestrator respawned for pending tasks', { session, pendingCount, taskId });
  } catch (err) {
    log.error('Failed to respawn orchestrator', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

  // Check in_progress tasks with no recent updates
  const activeTaskRows = query<{ id: string; title: string; updated_at: string }>(
    `SELECT id, title, updated_at FROM orchestrator_tasks WHERE status = 'in_progress'`,
  );
  for (const task of activeTaskRows) {
    const lastUpdate = new Date(task.updated_at).getTime();
    if (now - lastUpdate > STALE_WORK_NOTES_MS) {
      log.warn('In-progress task with no recent updates', {
        taskId: task.id,
        title: task.title.slice(0, 80),
        lastUpdateMinutes: Math.round((now - lastUpdate) / 60000),
      });
    }
  }
}

/**
 * Read the orchestrator's context usage from its separate state file.
 */
function getOrchestratorContextUsage(): number | null {
  const stateFile = resolveProjectPath('.kithkit', 'state', 'context-usage-orch.json');
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

  // Check for stale plan approvals
  const fullConfig = loadConfig();
  const slaMinutes = (fullConfig as unknown as Record<string, Record<string, unknown>>)?.orchestrator?.plan_review_sla_minutes as number ?? 10;
  const slaThreshold = new Date(Date.now() - slaMinutes * 60 * 1000).toISOString();
  const stalePlans = query<{ id: string; title: string; plan_submitted_at: string }>(
    `SELECT id, title, plan_submitted_at FROM orchestrator_tasks
     WHERE status = 'awaiting_approval' AND plan_status = 'submitted'
     AND plan_submitted_at < ?`,
    slaThreshold,
  );

  if (stalePlans.length > 0) {
    for (const plan of stalePlans) {
      const waitMinutes = Math.round((Date.now() - new Date(plan.plan_submitted_at).getTime()) / 60000);
      const nudgeMsg = `[plan review needed] Task "${plan.title.slice(0, 80)}" has a plan waiting ${waitMinutes}m for approval (SLA: ${slaMinutes}m).\n` +
        `Approve: curl -s -X POST 'http://localhost:${fullConfig.daemon.port}/api/orchestrator/tasks/${plan.id}/approve-plan' -H 'Content-Type: application/json' -d '{}'\n` +
        `Reject: curl -s -X POST 'http://localhost:${fullConfig.daemon.port}/api/orchestrator/tasks/${plan.id}/reject-plan' -H 'Content-Type: application/json' -d '{"reason":"..."}'`;
      injectMessage('comms', nudgeMsg);
    }
    log.info('Nudged comms about stale plan approvals', { count: stalePlans.length });
  }

  // Detect orphaned tasks from a previous orchestrator instance.
  // Runs unconditionally — even when the orchestrator IS alive — because the new
  // orchestrator's liveness masks the dead one's abandoned tasks.
  cleanupOrphanedTasks();

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

  // Not alive and no pending nudge — check for zombie tasks, then respawn if pending work exists
  if (!isOrchestratorAlive()) {
    cleanupZombieTasks();

    // Ensure DB status reflects reality — the wrapper cleanup may have failed to update
    // (e.g. PUT /api/agents/orchestrator returned 404 before the fix).
    try {
      const agentRows = query<{ status: string }>(
        "SELECT status FROM agents WHERE id = 'orchestrator'",
      );
      if (agentRows[0] && agentRows[0].status !== 'stopped' && agentRows[0].status !== 'crashed') {
        log.warn('Orchestrator tmux session gone but DB status was stale — correcting', {
          oldStatus: agentRows[0].status,
        });
        update('agents', 'orchestrator', {
          status: 'stopped',
          updated_at: new Date().toISOString(),
        });
        logActivity({
          agent_id: 'orchestrator',
          event_type: 'session_end',
          details: 'Session gone — DB status corrected from stale state by idle monitor',
        });
      }
    } catch {
      // Non-fatal — the respawn below will handle registration
    }

    // Check for pending tasks that need a fresh orchestrator
    const pendingForRespawn = query<{ count: number; id: string; title: string; description: string }>(
      `SELECT COUNT(*) as count, MIN(id) as id, MIN(title) as title, MIN(description) as description
       FROM orchestrator_tasks WHERE status = 'pending'`,
    );
    const pendingCount = pendingForRespawn[0]?.count ?? 0;
    if (pendingCount > 0) {
      log.info('Orchestrator dead but pending tasks exist — spawning fresh orchestrator', { pendingCount });
      const firstTask = pendingForRespawn[0]!;
      respawnForPendingTasks(firstTask.id, firstTask.title, firstTask.description ?? firstTask.title, pendingCount);
    }

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

    // Even while Claude is active, check for pending tasks that arrived since it
    // started. Claude won't pick these up on its own — inject a soft nudge so it
    // knows to check the queue when its current work is done.
    const pendingWhileActive = query<{ count: number }>(
      `SELECT COUNT(*) as count FROM orchestrator_tasks WHERE status = 'pending'`,
    );
    const pendingWhileActiveCount = pendingWhileActive[0]?.count ?? 0;
    if (pendingWhileActiveCount > 0) {
      log.debug('Pending tasks queued while Claude is active — injecting soft nudge', { pendingWhileActiveCount });
      injectMessage(
        'orchestrator',
        `[System] ${pendingWhileActiveCount} pending task(s) in queue. Check GET /api/orchestrator/tasks?status=pending when your current work is done.`,
      );
    }

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
  spawnOrchestratorSession?: () => string | null;
  cleanupSessionDirs?: (maxAgeDays?: number) => number;
} | null): void {
  if (deps === null) {
    isOrchestratorAlive = _isOrchestratorAlive;
    killOrchestratorSession = _killOrchestratorSession;
    injectMessage = _injectMessage;
    spawnOrchestratorSession = _spawnOrchestratorSession;
    cleanupSessionDirs = _cleanupSessionDirs;
    return;
  }
  if (deps.isOrchestratorAlive) isOrchestratorAlive = deps.isOrchestratorAlive;
  if (deps.killOrchestratorSession) killOrchestratorSession = deps.killOrchestratorSession;
  if (deps.injectMessage) injectMessage = deps.injectMessage;
  if (deps.spawnOrchestratorSession) spawnOrchestratorSession = deps.spawnOrchestratorSession;
  if (deps.cleanupSessionDirs) cleanupSessionDirs = deps.cleanupSessionDirs;
}
