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
  spawnOrchestratorSession as _spawnOrchestratorSession,
  killOrchestratorSession as _killOrchestratorSession,
  isOrchestratorAlive as _isOrchestratorAlive,
  getOrchestratorState as _getOrchestratorState,
  injectMessage as _injectMessage,
} from '../agents/tmux.js';
import { sendMessage as _sendMessageImpl } from '../agents/message-router.js';
import { legacyIntToPriorityText } from './task-queue.js';
import { loadConfig, resolveProjectPath } from '../core/config.js';
import { randomUUID } from 'node:crypto';
import { exec, query, update } from '../core/db.js';
import { createLogger } from '../core/logger.js';
import { logActivity } from './activity.js';
import { createRateLimiter } from './rate-limit.js';
import { cancelSessionTimers } from './timer.js';
import { isVectorSearchEnabled } from './memory.js';
import { hybridSearch } from '../memory/vector-search.js';

const log = createLogger('orchestrator-api');

// ── Injectable deps (overridable for testing) ─────────────────

let getOrchestratorState = _getOrchestratorState;
let spawnOrchestratorSession = _spawnOrchestratorSession;
let killOrchestratorSession = _killOrchestratorSession;
let sendMessage = _sendMessageImpl;
let injectMessage = _injectMessage;
let isOrchestratorAlive = _isOrchestratorAlive;

// ── Session identity helper (fix(3)) ─────────────────────────
//
// The /shutdown handler arms a force-kill setTimeout. If the wedged session is
// hard-killed externally and the daemon auto-respawns a fresh orch, a stale
// timer from the OLD session must NOT kill the innocent new session.
//
// Guard: capture agents.started_at at timer-arm time; re-check at fire time.
// If they differ (the session was replaced/respawned), skip the kill.

/**
 * Read the orchestrator's started_at from the agents table.
 * Used by the stale-shutdown-timer guard (fix(3)) to identify sessions.
 */
function _getOrchStartedAtImpl(): string | null {
  const rows = query<{ started_at: string | null }>(
    "SELECT started_at FROM agents WHERE id = 'orchestrator'",
  );
  return rows[0]?.started_at ?? null;
}

let getOrchStartedAt: () => string | null = _getOrchStartedAtImpl;

/** @internal Override injectable deps for testing. Pass null to restore originals. */
export function _setDepsForTesting(deps: {
  getOrchestratorState?: () => 'active' | 'waiting' | 'dead';
  spawnOrchestratorSession?: () => string | null;
  sendMessage?: typeof _sendMessageImpl;
  injectMessage?: (target: string, text: string) => boolean;
  /** Override isOrchestratorAlive for handler-level tests (shutdown guard, status). */
  isOrchestratorAlive?: () => boolean;
  /** Override killOrchestratorSession to capture calls in tests. */
  killOrchestratorSession?: () => boolean;
  /** Override started_at lookup for fix(3) timer-guard tests. */
  getOrchStartedAt?: () => string | null;
} | null): void {
  if (deps === null) {
    getOrchestratorState = _getOrchestratorState;
    spawnOrchestratorSession = _spawnOrchestratorSession;
    killOrchestratorSession = _killOrchestratorSession;
    sendMessage = _sendMessageImpl;
    injectMessage = _injectMessage;
    isOrchestratorAlive = _isOrchestratorAlive;
    getOrchStartedAt = _getOrchStartedAtImpl;
    return;
  }
  if (deps.getOrchestratorState) getOrchestratorState = deps.getOrchestratorState;
  if (deps.spawnOrchestratorSession) spawnOrchestratorSession = deps.spawnOrchestratorSession;
  if (deps.killOrchestratorSession) killOrchestratorSession = deps.killOrchestratorSession;
  if (deps.sendMessage) sendMessage = deps.sendMessage;
  if (deps.injectMessage) injectMessage = deps.injectMessage;
  if (deps.isOrchestratorAlive) isOrchestratorAlive = deps.isOrchestratorAlive;
  if (deps.getOrchStartedAt) getOrchStartedAt = deps.getOrchStartedAt;
}

function getConfigPort(): number {
  return loadConfig().daemon.port;
}

// Shutdown timeout: if orchestrator doesn't ack within 60s, force kill
const SHUTDOWN_TIMEOUT_MS = 60_000;

// ── Test-only timeout override ────────────────────────────────
// Allows unit tests to use a short timer (e.g. 50ms) so the force-kill path
// fires quickly without real 60s waits. Production code never sets this.
let _shutdownTimeoutOverrideMs: number | null = null;

/** @internal Set a short timeout for shutdown timer tests. Pass null to restore production behavior. */
export function _setShutdownTimeoutForTesting(ms: number | null): void {
  _shutdownTimeoutOverrideMs = ms;
}

// Track the pending shutdown timer so we can cancel it on new spawn
let pendingShutdownTimer: ReturnType<typeof setTimeout> | null = null;

const escalateLimiter = createRateLimiter('escalate', 20);

/**
 * Build task title and description from escalate fields, preserving all content.
 *
 * - titleText: first non-empty line of task, trimmed and capped at 200 chars
 * - descriptionText: full task body, with context appended as a delimited section if provided
 */
export function buildTaskFields(
  task: string,
  context?: string,
): { titleText: string; descriptionText: string } {
  const firstLine = task.split('\n').find(l => l.trim().length > 0) ?? '';
  const titleText = firstLine.trim().slice(0, 200) || task.slice(0, 200);
  const descriptionText = context
    ? `${task}\n\n---\n\n## Context\n${context}`
    : task;
  return { titleText, descriptionText };
}

// ── Route handler ────────────────────────────────────────────

export async function handleOrchestratorRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): Promise<boolean> {
  const method = req.method ?? 'GET';

  // POST /api/orchestrator/escalate — send task, spawn if needed
  if (pathname === '/api/orchestrator/escalate' && method === 'POST') {
    if (!escalateLimiter(req, res)) return true;

    const body = await parseBody(req);

    if (!body.task || typeof body.task !== 'string') {
      json(res, 400, withTimestamp({ error: 'task is required' }));
      return true;
    }

    const task = body.task as string;
    const context = typeof body.context === 'string' ? body.context : undefined;

    // Validate and sanitize requesting_peer: lowercase alphanumeric/dash/underscore, 1..64 chars.
    let requestingPeer: string | null = null;
    if (typeof body.requesting_peer === 'string') {
      const trimmed = body.requesting_peer.trim().toLowerCase();
      if (trimmed.length >= 1 && trimmed.length <= 64 && /^[a-z0-9_-]+$/.test(trimmed)) {
        requestingPeer = trimmed;
      }
    }

    // Use getOrchestratorState() as the authoritative check — it verifies the tmux session
    // AND whether Claude is running inside it. If it returns 'dead', the session is truly gone
    // even if a prior isOrchestratorAlive() check cached a stale 'true'.
    const orchStateCheck = getOrchestratorState();
    const alive = orchStateCheck !== 'dead';

    // Create a tasks row for tracking
    const taskId = randomUUID();
    const ts = new Date().toISOString();
    const priority = typeof body.priority === 'number' ? body.priority : 0;
    const workNotes = typeof body.work_notes === 'string' ? body.work_notes : null;
    const { titleText, descriptionText } = buildTaskFields(task, context);
    const source = requestingPeer ? 'peer' : 'human';
    exec(
      `INSERT INTO tasks (external_id, kind, title, description, status, priority, source, work_notes, requesting_peer, created_at, updated_at)
       VALUES (?, 'orchestrator', ?, ?, 'pending', ?, ?, ?, ?, ?, ?)`,
      taskId,
      titleText,
      descriptionText,
      legacyIntToPriorityText(priority),
      source,
      workNotes,
      requestingPeer,
      ts,
      ts,
    );
    log.info('Created orchestrator task', { taskId, title: titleText });

    if (!alive) {
      // Cancel any pending shutdown timer — a new spawn supersedes a pending shutdown
      if (pendingShutdownTimer) {
        clearTimeout(pendingShutdownTimer);
        pendingShutdownTimer = null;
        log.info('Cancelled pending shutdown timer — new task spawning orchestrator');
      }

      // Bounded retry: transient tmux-socket / name-collision failures should not
      // permanently fail a fresh task.  Try up to 3 times with 500ms back-off.
      const SPAWN_MAX_ATTEMPTS = 3;
      const SPAWN_RETRY_DELAY_MS = 500;
      let session: string | null = null;
      for (let attempt = 1; attempt <= SPAWN_MAX_ATTEMPTS; attempt++) {
        session = spawnOrchestratorSession();
        if (session) break;
        if (attempt < SPAWN_MAX_ATTEMPTS) {
          log.warn('Orchestrator spawn attempt failed — retrying', { attempt, taskId });
          await new Promise<void>(resolve => setTimeout(resolve, SPAWN_RETRY_DELAY_MS));
        }
      }

      if (!session) {
        // All attempts exhausted — mark task as failed
        exec(
          `UPDATE tasks SET status = 'failed', error = 'Failed to spawn orchestrator session', updated_at = ? WHERE external_id = ? AND kind = 'orchestrator'`,
          new Date().toISOString(), taskId,
        );
        log.error('Orchestrator spawn failed after all attempts', { attempts: SPAWN_MAX_ATTEMPTS, taskId });
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

      // Log the escalation as a message.
      // direct: true adds a tmux-inject attempt as a SECOND delivery path alongside
      // the 5s-delayed startup nudge already fired by spawnOrchestratorSession().
      // With COMMIT 1's readiness-gate, injectMessage() waits for the `> ` prompt
      // before sending; if Claude isn't ready within the gate window, the inject
      // returns false and the message-router falls through to notifyNewMessage(),
      // which triggers the scheduler to retry delivery once the session is live.
      sendMessage({
        from: 'comms',
        to: 'orchestrator',
        type: 'task',
        body: JSON.stringify({ task, context, task_id: taskId }),
        direct: true,
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
      const nudged = injectMessage('orchestrator', `[System] New task queued (${taskId.slice(0, 8)}). Check pending tasks: curl -s 'http://localhost:${getConfigPort()}/api/orchestrator/tasks?status=pending'`);
      if (!nudged) {
        // Inject failed — session may have died between state-check and nudge.
        // The task is pending in the DB; the orchestrator-idle monitor will wake
        // or respawn the orchestrator on its next tick (via Check 3 / respawn path).
        log.warn('New-task nudge inject failed — task is pending in queue, idle monitor will recover', { taskId });
      }
      log.info('Task escalated to waiting orchestrator with tmux nudge', { task: task.slice(0, 100), taskId, nudged });
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

    // Reconcile DB status against live tmux state.
    const current = query<{ status: string }>(
      "SELECT status FROM agents WHERE id = 'orchestrator'",
    );
    if (state !== 'dead') {
      // Session is alive — if DB says crashed/stopped, correct it (resurrection).
      // This window opens after a daemon restart: cleanupOrphanedAgents() marks the
      // row 'crashed', but a tmux session that survived the restart is still running.
      const staleStatuses = ['crashed', 'stopped'];
      if (current[0] && staleStatuses.includes(current[0].status)) {
        update('agents', 'orchestrator', { status: 'running', updated_at: ts });
        log.info('Reconciled stale orchestrator agent status — session survived, DB corrected', {
          was: current[0].status, now: 'running',
        });
      }
    } else {
      // Session is confirmed dead — if DB still shows an active status, log it.
      // The idle monitor will correct the DB on its next tick; we log here so the
      // gap is visible in the status endpoint response before that happens.
      const activeStatuses = ['running', 'busy', 'idle'];
      if (current[0] && activeStatuses.includes(current[0].status)) {
        log.warn('Orchestrator session confirmed dead — DB status not yet corrected by idle monitor', {
          dbStatus: current[0].status,
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
    const effectiveTimeout = _shutdownTimeoutOverrideMs
      ?? ((!force && orchState === 'active') ? activeTimeout : SHUTDOWN_TIMEOUT_MS);

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

    // Fix 3: cancel all orchestrator timers immediately on shutdown request
    const cancelledTimers = cancelSessionTimers('orchestrator');
    if (cancelledTimers > 0) {
      log.info('Cancelled orchestrator timers on shutdown', { count: cancelledTimers });
    }

    // Fix(3): capture session identity NOW (at arm time) so the timer can verify
    // it is killing the same instance it was armed for. If the session is replaced
    // (e.g. wedge-restart by fix(2)) before the timer fires, started_at changes and
    // the timer correctly skips the kill — sparing the innocent fresh session.
    const armedStartedAt = getOrchStartedAt();

    // Set a timeout to force-kill if no acknowledgment (cancellable on new spawn)
    pendingShutdownTimer = setTimeout(() => {
      pendingShutdownTimer = null;
      if (isOrchestratorAlive()) {
        // Fix(3): identity guard — only kill if this is the SAME session instance.
        const currentStartedAt = getOrchStartedAt();
        if (currentStartedAt !== armedStartedAt) {
          log.info('Shutdown force-kill timer fired but orchestrator session was replaced — skipping kill', {
            armedStartedAt,
            currentStartedAt,
          });
          return;
        }

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
        // Cancel any timers that fired during the shutdown window
        cancelSessionTimers('orchestrator');
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

async function buildOrchestratorPrompt(task: string, context?: string, sessionDir?: string): Promise<string> {
  // Derive the comms agent's launchd label from config so the framework
  // doesn't hard-code an instance-specific identifier. Falls back to
  // 'comms' if agent.name is unset.
  const commsLabel = `com.assistant.${(loadConfig().agent.name || 'comms').toLowerCase()}`;

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
    '## Worker Delegation (IMPORTANT)',
    'You are an ORCHESTRATOR, not a worker. Your primary job is to decompose tasks and delegate to workers.',
    '- For multi-step tasks, identify which steps can run in parallel and spawn workers for them',
    '- Use workers (POST /api/agents/spawn) for: code changes, research, testing, file exploration',
    '- Do coordination work yourself: task decomposition, result synthesis, dependency ordering, reporting to comms',
    '- Only do implementation work directly when it is a single small task where spawning a worker adds overhead without benefit',
    '- Prefer spawning 2-3 workers in parallel over doing 2-3 tasks sequentially yourself',
    '- Available profiles: research (read-only exploration), coding (implementation), testing (test running)',
    '',
    '## Worker Output Review Gate (STANDING RULE)',
    'Before reporting any worker result to comms, INDEPENDENTLY review the worker\'s output. Do NOT relay the worker\'s self-report verbatim — verify each claim against source evidence:',
    '- Code changes: read the actual diff or modified files; confirm the change is present and correct',
    '- Build result: check build output directly; confirm pass/fail, not just the worker\'s assertion',
    '- Tests: check test output directly; confirm pass/fail counts and which tests ran',
    '- PR or issue: confirm the URL exists and its content matches the task',
    '- Any irreversible or outward-facing action: confirm it actually occurred',
    'If the worker\'s output has gaps or errors, iterate with the worker to resolve them before closing.',
    'Post review findings on the task BEFORE reporting to comms:',
    '  1. Activity entry: POST http://localhost:3847/api/orchestrator/tasks/:id/activity with {"event_type":"worker_review","details":"<your findings>"}',
    '  2. Include your review summary in the result field: PUT http://localhost:3847/api/orchestrator/tasks/:id with {"result":"<review summary + worker output>"}',
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
    `- NEVER restart the comms agent (tmux session, ${commsLabel}, or restart flag file)`,
    `- NEVER use launchctl for ${commsLabel} — that kills the human's active session`,
    '- Daemon restart IS allowed when needed: send results to comms first, then:',
    '  curl -s -X POST http://localhost:3847/api/daemon/restart',
    '  (do NOT call launchctl kickstart directly — that kills the requesting worker mid-flight; the API defers the restart until after you receive the 202)',
    '- After the 202 response, verify health with: curl -s http://localhost:3847/health, then exit',
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

  // Load previous orchestrator state if it exists (enables context continuity)
  try {
    const stateFile = resolveProjectPath('.kithkit', 'state', 'orchestrator-state.md');
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
