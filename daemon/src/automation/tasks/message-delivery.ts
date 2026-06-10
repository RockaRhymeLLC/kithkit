/**
 * Message Delivery — deliver-once content delivery for inter-agent messages.
 *
 * 1. Messages arrive via POST /api/messages → stored as undelivered (processed_at IS NULL)
 * 2. This task runs on a short interval, pulls undelivered messages for persistent agents
 * 3. Injects the FULL MESSAGE CONTENT into the target tmux session
 * 4. Marks as delivered (processed_at + read_at + notified_at set) — no re-pinging
 * 5. Expires undelivered messages after TTL hours using created_at (age-based, restart-resilient)
 *
 * Deliver-once: each message is notified exactly once. No re-ping phase.
 */

import { query, exec, update } from '../../core/db.js';
import { injectMessage, listSessions, _getCommsSession } from '../../agents/tmux.js';
import { createLogger } from '../../core/logger.js';
import { loadConfig } from '../../core/config.js';
import type { Scheduler } from '../scheduler.js';
import type { Message } from '../../agents/message-router.js';

const log = createLogger('message-delivery');

// ── State ────────────────────────────────────────────────────

let _scheduler: Scheduler | null = null;
let _pendingWakeup = false;

/**
 * Tracks the last time we successfully injected a notification ping into
 * each persistent agent's tmux session. Used by comms-heartbeat to avoid
 * duplicate nudges — if message-delivery already notified comms recently,
 * the heartbeat skips the unread-message portion of its nudge.
 */
const _lastAgentNotificationTime = new Map<string, number>();

// ── Config helpers ───────────────────────────────────────────

/**
 * Read the message-delivery TTL from the scheduler task config.
 * Defaults to 24 hours if not configured. Config key: scheduler.tasks[message-delivery].config.ttl_hours
 */
function getTtlHours(): number {
  const tasks = loadConfig().scheduler?.tasks ?? [];
  const taskCfg = tasks.find(t => t.name === 'message-delivery');
  return (taskCfg?.config?.ttl_hours as number | undefined) ?? 24;
}

// ── Public API ───────────────────────────────────────────────

/**
 * Returns the last time a notification ping was successfully injected into
 * the given agent's tmux session (epoch ms), or 0 if never.
 * Used by comms-heartbeat to suppress duplicate unread-message nudges.
 */
export function getLastNotificationTime(agentId: string): number {
  return _lastAgentNotificationTime.get(agentId) ?? 0;
}

/**
 * Record that a message was successfully injected into an agent's tmux session.
 * Called by the direct injection path in message-router so the heartbeat's
 * dedup window respects direct injections (not just message-delivery ones).
 */
export function recordDirectInjection(agentId: string): void {
  _lastAgentNotificationTime.set(agentId, Date.now());
}

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
  if (sessions.includes(_getCommsSession())) {
    live.add('comms');
  }
  return live;
}

/**
 * Mark a message as expired (undeliverable). Sets processed_at with
 * metadata indicating it was not successfully delivered.
 *
 * Emits log.error (dead-letter observable, Shape A of #620) and sets
 * dead_letter:true in metadata so API consumers and ops tooling can detect drops.
 */
function expireMessage(msg: Message, reason: string): void {
  const now = new Date().toISOString();
  const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
  const expiredMeta = JSON.stringify({
    ...existingMeta,
    expired: true,
    dead_letter: true,
    reason,
    expired_at: now,
  });
  exec(
    'UPDATE messages SET processed_at = ?, metadata = ? WHERE id = ?',
    now,
    expiredMeta,
    msg.id,
  );
  log.error('DEAD-LETTER: message expired — TTL exceeded', {
    id: msg.id,
    from: msg.from_agent,
    to: msg.to_agent,
    reason,
    created_at: msg.created_at,
  });
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
 *
 * Age-based TTL (Shape B, #620): messages older than ttl_hours are expired before
 * delivery is attempted. Expiry uses created_at (persisted in DB), so the clock
 * survives daemon restarts — no in-memory counter needed.
 */
async function deliverNewMessages(liveSessions: Set<string>): Promise<{ delivered: number; failed: number; expired: number }> {
  let delivered = 0;
  let failed = 0;
  let expired = 0;

  const ttlHours = getTtlHours();

  // ── TTL pre-pass: expire messages that have aged past the TTL ──────────────
  // Created_at is the persistent clock — daemon restarts do not reset expiry.
  // Uses unixepoch() for comparison so it handles both DB-default format
  // ('YYYY-MM-DD HH:MM:SS') and ISO 8601 ('YYYY-MM-DDTHH:MM:SS.sssZ') values.
  // Filter strictly to to_agent='comms' (OQ4: orch-delivery gap deferred to its own PR).
  const ttlExpired = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NULL
       AND to_agent = 'comms'
       AND unixepoch(created_at) < unixepoch('now') - (? * 3600)
     ORDER BY created_at ASC`,
    ttlHours,
  );

  for (const msg of ttlExpired) {
    expireMessage(msg, 'ttl_exceeded');
    expired++;
  }

  // ── Delivery pass: deliver remaining (non-expired) messages ────────────────
  const undelivered = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NULL
       AND to_agent = 'comms'
     ORDER BY created_at ASC`,
  );

  if (undelivered.length === 0) return { delivered, failed, expired };

  // Group by target agent to send a single ping per agent
  const byAgent = new Map<string, Message[]>();
  for (const msg of undelivered) {
    const existing = byAgent.get(msg.to_agent) ?? [];
    existing.push(msg);
    byAgent.set(msg.to_agent, existing);
  }

  for (const [agentId, messages] of byAgent) {
    if (!liveSessions.has(agentId)) {
      // Session is absent — messages remain pending; will be delivered when
      // session returns (heartbeat flush) or expired by TTL pre-pass next cycle.
      failed += messages.length;
      continue;
    }

    // Inject the full message content into the tmux session
    const contentText = formatBatchContent(messages);
    const success = injectMessage(agentId, contentText);

    if (success) {
      const now = new Date().toISOString();
      const nowMs = Date.now();
      for (const msg of messages) {
        const existingMeta = msg.metadata ? JSON.parse(msg.metadata) : {};
        const updatedMeta = JSON.stringify({ ...existingMeta, last_notified_at: now });
        // Set both processed_at AND read_at — the agent already has the content
        // in their session, so no follow-up notification is needed.
        exec('UPDATE messages SET processed_at = ?, read_at = ?, notified_at = ?, metadata = ? WHERE id = ?', now, now, now, updatedMeta, msg.id);
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
      _lastAgentNotificationTime.set(agentId, nowMs);
      log.debug('Message content delivered', { to: agentId, count: messages.length });
    } else {
      failed += messages.length;
      log.warn('Failed to inject message content', { to: agentId });
    }
  }

  return { delivered, failed, expired };
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
 * Main delivery loop: deliver new messages, then re-ping unread ones.
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

/**
 * @internal Reset delivery state for testing.
 * The in-memory _retryCounts map was removed in #620 (age-based TTL makes it
 * obsolete — created_at in DB is the persistent timer). This function now only
 * clears the notification time map.
 */
export function _resetRetriesForTesting(): void {
  _lastAgentNotificationTime.clear();
}

/**
 * @internal Thin wrapper around deliverNewMessages() for test harness access.
 * Allows tests to drive the delivery cycle directly with an injected liveSessions set,
 * without requiring the scheduler or a live tmux environment.
 */
export async function _deliverNewMessagesForTesting(opts: {
  liveSessions: Set<string>;
}): Promise<{ delivered: number; failed: number; expired: number }> {
  return deliverNewMessages(opts.liveSessions);
}
