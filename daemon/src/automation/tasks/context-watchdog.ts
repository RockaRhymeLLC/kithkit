/**
 * Context Watchdog — monitors context usage with escalating actions.
 *
 * Two tiers:
 * - 50% used → gentle heads-up ("start wrapping up")
 * - 65% used → auto /restart (which saves state first, then restarts)
 *
 * Each tier fires once per session.
 *
 * The watchdog reads context-usage.json, which is written by the statusline
 * script on every conversation turn. We trust the data as long as the comms
 * tmux session is alive — the session_id check handles stale-session data.
 * A generous staleness window (1 hour) prevents acting on data from a crashed
 * session where the tmux survived but Claude exited.
 */

import fs from 'node:fs';
import { resolveProjectPath } from '../../core/config.js';
import { injectText } from '../../core/session-bridge.js';
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

const TIERS: Tier[] = [
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

// Track which tiers have fired for the current session
let firedTiers: Set<number> = new Set();
let currentSessionId: string | null = null;

async function run(): Promise<void> {
  const stateFile = resolveProjectPath('.claude', 'state', 'context-usage.json');

  if (!fs.existsSync(stateFile)) {
    log.debug('Context usage file not found — skipping');
    return;
  }

  // Check freshness — generous window, session_id is the real guard
  const stats = fs.statSync(stateFile);
  const ageSeconds = (Date.now() - stats.mtimeMs) / 1000;
  if (ageSeconds > STALE_SECONDS) {
    log.debug('Context usage file stale', { ageMinutes: Math.round(ageSeconds / 60) });
    return;
  }

  // Parse context usage
  let data: { remaining_percentage?: number; used_percentage?: number; session_id?: string };
  try {
    data = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch (err) {
    log.warn('Failed to parse context usage file', { error: String(err) });
    return;
  }

  const remaining = data.remaining_percentage ?? 100;
  const used = data.used_percentage ?? 0;
  const sessionId = data.session_id ?? 'unknown';

  // New session — reset tracking
  if (sessionId !== currentSessionId) {
    if (currentSessionId !== null) {
      log.info('New session detected — resetting tier tracking', { oldSession: currentSessionId, newSession: sessionId });
    }
    firedTiers = new Set();
    currentSessionId = sessionId;
  }

  // Process tiers
  for (const tier of TIERS) {
    if (used >= tier.threshold && !firedTiers.has(tier.threshold)) {
      log.info(`Context ${used}% used — firing tier ${tier.threshold}%`);
      const injected = injectText(tier.message(used, remaining));
      if (injected) {
        firedTiers.add(tier.threshold);
      } else {
        log.warn(`Failed to inject tier ${tier.threshold}% message — will retry next tick`);
      }
    }
  }
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
