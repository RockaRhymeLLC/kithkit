/**
 * Inter-agent message router.
 *
 * Routes messages between agents via HTTP POST. Messages to persistent agents
 * (comms/orchestrator) are injected via tmux. Messages to workers are stored
 * for pull. All messages logged in SQLite messages table.
 *
 * Workers can only send result or error type messages.
 */

import { insert, query, exec } from '../core/db.js';
import { injectMessage } from './tmux.js';
import { notifyNewMessage, recordDirectInjection } from '../automation/tasks/message-delivery.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('message-router');

// ── Types ────────────────────────────────────────────────────

export type MessageType = 'text' | 'task' | 'result' | 'error' | 'status';

export interface Message {
  id: number;
  from_agent: string;
  to_agent: string;
  type: MessageType;
  body: string;
  metadata: string | null;
  processed_at: string | null;
  read_at: string | null;
  created_at: string;
}

export interface SendMessageRequest {
  from: string;
  to: string;
  type: MessageType;
  body: string;
  metadata?: Record<string, unknown>;
  direct?: boolean;
}

const VALID_MESSAGE_TYPES: MessageType[] = ['text', 'task', 'result', 'error', 'status'];
const WORKER_ALLOWED_TYPES: MessageType[] = ['result', 'error'];

// ── Deduplication ─────────────────────────────────────────────
// Prevent identical messages from being inserted within a short window.
// Keyed by "from:to:type:bodyPrefix", stores the message ID of the first insertion.
const DEDUP_WINDOW_MS = 5_000;
const _recentMessages = new Map<string, { messageId: number; timestamp: number }>();

function deduplicationKey(req: SendMessageRequest): string {
  return `${req.from}:${req.to}:${req.type}:${req.body.slice(0, 200)}`;
}

function cleanupStaleDedup(): void {
  const now = Date.now();
  for (const [key, entry] of _recentMessages) {
    if (now - entry.timestamp > DEDUP_WINDOW_MS) {
      _recentMessages.delete(key);
    }
  }
}

// ── Tmux injection (injectable for testing) ──────────────────

type TmuxInjector = (session: string, text: string) => boolean;

let tmuxInjector: TmuxInjector = defaultTmuxInjector;

function defaultTmuxInjector(agentId: string, text: string): boolean {
  return injectMessage(agentId, text);
}

// ── Public API ───────────────────────────────────────────────

/**
 * Send a message between agents. Logs to DB and routes to target.
 *
 * Always returns a result if the message was stored locally.
 * Relay/forwarding failures are non-fatal: the message is stored and a
 * `warning` field is included in the result instead of throwing.
 */
export function sendMessage(req: SendMessageRequest): { messageId: number; delivered: boolean; warning?: string } {
  // Validate type
  if (!VALID_MESSAGE_TYPES.includes(req.type)) {
    throw new MessageValidationError(`Invalid message type: ${req.type}`);
  }

  // Enforce worker restrictions
  if (isWorkerAgent(req.from) && !WORKER_ALLOWED_TYPES.includes(req.type)) {
    throw new WorkerRestrictionError(
      `Workers can only send result or error messages, got: ${req.type}`,
    );
  }

  // Deduplicate: if an identical message was sent within the last few seconds, return the original
  cleanupStaleDedup();
  const dedupKey = deduplicationKey(req);
  const existing = _recentMessages.get(dedupKey);
  if (existing && Date.now() - existing.timestamp < DEDUP_WINDOW_MS) {
    return { messageId: existing.messageId, delivered: true };
  }

  // Insert message into DB
  const message = insert<Message>('messages', {
    from_agent: req.from,
    to_agent: req.to,
    type: req.type,
    body: req.body,
    metadata: req.metadata ? JSON.stringify(req.metadata) : null,
  });

  // Record for deduplication
  _recentMessages.set(dedupKey, { messageId: message.id, timestamp: Date.now() });

  // Auto-complete orchestrator task when orchestrator sends a result message
  if (req.from === 'orchestrator' && req.type === 'result') {
    try {
      let taskId: string | undefined;

      // Prefer exact match via metadata.task_id if provided
      if (req.metadata?.task_id && typeof req.metadata.task_id === 'string') {
        const exact = query<{ id: string }>(
          `SELECT id FROM orchestrator_tasks
           WHERE id = ? AND status IN ('assigned', 'in_progress', 'pending')`,
          req.metadata.task_id,
        );
        if (exact.length > 0) taskId = exact[0]!.id;
      }

      // Fallback: prefer in_progress tasks (FIFO by creation order)
      if (!taskId) {
        const rows = query<{ id: string }>(
          `SELECT id FROM orchestrator_tasks
           WHERE status IN ('assigned', 'in_progress', 'pending')
           ORDER BY CASE status
             WHEN 'in_progress' THEN 0
             WHEN 'assigned' THEN 1
             WHEN 'pending' THEN 2
           END, created_at ASC LIMIT 1`,
        );
        if (rows.length > 0) taskId = rows[0]!.id;
      }

      if (taskId) {
        const now = new Date().toISOString();
        exec(
          `UPDATE orchestrator_tasks SET status = 'completed', result = ?, completed_at = ?, updated_at = ? WHERE id = ?`,
          req.body.slice(0, 5000), now, now, taskId,
        );
        log.info('Auto-completed orchestrator task on result message', { taskId });
      }
    } catch (err) {
      log.warn('Failed to auto-complete orchestrator task', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Route to target — non-fatal: message is already stored locally.
  // Relay/P2P forwarding errors are caught and returned as a warning.
  try {
    if (isPersistentAgent(req.to)) {
      // Direct channel: bypass scheduler and inject immediately.
      // Use body as-is — callers that set direct=true (agent-comms, sdk-bridge)
      // have already formatted the display text (e.g. "[Agent] R2d2: message").
      // Applying formatForTmux on top would double-wrap the prefix.
      if (req.direct) {
        const injected = tmuxInjector(req.to, req.body);
        if (injected) {
          // Mark as processed AND read — the full content was already displayed
          // in the tmux session, so no follow-up notification is needed.
          const now = new Date().toISOString();
          exec(
            'UPDATE messages SET processed_at = ?, read_at = ? WHERE id = ?',
            now, now, message.id,
          );
          // Tell the heartbeat dedup that comms was just notified, so it
          // doesn't fire a redundant "[heartbeat] N unread messages" nudge.
          recordDirectInjection(req.to);
          return { messageId: message.id, delivered: true };
        }
        // Injection failed (session not alive) — fall through to normal delivery
      }

      // Queue for delivery — the message-delivery scheduler task handles tmux injection.
      // Trigger the task immediately so delivery doesn't wait for the next interval tick.
      notifyNewMessage();
      return { messageId: message.id, delivered: false };
    }
    // Workers pull their own messages — no active delivery needed
    return { messageId: message.id, delivered: true };
  } catch (err) {
    // Forwarding/routing failed after local storage — non-fatal.
    // Log and return success with a warning so callers don't receive a 500.
    const warning = err instanceof Error ? err.message : String(err);
    log.warn('Message relay/forwarding failed (message stored locally)', {
      messageId: message.id,
      error: warning,
    });
    return { messageId: message.id, delivered: false, warning };
  }
}

/**
 * Get message history for an agent.
 */
export function getMessages(
  agentId: string,
  opts?: { limit?: number; type?: MessageType },
): Message[] {
  let sql = 'SELECT * FROM messages WHERE to_agent = ? OR from_agent = ?';
  const params: unknown[] = [agentId, agentId];

  if (opts?.type) {
    sql += ' AND type = ?';
    params.push(opts.type);
  }

  sql += ' ORDER BY created_at ASC';

  if (opts?.limit) {
    sql += ' LIMIT ?';
    params.push(opts.limit);
  }

  return query<Message>(sql, ...params);
}

/**
 * Get messages addressed TO an agent with ID greater than sinceId.
 * Used by the orchestrator wrapper to poll for new tasks without relying
 * on read/processed state (avoids race where Claude consumes messages
 * via the API before the wrapper's polling loop runs).
 */
export function getMessagesSince(agentId: string, sinceId: number, type?: MessageType): Message[] {
  let sql = 'SELECT * FROM messages WHERE to_agent = ? AND id > ?';
  const params: unknown[] = [agentId, sinceId];

  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }

  sql += ' ORDER BY id ASC';

  return query<Message>(sql, ...params);
}

/**
 * Get unprocessed messages for an agent (pull model).
 */
export function pullMessages(agentId: string): Message[] {
  return query<Message>(
    'SELECT * FROM messages WHERE to_agent = ? AND processed_at IS NULL ORDER BY created_at ASC',
    agentId,
  );
}

/**
 * Mark a message as processed.
 */
export function markProcessed(messageId: number): void {
  exec(
    'UPDATE messages SET processed_at = ? WHERE id = ?',
    new Date().toISOString(), messageId,
  );
}

/**
 * Get unread messages for an agent (read_at IS NULL, already delivered/processed).
 */
export function getUnreadMessages(agentId: string): Message[] {
  return query<Message>(
    `SELECT * FROM messages
     WHERE to_agent = ? AND read_at IS NULL AND processed_at IS NOT NULL
     ORDER BY created_at ASC`,
    agentId,
  );
}

/**
 * Mark messages as read. Sets read_at timestamp.
 */
export function markMessagesRead(messageIds: number[]): void {
  if (messageIds.length === 0) return;
  const now = new Date().toISOString();
  const placeholders = messageIds.map(() => '?').join(',');
  exec(
    `UPDATE messages SET read_at = ? WHERE id IN (${placeholders})`,
    now, ...messageIds,
  );
}

// ── Helpers ──────────────────────────────────────────────────

function isWorkerAgent(agentId: string): boolean {
  return agentId.startsWith('worker-') || agentId.match(/^[0-9a-f]{8}-/) !== null;
}

function isPersistentAgent(agentId: string): boolean {
  return agentId === 'comms' || agentId === 'orchestrator';
}

function formatForTmux(req: SendMessageRequest): string {
  return `[${req.type}] from ${req.from}: ${req.body}`;
}

// ── Errors ───────────────────────────────────────────────────

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessageValidationError';
  }
}

export class WorkerRestrictionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkerRestrictionError';
  }
}

// ── Testing ──────────────────────────────────────────────────

export function _setTmuxInjectorForTesting(fn: TmuxInjector | null): void {
  tmuxInjector = fn ?? defaultTmuxInjector;
}

export function _clearDedupForTesting(): void {
  _recentMessages.clear();
}
