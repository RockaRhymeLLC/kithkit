/**
 * Comms Heartbeat — nudges the comms agent when workers finish.
 *
 * Every 60 seconds:
 * 1. Check for completed or failed worker agents not yet acknowledged.
 * 2. If any found, inject a brief nudge into the comms tmux session:
 *    "[heartbeat] 2 workers finished — check in"
 * 3. Mark notified workers as acknowledged so they don't re-trigger.
 * 4. If nothing pending, do nothing (stays silent).
 *
 * Unread message nudging has been removed — message-delivery handles
 * deliver-once notifications directly.
 */

import { query, exec } from '../../core/db.js';
import { injectMessage, listSessions, _getCommsSession } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('comms-heartbeat');


interface AgentRow {
  id: string;
  status: string;
  acknowledged_at: string | null;
}


/**
 * Check whether the comms session (comms1) is alive.
 * Checks specifically for the comms session name — not just any tmux session —
 * so a running orchestrator (orch1) doesn't produce a false positive.
 */
function isCommsAlive(): boolean {
  return listSessions().includes(_getCommsSession());
}

/**
 * Fetch unacknowledged completed/failed worker agents.
 */
function getPendingWorkers(): AgentRow[] {
  return query<AgentRow>(
    `SELECT id, status, acknowledged_at FROM agents
     WHERE type = 'worker'
       AND status IN ('completed', 'failed')
       AND acknowledged_at IS NULL`,
  );
}

/**
 * Mark a list of worker agent rows as acknowledged.
 */
function acknowledgeWorkers(ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  for (const id of ids) {
    exec(
      'UPDATE agents SET acknowledged_at = ? WHERE id = ?',
      now,
      id,
    );
  }
}

/**
 * Build the nudge text from pending worker count.
 */
function buildNudge(workerCount: number): string {
  return `[heartbeat] ${workerCount} worker${workerCount === 1 ? '' : 's'} finished — check in`;
}

/**
 * Main heartbeat logic: check for pending work and nudge comms if needed.
 */
async function run(): Promise<void> {
  if (!isCommsAlive()) {
    log.debug('Comms session not alive — skipping heartbeat');
    return;
  }

  const pendingWorkers = getPendingWorkers();

  if (pendingWorkers.length === 0) {
    log.debug('Nothing pending — heartbeat silent');
    return;
  }

  const nudge = buildNudge(pendingWorkers.length);
  const injected = injectMessage('comms', nudge);

  if (injected) {
    // Acknowledge the workers we just notified about
    const ids = pendingWorkers.map(w => w.id);
    acknowledgeWorkers(ids);
    log.info('Heartbeat nudge sent', { workers: pendingWorkers.length });
  } else {
    log.warn('Heartbeat nudge injection failed — will retry next tick');
  }
}

/**
 * Register the comms-heartbeat task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('comms-heartbeat', async () => {
    await run();
  });
}
