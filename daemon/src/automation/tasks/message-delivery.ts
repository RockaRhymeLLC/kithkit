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

import { query, exec, update } from '../../core/db.js';
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
 * Also persisted in DB metadata.last_notified_at so it survives daemon restarts.
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
 * Note: no timestamp here — injectMessage() prepends one automatically.
 */
function formatNotificationPing(msg: Message): string {
  const count = getUnreadCountFor(msg.to_agent);
  if (count > 1) {
    return `You have ${count} unread messages — use GET /api/messages?unread=true to read`;
  }
  return `You have a message from ${msg.from_agent} — use GET /api/messages?unread=true to read`;
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
        const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
        const updatedMeta = JSON.stringify({ ...existingMeta, last_notified_at: now });
        exec('UPDATE messages SET processed_at = ?, metadata = ? WHERE id = ?', now, updatedMeta, msg.id);
        _retryCounts.delete(msg.id);
        _lastPingTime.set(msg.id, nowMs);
        delivered++;
      }
      // If we just delivered to the orchestrator, touch last_activity so the
      // idle checker knows it received work and resets its idle clock.
      if (agentId === 'orchestrator') {
        update('agents', 'orchestrator', {
          last_activity: now,
          updated_at: now,
        });
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
  const nowIso = new Date().toISOString();
  let repinged = 0;

  // Group by agent — only messages that are due for a re-ping
  const byAgent = new Map<string, Message[]>();
  for (const msg of unread) {
    // Check if we need to skip expired messages (metadata.expired = true)
    let meta: Record<string, unknown> = {};
    if (msg.metadata) {
      try {
        meta = JSON.parse(msg.metadata);
        if (meta.expired) continue;
      } catch { /* ignore parse errors */ }
    }

    // Use in-memory lastPingTime if available, otherwise hydrate from DB metadata
    let lastPing = _lastPingTime.get(msg.id);
    if (lastPing === undefined && meta.last_notified_at) {
      lastPing = new Date(meta.last_notified_at as string).getTime();
      _lastPingTime.set(msg.id, lastPing);
    }
    if (lastPing !== undefined && now - lastPing < REPING_INTERVAL_MS) continue;

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
        // Persist last_notified_at in DB metadata so it survives daemon restarts
        const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
        const updatedMeta = JSON.stringify({ ...existingMeta, last_notified_at: nowIso });
        exec('UPDATE messages SET metadata = ? WHERE id = ?', updatedMeta, msg.id);
      }
      repinged += messages.length;
      log.debug('Re-ping sent for unread messages', { to: agentId, count: messages.length });
    }
  }

  return repinged;
}

// ── Phase 3: Worker completion notifications ─────────────────

interface CompletedJobRow {
  id: string;
  profile: string;
  status: 'completed' | 'failed' | 'timeout';
  error: string | null;
  spawned_by: string;
}

/**
 * Phase 3: Notify spawning agents of worker completion/failure.
 * Injects a one-line notification into the spawner's tmux session.
 * Marks spawner_notified_at whether or not the session is live to avoid retries.
 */
async function notifyWorkerCompletions(liveSessions: Set<string>): Promise<number> {
  const completedJobs = query<CompletedJobRow>(
    `SELECT id, profile, status, error, spawned_by
     FROM worker_jobs
     WHERE status IN ('completed', 'failed', 'timeout')
       AND spawned_by IS NOT NULL
       AND spawner_notified_at IS NULL
       AND spawned_by IN ('comms', 'orchestrator')
     ORDER BY finished_at ASC
     LIMIT 50`,
  );

  if (completedJobs.length === 0) return 0;

  const now = new Date().toISOString();
  let notified = 0;

  for (const job of completedJobs) {
    const spawner = job.spawned_by;

    let pingText: string;
    if (job.status === 'completed') {
      pingText = `[worker ${job.profile} completed]`;
    } else {
      const reason = job.error ? `: ${job.error.slice(0, 80)}` : '';
      pingText = `[worker ${job.profile} ${job.status}${reason}]`;
    }

    if (liveSessions.has(spawner)) {
      injectMessage(spawner, pingText);
    }

    exec('UPDATE worker_jobs SET spawner_notified_at = ? WHERE id = ?', now, job.id);
    notified++;
    log.debug('Worker completion notified', { jobId: job.id, spawner, status: job.status });
  }

  return notified;
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

  // Phase 3: Notify spawning agents of worker completions
  const workerNotified = await notifyWorkerCompletions(liveSessions);

  if (delivered > 0 || failed > 0 || expired > 0 || repinged > 0 || workerNotified > 0) {
    log.info('Delivery cycle complete', { delivered, failed, expired, repinged, workerNotified });
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
