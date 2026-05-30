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
 * Shape C (#620): On dead→alive transition (comms session comes back after
 * an absence), immediately trigger notifyNewMessage() to flush any pending
 * relay messages without waiting for the next message-delivery tick.
 * Idempotency is guaranteed by _pendingWakeup in message-delivery.ts.
 *
 * Unread message nudging has been removed — message-delivery handles
 * deliver-once notifications directly.
 */

import { query, exec } from '../../core/db.js';
import { injectMessage, listSessions, _getCommsSession } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import { notifyNewMessage } from './message-delivery.js';
import type { Scheduler } from '../scheduler.js';

const log = createLogger('comms-heartbeat');

// ── State ─────────────────────────────────────────────────────

/**
 * Tracks whether comms was alive on the previous heartbeat tick.
 * Initialised false so the first heartbeat after a daemon start/restart
 * always performs a flush if comms is alive — this covers the
 * restart-recovery case (comms was live before restart, may have pending msgs).
 */
let _prevCommsAlive = false;

// ── Testing overrides ─────────────────────────────────────────

let _isCommsAliveOverride: (() => boolean) | null = null;
let _notifyFnOverride: (() => void) | null = null;

// ── Helpers ───────────────────────────────────────────────────

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
function checkIsCommsAlive(): boolean {
  if (_isCommsAliveOverride) return _isCommsAliveOverride();
  return listSessions().includes(_getCommsSession());
}

/**
 * Trigger a delivery flush. In production: calls notifyNewMessage().
 * In tests: calls the override if set.
 */
function triggerFlush(): void {
  if (_notifyFnOverride) {
    _notifyFnOverride();
  } else {
    notifyNewMessage();
  }
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
  const alive = checkIsCommsAlive();

  // Shape C (#620): dead→alive transition — flush any stranded pending messages.
  // _prevCommsAlive initialises false, so the first tick after a daemon restart
  // also triggers a flush if comms is already alive (restart-recovery).
  // notifyNewMessage() is idempotent via _pendingWakeup in message-delivery.ts.
  if (alive && !_prevCommsAlive) {
    triggerFlush();
    log.info('Comms session recovered — triggered delivery flush');
  }
  _prevCommsAlive = alive;

  if (!alive) {
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

// ── Registration ─────────────────────────────────────────────

/**
 * Register the comms-heartbeat task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  scheduler.registerHandler('comms-heartbeat', async () => {
    await run();
  });
}

// ── Testing ──────────────────────────────────────────────────

/** @internal Run heartbeat logic directly for testing */
export function _runHeartbeatForTesting(): Promise<void> {
  return run();
}

/**
 * @internal Reset heartbeat state for testing.
 * Sets _prevCommsAlive = false, simulating a fresh daemon start or restart.
 * The next _runHeartbeatForTesting() call will fire the dead→alive flush
 * if isCommsAlive() returns true.
 */
export function _resetHeartbeatStateForTesting(): void {
  _prevCommsAlive = false;
}

/**
 * @internal Override the notify/flush function for testing.
 * Pass null to restore the real notifyNewMessage() call.
 */
export function _setNotifyFnForTesting(fn: (() => void) | null): void {
  _notifyFnOverride = fn;
}

/**
 * @internal Override the isCommsAlive check for testing.
 * Pass null to restore the real tmux session check.
 */
export function _setIsCommsAliveForTesting(fn: (() => boolean) | null): void {
  _isCommsAliveOverride = fn;
}
