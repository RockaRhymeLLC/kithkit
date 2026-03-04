/**
 * Message Delivery — content delivery for inter-agent messages.
 *
 * 1. Messages arrive via POST /api/messages → stored as undelivered (processed_at IS NULL)
 * 2. This task runs on a short interval, pulls undelivered messages for persistent agents
 * 3. Injects the FULL MESSAGE CONTENT into the target tmux session
 * 4. Marks as delivered AND read (processed_at + read_at set) on successful injection
 * 5. Expires undelivered messages after MAX_RETRIES failed injection attempts
 *
 * Because read_at is set on delivery, comms-heartbeat will not follow up —
 * the agent already has the content in their session.
 */

import { query, exec, update } from '../../core/db.js';
import { injectMessage, listSessions, _getCommsSession } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import type { Scheduler } from '../scheduler.js';
import type { Message } from '../../agents/message-router.js';

const log = createLogger('message-delivery');

// ── Config ───────────────────────────────────────────────

/** Max delivery attempts before marking a message as expired. */
const MAX_RETRIES = 3;

// ── State ────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;
let _pendingWakeup = false;

/**
 * In-memory retry counter for undelivered messages. Keyed by message ID.
 * Resets on daemon restart — acceptable because stale messages
 * from a previous daemon run will get a fresh 3 attempts.
 */
const _retryCounts = new Map<number, number>();

// ── Public API ───────────────────────────────────────────

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

// ── Core delivery logic ──────────────────────────────────

/**
 * Check which persistent-agent tmux sessions are currently alive.
 * Returns a set of agent IDs (e.g. 'comms', 'orchestrator') with live sessions.
 */
function getLiveSessions(): Set<string> {
  const live = new Set<string>();
  const sessions = listSessions();
  if (sessions.includes(_getCommsSession())) {
    live.add('comms');
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
 * Format the full message content for tmux injection.
 * Note: no timestamp here — injectMessage() prepends one automatically.
 */
function formatMessageContent(msg: Message): string {
  return `[${msg.type}] from ${msg.from_agent}: ${msg.body}`;
}

/**
 * Format a batch of messages for a single tmux injection.
 */
function formatBatchContent(messages: Message[]): string {
  return messages.map(formatMessageContent).join('\n');
}

/**
 * Phase 1: Deliver undelivered messages (inject content, mark processed + read).
 *
 * Only targets comms — orchestrator sessions are excluded because the
 * wrapper's poll loop handles message retrieval between Claude runs.
 * Injecting into orch* sessions disrupts Claude's input stream (issue #135).
 */
async function deliverNewMessages(liveSessions: Set<string>): Promise<{ delivered: number; failed: number; expired: number }> {
  const undelivered = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NULL
       AND to_agent = 'comms'
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

    // Inject the full message content into the tmux session
    const contentText = formatBatchContent(deliverable);
    const success = injectMessage(agentId, contentText);

    if (success) {
      const now = new Date().toISOString();
      for (const msg of deliverable) {
        const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
        const updatedMeta = JSON.stringify({ ...existingMeta, last_notified_at: now });
        // Set both processed_at AND read_at — the agent already has the content
        // in their session, so no follow-up notification is needed.
        exec('UPDATE messages SET processed_at = ?, read_at = ?, metadata = ? WHERE id = ?', now, now, updatedMeta, msg.id);
        _retryCounts.delete(msg.id);
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
      log.debug('Message content delivered', { to: agentId, count: deliverable.length });
    } else {
      for (const msg of deliverable) {
        const newCount = (_retryCounts.get(msg.id) ?? 0) + 1;
        _retryCounts.set(msg.id, newCount);
        failed++;
      }
      log.warn('Failed to inject message content', { to: agentId });
    }
  }

  return { delivered, failed, expired };
}

// ── Phase 2: Worker completion notifications ─────────────

interface CompletedJobRow {
  id: string;
  profile: string;
  status: 'completed' | 'failed' | 'timeout';
  error: string | null;
  spawned_by: string;
}

/**
 * Phase 2: Notify spawning agents of worker completion/failure.
 * Injects a one-line notification into the spawner's tmux session.
 * Only targets comms — orchestrator uses its own polling (see Phase 1 comment).
 * Marks spawner_notified_at whether or not the session is live to avoid retries.
 */
async function notifyWorkerCompletions(liveSessions: Set<string>): Promise<number> {
  const completedJobs = query<CompletedJobRow>(
    `SELECT id, profile, status, error, spawned_by
     FROM worker_jobs
     WHERE status IN ('completed', 'failed', 'timeout')
       AND spawned_by IS NOT NULL
       AND spawner_notified_at IS NULL
       AND spawned_by = 'comms'
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
 * Main delivery loop: deliver new messages, then notify worker completions.
 */
async function deliverMessages(): Promise<void> {
  _pendingWakeup = false;

  const liveSessions = getLiveSessions();

  // Phase 1: Deliver new messages (inject content, mark processed + read)
  const { delivered, failed, expired } = await deliverNewMessages(liveSessions);

  // Phase 2: Notify spawning agents of worker completions
  const workerNotified = await notifyWorkerCompletions(liveSessions);

  if (delivered > 0 || failed > 0 || expired > 0 || workerNotified > 0) {
    log.info('Delivery cycle complete', { delivered, failed, expired, workerNotified });
  }
}

// ── Registration ─────────────────────────────────────────

/**
 * Register the message-delivery task with the scheduler.
 */
export function register(scheduler: Scheduler): void {
  _scheduler = scheduler;
  scheduler.registerHandler('message-delivery', async () => {
    await deliverMessages();
  });
}

// ── Testing ──────────────────────────────────────────────

/** @internal Reset retry state for testing */
export function _resetRetriesForTesting(): void {
  _retryCounts.clear();
}

/** @internal Get current retry count for testing */
export function _getRetryCount(messageId: number): number {
  return _retryCounts.get(messageId) ?? 0;
}
