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
} from '../agents/tmux.js';
import { sendMessage } from '../agents/message-router.js';
import { exec, query, update } from '../core/db.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('orchestrator-api');

// Shutdown timeout: if orchestrator doesn't ack within 60s, force kill
const SHUTDOWN_TIMEOUT_MS = 60_000;

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
    const alive = isOrchestratorAlive();

    if (!alive) {
      // Spawn orchestrator with the task as initial prompt
      const orchestratorPrompt = buildOrchestratorPrompt(task, context);
      const session = spawnOrchestratorSession(orchestratorPrompt);

      if (!session) {
        json(res, 500, withTimestamp({ error: 'Failed to spawn orchestrator session' }));
        return true;
      }

      // Register in agents table
      const ts = new Date().toISOString();
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

      // Log the escalation as a message
      sendMessage({
        from: 'comms',
        to: 'orchestrator',
        type: 'task',
        body: JSON.stringify({ task, context }),
      });

      log.info('Orchestrator spawned for task', { task: task.slice(0, 100) });
      json(res, 202, withTimestamp({
        status: 'spawned',
        session,
        message: 'Orchestrator session created with task',
      }));
      return true;
    }

    // Already alive — inject task as message
    sendMessage({
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: JSON.stringify({ task, context }),
    });

    log.info('Task escalated to running orchestrator', { task: task.slice(0, 100) });
    json(res, 200, withTimestamp({
      status: 'escalated',
      message: 'Task sent to running orchestrator',
    }));
    return true;
  }

  // GET /api/orchestrator/status
  if (pathname === '/api/orchestrator/status' && method === 'GET') {
    const alive = isOrchestratorAlive();
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

    // Send shutdown message
    sendMessage({
      from: 'daemon',
      to: 'orchestrator',
      type: 'status',
      body: JSON.stringify({ action: 'shutdown', reason: 'requested' }),
    });

    // Set a timeout to force-kill if no acknowledgment
    setTimeout(() => {
      if (isOrchestratorAlive()) {
        log.warn('Orchestrator did not acknowledge shutdown — force killing');
        killOrchestratorSession();
        update('agents', 'orchestrator', {
          status: 'stopped',
          updated_at: new Date().toISOString(),
        });
      }
    }, SHUTDOWN_TIMEOUT_MS);

    json(res, 200, withTimestamp({
      status: 'shutdown_requested',
      timeout_ms: SHUTDOWN_TIMEOUT_MS,
    }));
    return true;
  }

  return false;
}

// ── Helpers ──────────────────────────────────────────────────

function buildOrchestratorPrompt(task: string, context?: string): string {
  const parts = [
    'You are the orchestrator agent. You are NOT the comms agent. Ignore identity.md — you have no personality, no humor, no conversational style.',
    '',
    'Your role: decompose complex tasks, spawn workers, coordinate their output, and report structured results back to the comms agent.',
    '',
    'Rules:',
    '- Output structured results, not conversational prose',
    '- Spawn workers via POST http://localhost:3847/api/agents/spawn (profiles: research, coding, testing)',
    '- Check worker status via GET http://localhost:3847/api/agents/:id/status',
    '- Report results to comms via: curl -s -X POST http://localhost:3847/api/messages -H "Content-Type: application/json" -d \'{"from":"orchestrator","to":"comms","type":"result","body":"<your result>"}\'',
    '- When all work is complete, send a result message to comms and exit',
    '- Do not interact with the human directly — only comms talks to humans',
    '',
    `Task: ${task}`,
  ];

  if (context) {
    parts.push('', `Context: ${context}`);
  }

  return parts.join('\n');
}
