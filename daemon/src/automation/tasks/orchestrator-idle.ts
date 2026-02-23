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
import { query, update } from '../../core/db.js';
import { resolveProjectPath } from '../../core/config.js';
import {
  isOrchestratorAlive,
  killOrchestratorSession,
  injectMessage,
} from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('orchestrator-idle');

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const CONTEXT_THRESHOLD_PCT = 65; // Daemon backstop — orchestrator self-restarts at 50%
const CONTEXT_STALE_SECONDS = 600; // Ignore context data older than 10 min
const GRACE_PERIOD_MS = 60 * 1000; // 60 seconds to exit after nudge

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
  // Not alive? Nothing to do — reset nudge state
  if (!isOrchestratorAlive()) {
    shutdownNudgedAt = null;
    return;
  }

  const idleTimeoutMs = typeof config.idle_timeout_minutes === 'number'
    ? config.idle_timeout_minutes * 60 * 1000
    : DEFAULT_IDLE_TIMEOUT_MS;

  // If we already nudged, check if grace period has expired
  if (shutdownNudgedAt !== null) {
    const elapsed = Date.now() - shutdownNudgedAt;

    if (!isOrchestratorAlive()) {
      log.info('Orchestrator exited gracefully after shutdown nudge', { reason: shutdownReason });
      shutdownNudgedAt = null;
      shutdownReason = null;
      return;
    }

    if (elapsed >= GRACE_PERIOD_MS) {
      log.warn('Orchestrator did not exit within grace period — force killing', { reason: shutdownReason });
      killOrchestratorSession();
      update('agents', 'orchestrator', {
        status: 'stopped',
        updated_at: new Date().toISOString(),
      });
      shutdownNudgedAt = null;
      shutdownReason = null;
      return;
    }

    // Still within grace period — let it finish
    return;
  }

  // Check if orchestrator has active workers
  const activeJobs = query<{ count: number }>(
    "SELECT COUNT(*) as count FROM worker_jobs WHERE status IN ('queued', 'running')",
  );
  if ((activeJobs[0]?.count ?? 0) > 0) {
    return; // Workers still running — not idle
  }

  // --- Check 1: Context exhaustion (backstop) ---
  // The orchestrator should self-restart at ~60% context. This is the safety net
  // at 80% in case it didn't. We tell it to save state and exit so it can be respawned.
  const contextUsed = getOrchestratorContextUsage();
  if (contextUsed !== null && contextUsed >= CONTEXT_THRESHOLD_PCT) {
    const reason = `context at ${contextUsed}% — save any pending work state to the daemon (POST /api/messages) and exit. The daemon will respawn you with that context.`;
    log.warn('Orchestrator context backstop triggered', { contextUsed });
    const injected = injectMessage('orchestrator', buildShutdownPrompt(reason));
    if (injected) {
      shutdownNudgedAt = Date.now();
      shutdownReason = `context exhaustion (${contextUsed}%)`;
    } else {
      log.warn('Failed to inject context shutdown nudge — killing session');
      killOrchestratorSession();
      update('agents', 'orchestrator', { status: 'stopped', updated_at: new Date().toISOString() });
    }
    return;
  }

  // --- Check 2: Idle timeout ---
  const rows = query<{ last_activity: string | null; started_at: string | null }>(
    "SELECT last_activity, started_at FROM agents WHERE id = 'orchestrator'",
  );
  const agent = rows[0];
  if (!agent) return;

  const lastActive = agent.last_activity ?? agent.started_at;
  if (!lastActive) return;

  const idleMs = Date.now() - new Date(lastActive).getTime();

  if (idleMs < idleTimeoutMs) {
    return; // Not idle long enough
  }

  const reason = `idle for ${Math.round(idleMs / 60000)} minutes with no pending work`;
  log.info('Orchestrator idle — sending shutdown nudge', { idleMinutes: Math.round(idleMs / 60000) });
  const injected = injectMessage('orchestrator', buildShutdownPrompt(reason));

  if (injected) {
    shutdownNudgedAt = Date.now();
  } else {
    // Couldn't inject — session might be gone already
    log.warn('Failed to inject shutdown nudge — killing session');
    killOrchestratorSession();
    update('agents', 'orchestrator', {
      status: 'stopped',
      updated_at: new Date().toISOString(),
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
