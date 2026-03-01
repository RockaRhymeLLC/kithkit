/**
 * Orchestrator API — escalate tasks, check status, shutdown.
 *
 * Routes:
 *   POST /api/orchestrator/escalate  — Send a task to the orchestrator (spawns if needed)
 *   GET  /api/orchestrator/status    — Check orchestrator status
 *   POST /api/orchestrator/shutdown  — Gracefully shut down orchestrator
 */

import type http from 'node:http';
import fs from 'node:fs';
import { json, withTimestamp, parseBody } from './helpers.js';
import {
  spawnOrchestratorSession,
  killOrchestratorSession,
  isOrchestratorAlive,
  getOrchestratorState,
} from '../agents/tmux.js';
import { sendMessage } from '../agents/message-router.js';
import { createSessionDir } from '../agents/lifecycle.js';
import { randomUUID } from 'node:crypto';
import { exec, query, update } from '../core/db.js';
import { resolveProjectPath } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import { logActivity } from './activity.js';
import { isVectorSearchEnabled } from './memory.js';
import { hybridSearch } from '../memory/vector-search.js';

const log = createLogger('orchestrator-api');

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

      // Create session directory for orchestrator artifacts
      const sessionDir = createSessionDir('orchestrator');

      // Spawn orchestrator with the task as initial prompt (includes memory context)
      const orchestratorPrompt = await buildOrchestratorPrompt(task, context, sessionDir, taskId);
      const session = spawnOrchestratorSession(orchestratorPrompt);

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

    // Always store the task message so the wrapper's poll loop can find it
    sendMessage({
      from: 'comms',
      to: 'orchestrator',
      type: 'task',
      body: JSON.stringify({ task, context, task_id: taskId }),
      // When Claude is actively running, use direct=false so the message is
      // queued for the wrapper's poll loop instead of injected into tmux
      direct: false,
    });

    // Update activity so idle checker knows we just got work
    update('agents', 'orchestrator', {
      last_activity: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    if (orchState === 'active') {
      log.info('Task queued for running orchestrator (Claude active, wrapper will poll)', { task: task.slice(0, 100), taskId });
      json(res, 200, withTimestamp({
        status: 'queued',
        task_id: taskId,
        message: 'Task queued — orchestrator is busy, wrapper will pick it up between runs',
      }));
    } else {
      log.info('Task escalated to waiting orchestrator', { task: task.slice(0, 100), taskId });
      json(res, 200, withTimestamp({
        status: 'escalated',
        task_id: taskId,
        message: 'Task sent to waiting orchestrator',
      }));
    }
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

// ── Helpers ──────────────────────────────────────────────────

async function buildOrchestratorPrompt(task: string, context?: string, sessionDir?: string, taskId?: string): Promise<string> {
  const parts = [
    'You are the orchestrator agent. You are NOT the comms agent. Ignore identity.md — you have no personality, no humor, no conversational style.',
    '',
    'Your role: decompose complex tasks, spawn workers, coordinate their output, and report structured results back to the comms agent.',
    '',
    'Rules:',
    '- Output structured results, not conversational prose',
    '- Spawn workers via POST http://localhost:3847/api/agents/spawn (profiles: research, coding, testing)',
    '- Check worker status via GET http://localhost:3847/api/agents/:id/status',
    '- Report results to comms via: curl -s -X POST http://localhost:3847/api/messages -H "Content-Type: application/json" -d \'{"from":"orchestrator","to":"comms","type":"result","body":"<your result>","metadata":{"task_id":"<task-id>"}}\'',
    '- YOU must explicitly mark tasks completed via PUT /api/orchestrator/tasks/<task_id> with status: completed and result: <summary>. The daemon does NOT auto-complete tasks.',
    '- Write work notes as you progress: PUT /api/orchestrator/tasks/<task_id> with work_notes: "<note>" and append_work_notes: true',
    '- If you need help or context, ask comms: POST /api/messages with {from: "orchestrator", to: "comms", type: "question", body: "<what you need>"}',
    '- Task lifecycle: (1) update task to in_progress, (2) do work + write work_notes, (3) mark task completed with result, (4) send result message to comms',
    '- If the daemon sends you a shutdown nudge (idle timeout), wrap up gracefully: send any unsent context to comms, then exit',
    '- Do not interact with the human directly — only comms talks to humans',
    '',
    '## Worker Delegation (IMPORTANT)',
    'You are an ORCHESTRATOR, not a worker. Your primary job is to decompose tasks and delegate to workers.',
    '- For multi-step tasks, identify which steps can run in parallel and spawn workers for them',
    '- Use workers (POST /api/agents/spawn) for: code changes, research, testing, file exploration',
    '- Do coordination work yourself: task decomposition, result synthesis, dependency ordering, reporting to comms',
    '- Only do implementation work directly when it is a single small task where spawning a worker adds overhead without benefit',
    '- Prefer spawning 2-3 workers in parallel over doing 2-3 tasks sequentially yourself',
    '- Available profiles: research (read-only exploration), coding (implementation), testing (test running)',
    '',
    'Context management:',
    '- Monitor your context usage. Accuracy degrades above 60%. At 50% used, self-restart:',
    '  1. Finish any in-flight worker coordination',
    '  2. Send pending work state to comms (enough context for your replacement to continue)',
    '  3. Post a restart request: curl -s -X POST http://localhost:3847/api/orchestrator/shutdown -H "Content-Type: application/json"',
    '  4. Exit cleanly. The daemon will respawn a fresh orchestrator if there is pending work.',
    '- The daemon enforces a hard backstop at 65% — if you reach it, the daemon will force a shutdown',
    '',
    'Branch rule (CRITICAL):',
    '- NEVER change git branches. You always run on main. Checking out a feature branch breaks hooks, settings, and startup procedures.',
    '- Only WORKERS may operate on feature branches, and they do so in isolated git worktrees — never by switching the branch in the main repo.',
    '- If a task requires branch work (PRs, cherry-picks, etc.), spawn a worker to do it in a worktree.',
    '',
    'Service restart rules (CRITICAL):',
    '- NEVER restart the comms agent (tmux session or restart flag file)',
    '- NEVER use launchctl for the comms agent plist — that kills the human\'s active session',
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

  if (taskId) {
    parts.push('', `Task ID: ${taskId}`,
      'Update this task\'s status as you work: PUT http://localhost:3847/api/orchestrator/tasks/' + taskId,
      'Write your result to the task row when done (status: completed, result: <summary>).',
    );
  }

  // Inject any other pending tasks so the orchestrator knows its full queue.
  // This is critical for recovery after crash/restart — pending tasks would otherwise
  // silently stall with no orchestrator to process them.
  try {
    interface PendingTask { id: string; title: string; description: string }
    const pendingTasks = query<PendingTask>(
      `SELECT id, title, description FROM orchestrator_tasks
       WHERE status = 'pending' AND id != ?
       ORDER BY created_at ASC LIMIT 10`,
      taskId ?? '',
    );
    if (pendingTasks.length > 0) {
      parts.push('', `## Additional pending tasks in queue (${pendingTasks.length} total):`);
      parts.push('Work through these after completing the primary task above. Update each task\'s status via PUT http://localhost:3847/api/orchestrator/tasks/:id');
      for (const t of pendingTasks) {
        parts.push(`- Task ${t.id}: ${t.title}`);
        if (t.description && t.description !== t.title) {
          parts.push(`  Details: ${t.description.slice(0, 200)}`);
        }
      }
    }
  } catch {
    // Non-fatal — prompt still works without pending task list
  }

  if (sessionDir) {
    parts.push('', `Session directory (for artifacts if needed): ${sessionDir}`);
  }

  if (context) {
    parts.push('', `Context: ${context}`);
  }

  // Load previous orchestrator state if it exists (enables context continuity)
  try {
    const stateFile = resolveProjectPath('.claude', 'state', 'orchestrator-state.md');
    if (fs.existsSync(stateFile)) {
      const stateContent = fs.readFileSync(stateFile, 'utf8').trim();
      if (stateContent) {
        const stats = fs.statSync(stateFile);
        const ageMinutes = Math.round((Date.now() - stats.mtimeMs) / 60000);
        parts.push(
          '',
          `Previous orchestrator state (saved ${ageMinutes} minutes ago):`,
          '---BEGIN PREVIOUS STATE---',
          stateContent,
          '---END PREVIOUS STATE---',
          '',
          'If this state is relevant to your current task, use it to resume where the previous orchestrator left off. If the task is different, ignore the previous state.',
        );
        log.info('Loaded previous orchestrator state', { ageMinutes, length: stateContent.length });
      }
    }
  } catch (err) {
    log.warn('Failed to load orchestrator state file', { error: String(err) });
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
