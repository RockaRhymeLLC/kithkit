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
import { injectMessage, listSessions, getOrchestratorState, _getCommsSession, _getOrchestratorSession } from '../../agents/tmux.js';
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

/**
 * Per-message retry counter for absent-session expiry.
 * Used only for the orchestrator path — when the orch session is absent/dead,
 * messages are retried up to MAX_RETRIES times before being expired. Deferred
 * messages (orch busy/active) do NOT consume this budget.
 * Age-based TTL (see getTtlHours) provides a parallel cleanup for long-lived messages.
 */
const _retryCounts = new Map<number, number>();
const MAX_RETRIES = 3;

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

// ── Injectable deps (overridable for testing) ────────────────

type ListSessionsFn = () => string[];
type InjectMessageFn = (agentId: string, text: string) => boolean;
type GetOrchStateFn = () => 'active' | 'waiting' | 'dead';

let _listSessionsImpl: ListSessionsFn = listSessions;
let _injectMessageImpl: InjectMessageFn = injectMessage;
let _getOrchStateImpl: GetOrchStateFn = getOrchestratorState;

interface SessionSets {
  /** Sessions that are alive and idle — safe to inject into right now. */
  live: Set<string>;
  /**
   * Sessions that exist but whose agent is busy (e.g., orchestrator mid-run).
   * Messages for these agents are deferred without consuming the retry budget.
   */
  deferred: Set<string>;
}

/**
 * Check which persistent-agent tmux sessions are currently alive.
 * Returns live (safe to inject) and deferred (busy — defer without retry) sets.
 */
function getLiveSessions(): SessionSets {
  const live = new Set<string>();
  const deferred = new Set<string>();
  const sessions = _listSessionsImpl();
  if (sessions.includes(_getCommsSession())) {
    live.add('comms');
  }
  if (sessions.includes(_getOrchestratorSession())) {
    // Guard (issue #135): only inject into the orchestrator when it is idle at the
    // input prompt (state === 'waiting'). If the orchestrator is mid-run
    // (state === 'active'), messages are deferred — queued without consuming the
    // retry budget — and will deliver as soon as the orch returns to 'waiting'.
    // If the session is dead/absent (state === 'dead'), neither live nor deferred
    // is set, so the normal retry/expire path applies.
    const state = _getOrchStateImpl();
    if (state === 'waiting') {
      live.add('orchestrator');
    } else if (state === 'active') {
      deferred.add('orchestrator');
    }
    // state === 'dead': treat as absent — neither live nor deferred
  }
  return { live, deferred };
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
 * Targets both comms and orchestrator sessions. Orchestrator injection is guarded
 * by getOrchestratorState() — injection only occurs when state === 'waiting' (orch
 * is idle at the input prompt). If state === 'active' (orch is mid-run), messages
 * are deferred (queued) without consuming the retry budget, and will deliver as
 * soon as the orch returns to 'waiting'. Only a truly absent/dead orch session
 * (state === 'dead' or session not found) consumes the retry budget and may
 * eventually expire after MAX_RETRIES (issue #135).
 *
 * Age-based TTL (Shape B, #620): messages older than ttl_hours are also expired
 * before delivery is attempted. Expiry uses created_at (persisted in DB), so the
 * clock survives daemon restarts — no in-memory counter needed.
 */
async function deliverNewMessages(liveSessions: Set<string>, deferredSessions: Set<string>): Promise<{ delivered: number; failed: number; expired: number; deferred: number }> {
  let delivered = 0;
  let failed = 0;
  let expired = 0;
  let deferred = 0;

  const ttlHours = getTtlHours();

  // ── TTL pre-pass: expire messages that have aged past the TTL ──────────────
  // Created_at is the persistent clock — daemon restarts do not reset expiry.
  // Uses unixepoch() for comparison so it handles both DB-default format
  // ('YYYY-MM-DD HH:MM:SS') and ISO 8601 ('YYYY-MM-DDTHH:MM:SS.sssZ') values.
  const ttlExpired = query<Message>(
    `SELECT * FROM messages
     WHERE processed_at IS NULL
       AND to_agent IN ('comms', 'orchestrator')
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
       AND to_agent IN ('comms', 'orchestrator')
     ORDER BY created_at ASC`,
  );

  if (undelivered.length === 0) return { delivered, failed, expired, deferred };

  // Group by target agent to send a single ping per agent
  const byAgent = new Map<string, Message[]>();
  for (const msg of undelivered) {
    const existing = byAgent.get(msg.to_agent) ?? [];
    existing.push(msg);
    byAgent.set(msg.to_agent, existing);
  }

  for (const [agentId, messages] of byAgent) {
    const deliverable: Message[] = [];
    for (const msg of messages) {
      if (!liveSessions.has(agentId)) {
        if (deferredSessions.has(agentId)) {
          // Agent session exists but is busy (e.g., orch mid-run) — defer without
          // consuming the retry budget. Message stays pending until next tick.
          deferred++;
          log.debug('Message deferred — target agent is busy', { id: msg.id, to: agentId });
          continue;
        }
        // Agent session is absent/dead — consume retry budget.
        const retries = _retryCounts.get(msg.id) ?? 0;
        const newCount = retries + 1;
        _retryCounts.set(msg.id, newCount);
        if (newCount >= MAX_RETRIES) {
          expireMessage(msg, 'max_retries_exceeded');
          expired++;
          log.warn('Message expired — target session absent after max retries', { id: msg.id, to: agentId, retries: newCount });
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
    const success = _injectMessageImpl(agentId, contentText);

    if (success) {
      const now = new Date().toISOString();
      const nowMs = Date.now();
      for (const msg of deliverable) {
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
      log.debug('Message content delivered', { to: agentId, count: deliverable.length });
    } else {
      failed += deliverable.length;
      log.warn('Failed to inject message content', { to: agentId });
    }
  }

  return { delivered, failed, expired, deferred };
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
      _injectMessageImpl(spawner, pingText);
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

  const { live: liveSessions, deferred: deferredSessions } = getLiveSessions();

  // Phase 1: Deliver new messages (inject content, mark processed + read)
  const { delivered, failed, expired, deferred } = await deliverNewMessages(liveSessions, deferredSessions);

  // Phase 2: Notify spawning agents of worker completions
  const workerNotified = await notifyWorkerCompletions(liveSessions);

  if (delivered > 0 || failed > 0 || expired > 0 || deferred > 0 || workerNotified > 0) {
    log.info('Delivery cycle complete', { delivered, failed, expired, deferred, workerNotified });
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
 */
export function _resetRetriesForTesting(): void {
  _lastAgentNotificationTime.clear();
  _retryCounts.clear();
}

/**
 * @internal Return the current retry count for a message id (for test assertions).
 */
export function _getRetryCount(messageId: number): number {
  return _retryCounts.get(messageId) ?? 0;
}

/**
 * @internal Thin wrapper around deliverNewMessages() for test harness access.
 * Allows tests to drive the delivery cycle directly with an injected liveSessions set,
 * without requiring the scheduler or a live tmux environment.
 */
export async function _deliverNewMessagesForTesting(opts: {
  liveSessions: Set<string>;
  deferredSessions?: Set<string>;
}): Promise<{ delivered: number; failed: number; expired: number; deferred: number }> {
  return deliverNewMessages(opts.liveSessions, opts.deferredSessions ?? new Set());
}

/** @internal Override listSessions, injectMessage, and orchState for unit tests. Pass null to restore. */
export function _setDeliveryDepsForTesting(
  opts: { listSessions?: ListSessionsFn | null; injectMessage?: InjectMessageFn | null; orchState?: GetOrchStateFn | null } | null,
): void {
  _listSessionsImpl = opts?.listSessions ?? listSessions;
  _injectMessageImpl = opts?.injectMessage ?? injectMessage;
  _getOrchStateImpl = opts?.orchState ?? getOrchestratorState;
}

/** @internal Directly invoke the delivery loop (bypasses scheduler) for unit tests. */
export async function _deliverMessagesForTesting(): Promise<void> {
  return deliverMessages();
}
