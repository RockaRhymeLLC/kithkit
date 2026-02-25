/**
 * Context Watchdog — monitors context usage with escalating actions.
 *
 * Monitors BOTH comms and orchestrator sessions independently.
 *
 * Comms tiers:
 * - 50% used → gentle heads-up ("start wrapping up")
 * - 65% used → auto /restart (which saves state first, then restarts)
 *
 * Orchestrator tiers:
 * - 60% used → heads-up ("save state soon") + notify comms
 * - 70% used → save state and exit ("write orchestrator-state.md and exit") + notify comms
 *
 * The orchestrator gets earlier warnings because:
 * - It has no /restart skill — it must self-manage via state save + exit
 * - The daemon's backstop (orchestrator-idle at 65%) is the hard kill
 * - Graceful save at 70% gives headroom before the 65% backstop
 *
 * Each tier fires once per session (tracked by session_id).
 *
 * The watchdog reads context-usage.json (comms) and context-usage-orch.json
 * (orchestrator), both written by the statusline script on every turn.
 */

import fs from 'node:fs';
import { resolveProjectPath } from '../../core/config.js';
import { injectText } from '../../core/session-bridge.js';
import { injectMessage, isOrchestratorAlive } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('context-watchdog');

// Generous staleness window — the real protection is session_id tracking.
// Only skip if the file is over 1 hour old (session likely dead/restarted).
const STALE_SECONDS = 3600;

interface Tier {
  threshold: number;
  message: (used: number, remaining: number) => string;
}

// ── Comms tiers ──────────────────────────────────────────────

const COMMS_TIERS: Tier[] = [
  {
    threshold: 50,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Start wrapping up your current task.`,
  },
  {
    threshold: 65,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Run /restart now.`,
  },
];

// ── Orchestrator tiers ───────────────────────────────────────

const ORCH_TIERS: Tier[] = [
  {
    threshold: 60,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Start wrapping up — save orchestrator-state.md soon.`,
  },
  {
    threshold: 70,
    message: (used, remaining) =>
      `[System] Context at ${used}% used (${remaining}% remaining). Save state NOW: write .claude/state/orchestrator-state.md with your task, completed steps, in-progress work, next steps, files modified, and key context. Then send a progress summary to comms and exit cleanly.`,
  },
];

// Track which tiers have fired for each session (comms and orchestrator independently)
let commsFiredTiers: Set<number> = new Set();
let commsSessionId: string | null = null;

let orchFiredTiers: Set<number> = new Set();
let orchSessionId: string | null = null;

interface ContextData {
  remaining_percentage?: number;
  used_percentage?: number;
  session_id?: string;
}

/**
 * Read and validate a context usage file. Returns null if missing, stale, or invalid.
 */
function readContextFile(filePath: string): ContextData | null {
  if (!fs.existsSync(filePath)) return null;

  const stats = fs.statSync(filePath);
  const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
  if (ageSeconds > STALE_SECONDS) {
    log.debug('Context usage file stale', { file: filePath, ageMinutes: Math.round(ageSeconds / 60) });
    return null;
  }

  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    log.warn('Failed to parse context usage file', { file: filePath, error: String(err) });
    return null;
  }
}

/**
 * Monitor comms agent context usage.
 */
function monitorComms(): void {
  const stateFile = resolveProjectPath('.claude', 'state', 'context-usage.json');
  const data = readContextFile(stateFile);
  if (!data) return;

  const remaining = data.remaining_percentage ?? 100;
  const used = data.used_percentage ?? 0;
  const sessionId = data.session_id ?? 'unknown';

  // New session — reset tracking
  if (sessionId !== commsSessionId) {
    if (commsSessionId !== null) {
      log.info('New comms session detected — resetting tier tracking', { oldSession: commsSessionId, newSession: sessionId });
    }
    commsFiredTiers = new Set();
    commsSessionId = sessionId;
  }

  // Process tiers
  for (const tier of COMMS_TIERS) {
    if (used >= tier.threshold && !commsFiredTiers.has(tier.threshold)) {
      log.info(`Comms context ${used}% used — firing tier ${tier.threshold}%`);
      const injected = injectText(tier.message(used, remaining));
      if (injected) {
        commsFiredTiers.add(tier.threshold);
      } else {
        log.warn(`Failed to inject comms tier ${tier.threshold}% message — will retry next tick`);
      }
    }
  }
}

/**
 * Monitor orchestrator context usage.
 * Only runs when the orchestrator is alive. Uses injectMessage() to send
 * warnings to the orchestrator's tmux session (not the comms session).
 */
function monitorOrchestrator(): void {
  if (!isOrchestratorAlive()) {
    // Reset tracking when orchestrator dies — next spawn is a new session
    if (orchSessionId !== null) {
      orchFiredTiers = new Set();
      orchSessionId = null;
    }
    return;
  }

  const stateFile = resolveProjectPath('.claude', 'state', 'context-usage-orch.json');
  const data = readContextFile(stateFile);
  if (!data) return;

  const remaining = data.remaining_percentage ?? 100;
  const used = data.used_percentage ?? 0;
  const sessionId = data.session_id ?? 'unknown';

  // New session — reset tracking
  if (sessionId !== orchSessionId) {
    if (orchSessionId !== null) {
      log.info('New orchestrator session detected — resetting tier tracking', { oldSession: orchSessionId, newSession: sessionId });
    }
    orchFiredTiers = new Set();
    orchSessionId = sessionId;
  }

  // Process tiers — inject into orchestrator session AND notify comms
  for (const tier of ORCH_TIERS) {
    if (used >= tier.threshold && !orchFiredTiers.has(tier.threshold)) {
      log.info(`Orchestrator context ${used}% used — firing tier ${tier.threshold}%`);
      const injected = injectMessage('orchestrator', tier.message(used, remaining));
      if (injected) {
        orchFiredTiers.add(tier.threshold);
        // Also notify comms so it has visibility into orchestrator context usage
        const commsNote =
          tier.threshold >= 70
            ? `[orch context: ${used}% — finishing up and exiting]`
            : `[orch context: ${used}% — heads up]`;
        injectText(commsNote);
      } else {
        log.warn(`Failed to inject orchestrator tier ${tier.threshold}% message — will retry next tick`);
      }
    }
  }
}

async function run(): Promise<void> {
  monitorComms();
  monitorOrchestrator();
}

/**
 * Register the context-watchdog task with the scheduler.
 * Task config should include `requires_session: true` in kithkit.config.yaml.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('context-watchdog', async () => {
    await run();
  });
}
