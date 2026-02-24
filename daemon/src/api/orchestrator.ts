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
} from '../agents/tmux.js';
import { sendMessage } from '../agents/message-router.js';
import { createSessionDir } from '../agents/lifecycle.js';
import { exec, query, update } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { logActivity } from './activity.js';
import { isVectorSearchEnabled } from './memory.js';
import { hybridSearch } from '../memory/vector-search.js';

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
      // Create session directory for orchestrator artifacts
      const sessionDir = createSessionDir('orchestrator');

      // Spawn orchestrator with the task as initial prompt (includes memory context)
      const orchestratorPrompt = await buildOrchestratorPrompt(task, context, sessionDir);
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
    const state = getOrchestratorState(); // 'active' | 'waiting' | 'dead'
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
        logActivity({
          agent_id: 'orchestrator',
          event_type: 'session_end',
          details: 'Force-killed after shutdown timeout (no acknowledgment)',
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

async function buildOrchestratorPrompt(task: string, context?: string, sessionDir?: string): Promise<string> {
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
    '- When a task is complete, send a result message to comms and wait for the next task',
    '- If the daemon sends you a shutdown nudge (idle timeout), wrap up gracefully: send any unsent context to comms, then exit',
    '- Do not interact with the human directly — only comms talks to humans',
    '',
    'Context management:',
    '- Monitor your context usage. Accuracy degrades above 60%. At 50% used, self-restart:',
    '  1. Finish any in-flight worker coordination',
    '  2. Send pending work state to comms (enough context for your replacement to continue)',
    '  3. Post a restart request: curl -s -X POST http://localhost:3847/api/orchestrator/shutdown -H "Content-Type: application/json"',
    '  4. Exit cleanly. The daemon will respawn a fresh orchestrator if there is pending work.',
    '- The daemon enforces a hard backstop at 65% — if you reach it, the daemon will force a shutdown',
    '',
    'Service restart rules (CRITICAL):',
    '- NEVER restart the comms agent (tmux session, com.assistant.bmo, or restart flag file)',
    '- NEVER use launchctl for com.assistant.bmo — that kills the human\'s active session',
    '- Daemon restart IS allowed when needed: send results to comms first, wait 2s, then: launchctl kickstart -k gui/$(id -u)/com.assistant.daemon',
    '- After daemon restart, verify health (curl localhost:3847/health), then exit',
    '',
    'Activity logging: log key milestones by curling POST http://localhost:3847/api/agents/orchestrator/activity with JSON {"event_type":"<type>","details":"<brief>"}. Log task_received when starting, task_completed or error when done, context_checkpoint if context > 70%. Keep it minimal.',
    '',
    'Token efficiency — script batching:',
    '- Every Bash tool call is a round-trip that resends the full conversation as prompt tokens. Minimize round-trips by batching operations into scripts.',
    '- BEFORE making sequential tool calls, ask: "Can I combine these into one Bash call?" If yes, write an inline script.',
    '- Good pattern — one Bash call with a script:',
    '  ```',
    '  # Gather info in one shot instead of 4 separate tool calls',
    '  git log --oneline -5 && echo "---" && git diff --stat && echo "---" && wc -l src/**/*.ts && echo "---" && cat package.json | python3 -c "import sys,json; print(json.load(sys.stdin).get(\'version\'))"',
    '  ```',
    '- For complex multi-step work, write a temp script file, execute it, then delete it:',
    '  ```',
    '  cat > /tmp/task.sh << \'SCRIPT\'',
    '  #!/bin/bash',
    '  set -euo pipefail',
    '  # Step 1: gather',
    '  FILES=$(grep -rl "pattern" src/)',
    '  # Step 2: transform',
    '  for f in $FILES; do sed -i "" "s/old/new/g" "$f"; done',
    '  # Step 3: verify',
    '  grep -r "old" src/ && echo "WARN: leftover matches" || echo "OK: clean"',
    '  SCRIPT',
    '  chmod +x /tmp/task.sh && /tmp/task.sh && rm /tmp/task.sh',
    '  ```',
    '- When spawning workers, prefer giving them tasks that are self-contained and can be completed with minimal back-and-forth.',
    '- Use script batching yourself for daemon API calls: batch multiple curl calls into one Bash invocation.',
    '',
    `Task: ${task}`,
  ];

  if (sessionDir) {
    parts.push('', `Session directory (for artifacts if needed): ${sessionDir}`);
  }

  if (context) {
    parts.push('', `Context: ${context}`);
  }

  // Inject relevant memories from the database
  try {
    if (isVectorSearchEnabled()) {
      // Use task description as search query for relevant context
      const searchQuery = task.slice(0, 300);
      const memories = await hybridSearch(searchQuery, 10);
      if (memories.length > 0) {
        parts.push('', 'Relevant memories from database (for context):');
        for (const m of memories) {
          const content = m.content.replace(/\n/g, ' ').slice(0, 150);
          parts.push(`- [${m.category ?? 'general'}] ${content}`);
        }
      }
    }
  } catch {
    // Memory lookup failure is non-fatal — orchestrator works fine without it
  }

  return parts.join('\n');
}
