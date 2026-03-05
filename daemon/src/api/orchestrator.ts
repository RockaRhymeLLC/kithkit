/**
 * Orchestrator API — escalate tasks, check status, shutdown.
 *
 * Routes:
 *   POST /api/orchestrator/escalate  — Send a task to the orchestrator (spawns if needed)
 *   GET  /api/orchestrator/status    — Check orchestrator status
 *   POST /api/orchestrator/shutdown  — Gracefully shut down orchestrator
 */

import type http from 'node:http';
import { json, withTimestamp, parseBody } from './helpers.js';
import {
  spawnOrchestratorSession,
  killOrchestratorSession,
  isOrchestratorAlive,
  getOrchestratorState,
  injectMessage,
} from '../agents/tmux.js';
import { sendMessage } from '../agents/message-router.js';
import { loadConfig } from '../core/config.js';
import { randomUUID } from 'node:crypto';
import { exec, query, update } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { logActivity } from './activity.js';

const log = createLogger('orchestrator-api');

function getConfigPort(): number {
  return loadConfig().daemon.port;
}

// Shutdown timeout: if orchestrator doesn't ack within 60s, force kill
const SHUTDOWN_TIMEOUT_MS = 60_000;

// Track the pending shutdown timer so we can cancel it on new spawn
let pendingShutdownTimer: ReturnType<typeof setTimeout> | null = null;

// ── Route handler ────────────────────────────────────────────

export async function handleOrchestratorRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /api/orchestrator/escalate — send task, spawn if needed
  if (pathname === '/api/orchestrator/escalate' && method === 'POST') {
    const body = await parseBody(req);

    if (!body.task || typeof body.task !== 'string') {
      json(res, 400, withTimestamp({ error: 'task is required' }));
      return true;
    }

    const task = body.task as string;
    const context = typeof body.context === 'string' ? body.context : undefined;

    // Use getOrchestratorState() as the authoritative check — it verifies the tmux session
    // AND whether Claude is running inside it. If it returns 'dead', the session is truly gone
    // even if a prior isOrchestratorAlive() check cached a stale 'true'.
    const orchStateCheck = getOrchestratorState();
    const alive = orchStateCheck !== 'dead';

    // Create an orchestrator_tasks row for tracking
    const taskId = randomUUID();
    const ts = new Date().toISOString();
    const priority = typeof body.priority === 'number' ? body.priority : 0;
    const workNotes = typeof body.work_notes === 'string' ? body.work_notes : null;
    exec(
      `INSERT INTO orchestrator_tasks (id, title, description, status, priority, work_notes, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', ?, ?, ?, ?)`,
      taskId,
      task.slice(0, 200),
      context ?? task,
      priority,
      workNotes,
      ts,
      ts,
    );
    log.info('Created orchestrator task', { taskId, title: task.slice(0, 100) });

    if (!alive) {
      // Cancel any pending shutdown timer — a new spawn supersedes a pending shutdown
      if (pendingShutdownTimer) {
        clearTimeout(pendingShutdownTimer);
        pendingShutdownTimer = null;
        log.info('Cancelled pending shutdown timer — new task spawning orchestrator');
      }

      const session = spawnOrchestratorSession();

      if (!session) {
        // Mark task as failed since we couldn't spawn
        exec(
          `UPDATE orchestrator_tasks SET status = 'failed', error = 'Failed to spawn orchestrator session', updated_at = ? WHERE id = ?`,
          new Date().toISOString(), taskId,
        );
        json(res, 500, withTimestamp({ error: 'Failed to spawn orchestrator session' }));
        return true;
      }

      // Register in agents table
      try {
        exec(
          `INSERT INTO agents (id, type, profile, status, tmux_session, started_at, created_at, updated_at)
           VALUES ('orchestrator', 'orchestrator', 'orchestrator', 'running', ?, ?, ?, ?)`,
          session, ts, ts, ts,
        );
      } catch {
        // May already exist from previous run — update instead
        update('agents', 'orchestrator', {
          status: 'running',
          tmux_session: session,
          started_at: ts,
          updated_at: ts,
        });
      }

      // Log activity: session_start
      logActivity({
        agent_id: 'orchestrator',
        session_id: session,
        event_type: 'session_start',
        details: `Spawned for task: ${task.slice(0, 200)}`,
      });

      // Log the escalation as a message
      sendMessage({
        from: 'comms',
        to: 'orchestrator',
        type: 'task',
        body: JSON.stringify({ task, context, task_id: taskId }),
      });

      log.info('Orchestrator spawned for task', { task: task.slice(0, 100), taskId });
      json(res, 202, withTimestamp({
        status: 'spawned',
        session,
        task_id: taskId,
        message: 'Orchestrator session created with task',
      }));
      return true;
    }

    // Cancel any pending shutdown timer — new work supersedes shutdown
    if (pendingShutdownTimer) {
      clearTimeout(pendingShutdownTimer);
      pendingShutdownTimer = null;
      log.info('Cancelled pending shutdown timer — new task for running orchestrator');
    }

    const orchState = orchStateCheck; // already computed above

    // Store the task message for the orchestrator to discover via the task queue
    sendMessage({
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: JSON.stringify({ task, context, task_id: taskId }),
      // When Claude is actively running, use direct=false so the message is
      // queued rather than injected into tmux mid-processing
      direct: false,
    });

    // Update activity so idle checker knows we just got work
    update('agents', 'orchestrator', {
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (orchState === 'active') {
      log.info('Task queued for running orchestrator (Claude active, will pick up from queue)', { task: task.slice(0, 100), taskId });
      json(res, 200, withTimestamp({
        status: 'queued',
        task_id: taskId,
        message: 'Task queued — orchestrator is busy, will pick it up from the task queue',
      }));
    } else {
      // Orchestrator is waiting (idle at prompt) — inject a nudge so it checks the queue
      injectMessage('orchestrator', `[System] New task queued (${taskId.slice(0, 8)}). Check pending tasks: curl -s 'http://localhost:${getConfigPort()}/api/orchestrator/tasks?status=pending'`);
      log.info('Task escalated to waiting orchestrator with tmux nudge', { task: task.slice(0, 100), taskId });
      json(res, 200, withTimestamp({
        status: 'escalated',
        task_id: taskId,
        message: 'Task sent to waiting orchestrator with tmux nudge',
      }));
    }
    return true;
  }

  // GET /api/orchestrator/status
  if (pathname === '/api/orchestrator/status' && method === 'GET') {
    const alive = isOrchestratorAlive();
    const state = getOrchestratorState(); // 'active' | 'waiting' | 'dead'
    const ts = new Date().toISOString();

    // Reconcile: if the session is alive but the DB record says 'crashed' or
    // 'stopped', fix it before returning. This window opens after a daemon
    // restart — cleanupOrphanedAgents() marks the row 'crashed', and if a
    // new escalation hasn't fired yet the status endpoint would return a
    // misleading 'crashed' state even though a session is running.
    if (state !== 'dead') {
      const staleStatuses = ['crashed', 'stopped'];
      const current = query<{ status: string }>(
        "SELECT status FROM agents WHERE id = 'orchestrator'",
      );
      if (current[0] && staleStatuses.includes(current[0].status)) {
        update('agents', 'orchestrator', { status: 'running', updated_at: ts });
        log.info('Reconciled stale orchestrator agent status', {
          was: current[0].status, now: 'running',
        });
      }
    }

    const agentRows = query<{ status: string; started_at: string | null; last_activity: string | null }>(
      "SELECT status, started_at, last_activity FROM agents WHERE id = 'orchestrator'",
    );
    const agent = agentRows[0];

    // Count active worker jobs
    const jobRows = query<{ count: number }>(
      "SELECT COUNT(*) as count FROM worker_jobs WHERE status IN ('queued', 'running')",
    );
    const activeJobs = jobRows[0]?.count ?? 0;

    json(res, 200, withTimestamp({
      alive,
      state,   // fine-grained: 'active' (running claude), 'waiting' (idle loop), 'dead'
      status: agent?.status ?? 'not_registered',
      started_at: agent?.started_at ?? null,
      last_activity: agent?.last_activity ?? null,
      active_jobs: activeJobs,
    }));
    return true;
  }

  // POST /api/orchestrator/shutdown — graceful shutdown
  if (pathname === '/api/orchestrator/shutdown' && method === 'POST') {
    if (!isOrchestratorAlive()) {
      json(res, 200, withTimestamp({ status: 'already_stopped' }));
      return true;
    }

    const body = await parseBody(req).catch(() => ({} as Record<string, unknown>));
    const force = (body as Record<string, unknown>).force === true;
    const orchState = getOrchestratorState();

    // If Claude is actively running and this isn't a force shutdown,
    // wait for the current task to complete before initiating shutdown.
    // Use an extended timeout (3 min) to give the task time to finish.
    const activeTimeout = 3 * 60_000; // 3 minutes for active tasks
    const effectiveTimeout = (!force && orchState === 'active') ? activeTimeout : SHUTDOWN_TIMEOUT_MS;

    // Send shutdown message
    sendMessage({
      from: 'daemon',
      to: 'orchestrator',
      type: 'status',
      body: JSON.stringify({
        action: 'shutdown',
        reason: (body as Record<string, unknown>).reason ?? 'requested',
        wait_for_completion: orchState === 'active',
      }),
    });

    // Set a timeout to force-kill if no acknowledgment (cancellable on new spawn)
    pendingShutdownTimer = setTimeout(() => {
      pendingShutdownTimer = null;
      if (isOrchestratorAlive()) {
        log.warn('Orchestrator did not shut down within timeout — force killing', {
          timeout_ms: effectiveTimeout,
          was_active: orchState === 'active',
        });
        killOrchestratorSession();
        update('agents', 'orchestrator', {
          status: 'stopped',
          updated_at: new Date().toISOString(),
        });
        logActivity({
          agent_id: 'orchestrator',
          event_type: 'session_end',
          details: `Force-killed after ${effectiveTimeout / 1000}s shutdown timeout (was ${orchState})`,
        });
      }
    }, effectiveTimeout);

    log.info('Shutdown requested', { orchState, force, timeout_ms: effectiveTimeout });
    json(res, 200, withTimestamp({
      status: 'shutdown_requested',
      timeout_ms: effectiveTimeout,
      was_active: orchState === 'active',
    }));
    return true;
  }

  return false;
}

