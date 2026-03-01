/**
 * Comms Heartbeat — nudges the comms agent when there is pending work.
 *
 * Every 60 seconds:
 * 1. Check for completed or failed worker agents not yet acknowledged.
 * 2. Check for undelivered messages addressed to comms (processed_at IS NULL).
 * 3. If EITHER has results, inject a brief nudge into the comms tmux session:
 *    "[heartbeat] 2 workers completed, 1 unread message — check in"
 * 4. Mark notified workers as acknowledged so they don't re-trigger.
 * 5. If nothing pending, do nothing (stays silent).
 */

import { query, exec } from '../../core/db.js';
import { injectMessage, listSessions, _getCommsSession, getOrchestratorState } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('comms-heartbeat');

interface AgentRow {
  id: string;
  status: string;
  acknowledged_at: string | null;
}

interface MessageCount {
  count: number;
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
 * Count undelivered messages addressed to comms.
 * Only counts messages where message-delivery has not yet successfully
 * injected content (processed_at IS NULL) — avoids duplicating delivered messages.
 */
function getUnreadMessageCount(): number {
  const result = query<MessageCount>(
    `SELECT COUNT(*) as count FROM messages
     WHERE to_agent = 'comms'
       AND processed_at IS NULL`,
  );
  return result[0]?.count ?? 0;
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
 * Build the nudge text from pending worker and message counts.
 */
function buildNudge(workerCount: number, unreadCount: number): string {
  const parts: string[] = [];
  if (workerCount > 0) {
    parts.push(`${workerCount} worker${workerCount === 1 ? '' : 's'} finished`);
  }
  if (unreadCount > 0) {
    parts.push(`${unreadCount} unread message${unreadCount === 1 ? '' : 's'}`);
  }
  return `[heartbeat] ${parts.join(', ')} — check in`;
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

  // Only count messages not yet processed by message-delivery (processed_at IS NULL).
  // Delivered messages are already visible in the tmux pane — no heartbeat nudge needed.
  const unreadCount = getUnreadMessageCount();

  if (pendingWorkers.length === 0 && unreadCount === 0) {
    log.debug('Nothing pending — heartbeat silent');
    return;
  }

  const nudge = buildNudge(pendingWorkers.length, unreadCount);
  const injected = injectMessage('comms', nudge);

  if (injected) {
    // Acknowledge the workers we just notified about
    const ids = pendingWorkers.map(w => w.id);
    acknowledgeWorkers(ids);
    log.info('Heartbeat nudge sent', {
      workers: pendingWorkers.length,
      unread: unreadCount,
    });
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
