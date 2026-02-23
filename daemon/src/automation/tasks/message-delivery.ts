/**
 * Message Delivery — notification-ping delivery for inter-agent messages.
 *
 * Instead of injecting full message content into tmux, this task:
 * 1. Messages arrive via POST /api/messages → stored as undelivered (processed_at IS NULL)
 * 2. This task runs on a short interval, pulls undelivered messages for persistent agents
 * 3. Injects a SHORT NOTIFICATION PING into the target tmux session:
 *    "[12:05 PM] You have a message from orchestrator — use GET /api/messages?unread=true to read"
 * 4. Marks as delivered (processed_at set) on successful ping injection
 * 5. For unread messages (delivered but read_at IS NULL), re-pings every 60 seconds
 * 6. Expires undelivered messages after MAX_RETRIES failed injection attempts
 *
 * The comms agent pulls full message content via GET /api/messages?unread=true,
 * which also marks messages as read (sets read_at).
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

/** Re-ping interval for unread messages (ms). */
const REPING_INTERVAL_MS = 60_000;

// ── State ────────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;
let _pendingWakeup = false;

/**
 * In-memory retry counter for undelivered messages. Keyed by message ID.
 * Resets on daemon restart — acceptable because stale messages
 * from a previous daemon run will get a fresh 3 attempts.
 */
const _retryCounts = new Map<number, number>();

/**
 * Tracks when we last pinged about an unread message.
 * Prevents spamming tmux faster than REPING_INTERVAL_MS.
 */
const _lastPingTime = new Map<number, number>();

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
  const sessions = listSessions();
  if (sessions.length > 0) {
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
  _lastPingTime.delete(msg.id);
}

/**
 * Format a short notification ping (no message content).
 */
function formatNotificationPing(msg: Message): string {
  const time = new Date().toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const count = getUnreadCountFor(msg.to_agent);
  if (count > 1) {
    return `[${time}] You have ${count} unread messages — use GET /api/messages?unread=true to read`;
  }
  return `[${time}] You have a message from ${msg.from_agent} — use GET /api/messages?unread=true to read`;
}

/**
 * Get count of unread messages for an agent.
 */
function getUnreadCountFor(agentId: string): number {
  const result = query<{ count: number }>(
    `SELECT COUNT(*) as count FROM messages
     WHERE to_agent = ? AND processed_at IS NOT NULL AND read_at IS NULL`,
    agentId,
  );
  return result[0]?.count ?? 0;
}

/**
 * Phase 1: Deliver undelivered messages (inject notification ping, mark processed).
 */
async function deliverNewMessages(liveSessions: Set<string>): Promise<{ delivered: number; failed: number; expired: number }> {
  const undelivered = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NULL
       AND (to_agent = 'comms' OR to_agent = 'orchestrator')
     ORDER BY created_at ASC`,
  );

  let delivered = 0;
  let failed = 0;
  let expired = 0;

  if (undelivered.length === 0) return { delivered, failed, expired };

  // Group by target agent to send a single ping per agent
  const byAgent = new Map<string, Message[]>();
  for (const msg of undelivered) {
    const existing = byAgent.get(msg.to_agent) ?? [];
    existing.push(msg);
    byAgent.set(msg.to_agent, existing);
  }

  for (const [agentId, messages] of byAgent) {
    // Check retries and expire where needed
    const deliverable: Message[] = [];
    for (const msg of messages) {
      const retries = _retryCounts.get(msg.id) ?? 0;
      if (retries >= MAX_RETRIES) {
        expireMessage(msg, retries);
        expired++;
        log.warn('Message expired after max retries', { id: msg.id, to: agentId, retries });
        continue;
      }
      if (!liveSessions.has(agentId)) {
        const newCount = retries + 1;
        _retryCounts.set(msg.id, newCount);
        if (newCount >= MAX_RETRIES) {
          expireMessage(msg, newCount);
          expired++;
          log.warn('Message expired — target session does not exist', { id: msg.id, to: agentId, retries: newCount });
        } else {
          failed++;
        }
        continue;
      }
      deliverable.push(msg);
    }

    if (deliverable.length === 0) continue;

    // Inject a single notification ping for the batch
    const pingText = formatNotificationPing(deliverable[0]!);
    const success = injectMessage(agentId, pingText);

    if (success) {
      const now = new Date().toISOString();
      const nowMs = Date.now();
      for (const msg of deliverable) {
        exec('UPDATE messages SET processed_at = ? WHERE id = ?', now, msg.id);
        _retryCounts.delete(msg.id);
        _lastPingTime.set(msg.id, nowMs);
        delivered++;
      }
      log.debug('Notification ping sent', { to: agentId, count: deliverable.length });
    } else {
      for (const msg of deliverable) {
        const newCount = (_retryCounts.get(msg.id) ?? 0) + 1;
        _retryCounts.set(msg.id, newCount);
        failed++;
      }
      log.warn('Failed to inject notification ping', { to: agentId });
    }
  }

  return { delivered, failed, expired };
}

/**
 * Phase 2: Re-ping for unread messages (delivered but not yet read).
 * Sends a reminder notification every REPING_INTERVAL_MS.
 */
async function repingUnreadMessages(liveSessions: Set<string>): Promise<number> {
  const unread = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NOT NULL
       AND read_at IS NULL
       AND (to_agent = 'comms' OR to_agent = 'orchestrator')
     ORDER BY created_at ASC`,
  );

  if (unread.length === 0) return 0;

  const now = Date.now();
  let repinged = 0;

  // Group by agent
  const byAgent = new Map<string, Message[]>();
  for (const msg of unread) {
    // Check if we need to skip expired messages (metadata.expired = true)
    if (msg.metadata) {
      try {
        const meta = JSON.parse(msg.metadata);
        if (meta.expired) continue;
      } catch { /* ignore parse errors */ }
    }

    const lastPing = _lastPingTime.get(msg.id) ?? 0;
    if (now - lastPing < REPING_INTERVAL_MS) continue;

    const existing = byAgent.get(msg.to_agent) ?? [];
    existing.push(msg);
    byAgent.set(msg.to_agent, existing);
  }

  for (const [agentId, messages] of byAgent) {
    if (!liveSessions.has(agentId)) continue;
    if (messages.length === 0) continue;

    const pingText = formatNotificationPing(messages[0]!);
    const success = injectMessage(agentId, pingText);

    if (success) {
      for (const msg of messages) {
        _lastPingTime.set(msg.id, now);
      }
      repinged += messages.length;
      log.debug('Re-ping sent for unread messages', { to: agentId, count: messages.length });
    }
  }

  return repinged;
}

/**
 * Main delivery loop: deliver new messages, then re-ping unread ones.
 */
async function deliverMessages(): Promise<void> {
  _pendingWakeup = false;

  const liveSessions = getLiveSessions();

  // Phase 1: Deliver new messages (inject ping, mark processed)
  const { delivered, failed, expired } = await deliverNewMessages(liveSessions);

  // Phase 2: Re-ping unread messages
  const repinged = await repingUnreadMessages(liveSessions);

  if (delivered > 0 || failed > 0 || expired > 0 || repinged > 0) {
    log.info('Delivery cycle complete', { delivered, failed, expired, repinged });
  }
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
  _lastPingTime.clear();
}

/** @internal Get current retry count for testing */
export function _getRetryCount(messageId: number): number {
  return _retryCounts.get(messageId) ?? 0;
}

/** @internal Get last ping time for testing */
export function _getLastPingTime(messageId: number): number {
  return _lastPingTime.get(messageId) ?? 0;
}
