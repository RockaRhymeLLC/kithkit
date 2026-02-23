/**
 * Message Delivery — daemon-managed delivery queue for inter-agent messages.
 *
 * Replaces fire-and-forget tmux injection with a reliable delivery lifecycle:
 * 1. Messages arrive via POST /api/messages → stored as unread (processed_at IS NULL)
 * 2. This task runs on a short interval, pulls undelivered messages for persistent agents
 * 3. Checks if the target tmux session exists before attempting injection
 * 4. Injects each into the target tmux session with proper Enter submission
 * 5. Marks as delivered (processed_at set) on success
 * 6. Expires messages after MAX_RETRIES failed attempts (prevents infinite retry loops)
 * 7. Goes dormant when inbox is empty — woken by notifyNewMessage()
 *
 * Works for both directions: orchestrator→comms and comms→orchestrator.
 */

import { query, exec } from '../../core/db.js';
import { injectMessage, isOrchestratorAlive, listSessions } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';
import type { Message } from '../../agents/message-router.js';

const log = createLogger('message-delivery');

// ── Config ───────────────────────────────────────────────────

/** Max delivery attempts before marking a message as expired. */
const MAX_RETRIES = 3;

// ── State ────────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;
let _pendingWakeup = false;

/**
 * In-memory retry counter. Keyed by message ID.
 * Resets on daemon restart — acceptable because stale messages
 * from a previous daemon run will get a fresh 3 attempts.
 */
const _retryCounts = new Map<number, number>();

// ── Public API ───────────────────────────────────────────────

/**
 * Notify the delivery task that a new message was queued.
 * Triggers the task immediately rather than waiting for the next interval tick.
 */
export function notifyNewMessage(): void {
  if (_scheduler) {
    _pendingWakeup = true;
    _scheduler.triggerTask('message-delivery').catch(err => {
      log.warn('Failed to trigger message-delivery task', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}

// ── Core delivery logic ──────────────────────────────────────

/**
 * Check which persistent-agent tmux sessions are currently alive.
 * Returns a set of agent IDs (e.g. 'comms', 'orchestrator') with live sessions.
 */
function getLiveSessions(): Set<string> {
  const live = new Set<string>();
  // comms session is the main agent session — check via tmux list
  const sessions = listSessions();
  // We don't know the exact comms session name here, but injectMessage
  // resolves it internally. We check orchestrator explicitly since it's
  // the common source of dead-session retries.
  if (sessions.length > 0) {
    // If any sessions exist, comms is likely alive (it's the persistent one)
    live.add('comms');
  }
  if (isOrchestratorAlive()) {
    live.add('orchestrator');
  }
  return live;
}

/**
 * Mark a message as expired (undeliverable). Sets processed_at with
 * metadata indicating it was not successfully delivered.
 */
function expireMessage(msg: Message, retries: number): void {
  const now = new Date().toISOString();
  const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
  const expiredMeta = JSON.stringify({
    ...existingMeta,
    expired: true,
    reason: 'max_retries_exceeded',
    retries,
    expired_at: now,
  });
  exec(
    'UPDATE messages SET processed_at = ?, metadata = ? WHERE id = ?',
    now,
    expiredMeta,
    msg.id,
  );
  _retryCounts.delete(msg.id);
}

/**
 * Pull all undelivered messages for persistent agents, inject into tmux, mark delivered.
 * Skips agents whose tmux sessions are dead and expires messages after MAX_RETRIES.
 */
async function deliverMessages(): Promise<void> {
  _pendingWakeup = false;

  // Pull undelivered messages for comms and orchestrator
  const undelivered = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NULL
       AND (to_agent = 'comms' OR to_agent = 'orchestrator')
     ORDER BY created_at ASC`,
  );

  if (undelivered.length === 0) {
    log.debug('No undelivered messages');
    return;
  }

  // Check which target sessions are alive before attempting delivery
  const liveSessions = getLiveSessions();

  log.info(`Delivering ${undelivered.length} message(s)`, {
    liveSessions: [...liveSessions],
  });

  let delivered = 0;
  let failed = 0;
  let expired = 0;

  for (const msg of undelivered) {
    const retries = _retryCounts.get(msg.id) ?? 0;

    // If we've already hit max retries, expire immediately
    if (retries >= MAX_RETRIES) {
      expireMessage(msg, retries);
      expired++;
      log.warn('Message expired after max retries', {
        id: msg.id,
        to: msg.to_agent,
        retries,
      });
      continue;
    }

    // Skip delivery if target session is dead — count as a retry attempt
    if (!liveSessions.has(msg.to_agent)) {
      const newCount = retries + 1;
      _retryCounts.set(msg.id, newCount);
      if (newCount >= MAX_RETRIES) {
        expireMessage(msg, newCount);
        expired++;
        log.warn('Message expired — target session does not exist', {
          id: msg.id,
          to: msg.to_agent,
          retries: newCount,
        });
      } else {
        failed++;
        log.debug('Skipping delivery — target session not alive', {
          id: msg.id,
          to: msg.to_agent,
          retry: `${newCount}/${MAX_RETRIES}`,
        });
      }
      continue;
    }

    // Session is alive — attempt injection
    const text = formatForDelivery(msg);
    const success = injectMessage(msg.to_agent, text);

    if (success) {
      exec(
        'UPDATE messages SET processed_at = ? WHERE id = ?',
        new Date().toISOString(),
        msg.id,
      );
      _retryCounts.delete(msg.id);
      delivered++;
      log.debug('Delivered message', {
        id: msg.id,
        from: msg.from_agent,
        to: msg.to_agent,
        type: msg.type,
      });
    } else {
      const newCount = retries + 1;
      _retryCounts.set(msg.id, newCount);
      failed++;
      log.warn('Failed to deliver message', {
        id: msg.id,
        to: msg.to_agent,
        retry: `${newCount}/${MAX_RETRIES}`,
      });
    }

    // Small gap between messages to avoid overwhelming the tmux pane
    if (undelivered.length > 1) {
      await sleep(200);
    }
  }

  log.info(`Delivery complete: ${delivered} delivered, ${failed} failed, ${expired} expired`);
}

// ── Helpers ──────────────────────────────────────────────────

function formatForDelivery(msg: Message): string {
  return `[${msg.type}] from ${msg.from_agent}: ${msg.body}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Registration ─────────────────────────────────────────────

/**
 * Register the message-delivery task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  _scheduler = scheduler;
  scheduler.registerHandler('message-delivery', async () => {
    await deliverMessages();
  });
}

// ── Testing ──────────────────────────────────────────────────

/** @internal Reset retry state for testing */
export function _resetRetriesForTesting(): void {
  _retryCounts.clear();
}

/** @internal Get current retry count for testing */
export function _getRetryCount(messageId: number): number {
  return _retryCounts.get(messageId) ?? 0;
}
